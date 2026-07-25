import { encodePowResponse, solvePoW } from "./pow.js";
import {
  buildCookieHeader,
  buildHeaders,
  createChatSession,
  deleteChatSession,
} from "./session.js";
import { DeepSeekSSEParser } from "./sse.js";
import type {
  DeepSeekCredentials,
  DeepSeekSession,
  OpenAIChatChunk,
  OpenAIChatRequest,
  OpenAIMessage,
  PoWChallenge,
} from "./types.js";

const BASE_URL = "https://chat.deepseek.com";

function modelToType(model: string): { model_type: string; thinking: boolean; search: boolean } {
  const lower = model.toLowerCase();
  if (lower.includes("search")) {
    return { model_type: "default", thinking: true, search: true };
  }
  return { model_type: "default", thinking: true, search: false };
}

function extractContent(content: string | { type: string; text?: string }[] | null): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

function cleanMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  const cleaned: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      if (!m.content) continue;
      const { tool_calls: _, ...rest } = m;
      cleaned.push(rest as OpenAIMessage);
      continue;
    }
    const { tool_calls: _, ...rest } = m;
    cleaned.push(rest as OpenAIMessage);
  }
  const deduped: OpenAIMessage[] = [];
  for (const m of cleaned) {
    if (deduped.length > 0 && deduped[deduped.length - 1].role === m.role) continue;
    deduped.push(m);
  }
  return deduped;
}

const NO_TOOLS_NOTE =
  "\n\nNote: You cannot run commands, read files, or use any tools. Never describe what actions you would take. Answer the user's question directly using only the conversation above.";

function flattenMessages(messages: OpenAIMessage[]): string {
  const cleaned = cleanMessages(messages);
  return (
    cleaned
      .map((m) => {
        const text = extractContent(m.content);
        if (m.role === "system") return text;
        if (m.role === "user") return `User: ${text}`;
        if (m.role === "assistant") return `Assistant: ${text}`;
        return text;
      })
      .join("\n\n") + NO_TOOLS_NOTE
  );
}

export function createDeepSeekTransport(credentials: DeepSeekCredentials) {
  return {
    baseURL: "https://deepseek-oauth.local/v1",
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/v1/models" || path === "/models") {
        return handleModels();
      }

      if (path === "/v1/chat/completions" || path === "/chat/completions") {
        const body = JSON.parse(await request.text()) as OpenAIChatRequest;
        const raw = body as unknown as Record<string, unknown>;
        raw.tools = undefined;
        raw.tool_choice = undefined;
        return handleChatCompletions(body, credentials);
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}

async function handleModels(): Promise<Response> {
  const models = [
    {
      id: "deepseek-flash",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "deepseek",
    },
    {
      id: "deepseek-reasoner",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "deepseek",
    },
  ];

  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleChatCompletions(
  body: OpenAIChatRequest,
  credentials: DeepSeekCredentials,
): Promise<Response> {
  const session = await credentials.getSession();
  const { model_type, thinking, search } = modelToType(body.model);
  const prompt = flattenMessages(body.messages);
  const isStream = body.stream !== false;

  const chatSession = await createChatSession(session);
  const chatSessionId = chatSession.id;

  try {
    const challenge = await requestPoWChallenge(session);
    const powResponse = solvePoW(challenge);
    const powEncoded = encodePowResponse(powResponse);

    const completionBody = {
      chat_session_id: chatSessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinking,
      search_enabled: search,
      action: null,
      preempt: false,
      model_type,
    };

    const headers = buildHeaders(session);
    headers.cookie = buildCookieHeader(session.cookies);
    headers["x-ds-pow-response"] = powEncoded;

    const response = await fetch(`${BASE_URL}/api/v0/chat/completion`, {
      method: "POST",
      headers,
      body: JSON.stringify(completionBody),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DeepSeek completion failed: ${response.status} ${text}`);
    }

    if (!response.body) {
      throw new Error("No response body from DeepSeek");
    }

    if (isStream) {
      return handleStreamingResponse(response, body.model);
    }
    return handleNonStreamingResponse(response, body.model);
  } finally {
    await deleteChatSession(session, chatSessionId).catch(() => {});
  }
}

async function requestPoWChallenge(session: DeepSeekSession): Promise<PoWChallenge> {
  const headers = buildHeaders(session);
  headers.cookie = buildCookieHeader(session.cookies, session.accessToken);

  const response = await fetch(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
    method: "POST",
    headers,
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PoW challenge request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    code: number;
    data: { biz_data: { challenge: PoWChallenge } };
  };

  if (data.code !== 0) {
    throw new Error(`PoW challenge failed: code ${data.code}`);
  }

  return data.data.biz_data.challenge;
}

const DEBUG = !!process.env.DEBUG_DEEPSEEK;

function debug(...args: unknown[]) {
  if (DEBUG) console.error("[deepseek-oauth]", ...args);
}

async function handleStreamingResponse(
  deepseekResponse: Response,
  model: string,
): Promise<Response> {
  if (!deepseekResponse.body) {
    throw new Error("No response body from DeepSeek");
  }
  const reader = deepseekResponse.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  debug("stream start, id:", id);

  const stream = new ReadableStream({
    async start(controller) {
      let streamStarted = false;
      let streamFinished = false;
      let totalBytes = 0;
      let contentBuffer = "";
      let lastFlushTime = Date.now();

      const closeStream = () => {
        if (!streamStarted) {
          streamStarted = true;
          const chunk: OpenAIChatChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        const final: OpenAIChatChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      const parser = new DeepSeekSSEParser((content, reasoning, done) => {
        if (!streamStarted) {
          streamStarted = true;
          const chunk: OpenAIChatChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }

        contentBuffer += content;

        const shouldFlush =
          done ||
          contentBuffer.length > 20 ||
          (Date.now() - lastFlushTime > 50 && contentBuffer.length > 0);
        if (shouldFlush) {
          if (contentBuffer) {
            const chunk: OpenAIChatChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: contentBuffer }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            contentBuffer = "";
            lastFlushTime = Date.now();
          }
        }

        if (done) {
          streamFinished = true;
          debug("stream done by parser, id:", id);
          closeStream();
        }
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        debug("reader exhausted, total bytes:", totalBytes, "id:", id);
        parser.feed("");
      } catch (e) {
        debug("stream error:", e, "id:", id);
      }

      if (!streamFinished) {
        debug("stream fallback close, id:", id);
        closeStream();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

async function handleNonStreamingResponse(
  deepseekResponse: Response,
  model: string,
): Promise<Response> {
  if (!deepseekResponse.body) {
    throw new Error("No response body from DeepSeek");
  }
  const reader = deepseekResponse.body.getReader();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  let fullContent = "";

  const parser = new DeepSeekSSEParser((content, _reasoning) => {
    if (content) fullContent += content;
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }

  const responseBody = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullContent,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return new Response(JSON.stringify(responseBody), {
    headers: { "content-type": "application/json" },
  });
}
