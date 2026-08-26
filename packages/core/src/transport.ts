import { encodePowResponse, solvePoWAsync } from "./pow.js";
import { buildCookieHeader, buildHeaders, createChatSession } from "./session.js";
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

interface ModelConfig {
  model_type: string;
  defaultThinking: boolean;
  defaultSearch: boolean;
}

const MODEL_MAP: Record<string, ModelConfig> = {
  "deepseek-chat": { model_type: "default", defaultThinking: false, defaultSearch: true },
  "deepseek-instant": { model_type: "default", defaultThinking: false, defaultSearch: true },
  "deepseek-v3": { model_type: "default", defaultThinking: false, defaultSearch: true },
  "deepseek-reasoner": { model_type: "expert", defaultThinking: true, defaultSearch: true },
  "deepseek-expert": { model_type: "expert", defaultThinking: true, defaultSearch: true },
  "deepseek-r1": { model_type: "expert", defaultThinking: true, defaultSearch: true },
  "deepseek-vision": { model_type: "vision", defaultThinking: false, defaultSearch: true },
};

function resolveModel(model: string): ModelConfig {
  return MODEL_MAP[model] ?? MODEL_MAP["deepseek-chat"];
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
    if (m.role === "tool") {
      cleaned.push({ role: "user", content: `[Tool Result]:\n${extractContent(m.content)}` });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const callsText = m.tool_calls.map((c: any) => `[Tool Call]: ${c.function.name}(${c.function.arguments})`).join("\n");
      const text = extractContent(m.content);
      const combined = text ? `${text}\n${callsText}` : callsText;
      cleaned.push({ role: "assistant", content: combined });
      continue;
    }
    const { tool_calls: _, ...rest } = m;
    cleaned.push(rest as OpenAIMessage);
  }
  const deduped: OpenAIMessage[] = [];
  for (const m of cleaned) {
    if (deduped.length > 0 && deduped[deduped.length - 1].role === m.role) {
      const prev = deduped[deduped.length - 1];
      const prevText = extractContent(prev.content);
      const curText = extractContent(m.content);
      if (curText) {
        prev.content = prevText ? `${prevText}\n\n${curText}` : curText;
      }
    } else {
      deduped.push(m);
    }
  }
  return deduped;
}

function flattenMessages(messages: OpenAIMessage[]): string {
  const cleaned = cleanMessages(messages);
  return cleaned
    .map((m) => {
      const text = extractContent(m.content);
      if (m.role === "system") return `[System Instruction]:\n${text}`;
      if (m.role === "user") return text; // DeepSeek handles user/assistant natively
      if (m.role === "assistant") return text;
      return text;
    })
    .join("\n\n");
}

function lastUserMessage(messages: OpenAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return extractContent(messages[i].content);
    }
  }
  return "";
}

export function createDeepSeekTransport(credentials: DeepSeekCredentials) {
  const messageIds = new Map<string, number>();

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
        const existingSessionId = request.headers.get("x-deepseek-chat-session-id");
        return handleChatCompletions(body, credentials, existingSessionId, messageIds, request.signal);
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}

async function handleModels(): Promise<Response> {
  const ids = Object.keys(MODEL_MAP);
  const data = ids.map((id) => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "deepseek",
  }));

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleChatCompletions(
  body: OpenAIChatRequest,
  credentials: DeepSeekCredentials,
  existingSessionId?: string | null,
  messageIds?: Map<string, number>,
  signal?: AbortSignal,
): Promise<Response> {
  const session = await credentials.getSession();
  const config = resolveModel(body.model);

  if (body.tools && body.tools.length > 0) {
    // Disable DeepSeek's own web search so it doesn't answer from memory instead of using tools
    const raw2 = body as unknown as Record<string, unknown>;
    raw2.search = false;

    const toolDefs = body.tools.map((t: any) => {
      const fn = t.function || t;
      return `- ${fn.name}: ${fn.description || "no description"}\n  Parameters: ${JSON.stringify(fn.parameters || {})}`;
    }).join("\n");

    const instructions = `[SYSTEM CRITICAL - AGENT PROTOCOL]
You are an autonomous agent with tools. You CANNOT answer from memory. You MUST use tools.

AVAILABLE TOOLS:
${toolDefs}

STRICT OUTPUT FORMAT RULES:
1. To use a tool, you MUST output ONLY the following exact string format:
<tool_call>{"name": "TOOL_NAME", "arguments": {"PARAM": "VALUE"}}</tool_call>

2. PROHIBITED FORMATS (DO NOT USE THESE):
- DO NOT use <function=...>
- DO NOT use <use_mcp_tool>
- DO NOT use Action: / Action Input:
- DO NOT use markdown \`\`\`json blocks

3. You must output the <tool_call> block immediately. NO PREAMBLE TEXT. NO "Let me check".`;

    if (body.messages.length > 0 && body.messages[0].role === "system") {
      let sysPrompt = body.messages[0].content;

      // 1. Strip Hermes / Anthropic MCP XML instructions
      sysPrompt = sysPrompt.replace(/<use_mcp_tool>[\s\S]*?<\/use_mcp_tool>/g, "");
      sysPrompt = sysPrompt.replace(/In this environment you have access to a set of tools[\s\S]*?(?=\n\n|$)/i, "");
      sysPrompt = sysPrompt.replace(/You can use one tool per message[\s\S]*?(?=\n\n|$)/i, "");

      // 2. Strip standard LangChain/ReAct format instructions
      sysPrompt = sysPrompt.replace(/Use the following format:[\s\S]*?Thought:[\s\S]*?Action:[\s\S]*?Action Input:[\s\S]*?(?=\n\n|$)/i, "");
      
      // 3. Strip any general "format your output as XML" or "format as JSON" that conflicts with us
      sysPrompt = sysPrompt.replace(/Please format your output as.*?xml.*?/gi, "");

      // PREPEND our strict instructions, and append the sanitized original context
      body.messages[0].content = `${instructions}\n\n[USER SYSTEM PROMPT (SANITIZED)]\n${sysPrompt.trim()}`;
    } else {
      body.messages.unshift({ role: "system", content: instructions });
    }
  }

  const raw = body as unknown as Record<string, unknown>;
  const extraBody = (raw.extra_body ?? raw.thinking_body ?? {}) as Record<string, unknown>;
  const thinking =
    extraBody.thinking !== undefined ? Boolean(extraBody.thinking) : config.defaultThinking;
  const search = extraBody.search !== undefined ? Boolean(extraBody.search) : config.defaultSearch;

  const isStream = body.stream === true;

  let chatSessionId = existingSessionId ?? "";
  let isReuse = false;

  if (existingSessionId) {
    isReuse = true;
  }

  const { images, hasImages } = extractImages(body.messages);
  const refFileIds: string[] = [];
  const textMessages = hasImages ? stripImageParts(body.messages) : body.messages;

  let effectiveModelType = config.model_type;

  if (hasImages) {
    effectiveModelType = "vision";
    for (const img of images) {
      const buffer = dataUriToBuffer(img.url);
      if (buffer) {
        const fileId = await uploadFile(session, buffer, "image.png", "vision");
        if (fileId) refFileIds.push(fileId);
      }
    }
  }

  let prompt: string;
  if (isReuse) {
    prompt = `User: ${lastUserMessage(textMessages)}`;
  } else {
    prompt = flattenMessages(textMessages);
  }

  if (hasImages && !prompt.trim()) {
    prompt = "Describe this image.";
  }

  const [chatSession, challenge] = await Promise.all([
    isReuse ? Promise.resolve(null) : createChatSession(session),
    requestPoWChallenge(session),
  ]);

  if (chatSession) {
    chatSessionId = chatSession.id;
  }

  const powResponse = await solvePoWAsync(challenge);
  const powEncoded = encodePowResponse(powResponse);

  const parentMessageId =
    isReuse && chatSessionId ? (messageIds?.get(chatSessionId) ?? null) : null;

  const maxTokens = body.max_tokens;

  const completionBody = {
    chat_session_id: chatSessionId,
    parent_message_id: parentMessageId,
    prompt,
    ref_file_ids: refFileIds,
    thinking_enabled: thinking,
    search_enabled: search,
    action: null,
    preempt: false,
    model_type: effectiveModelType,
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
  };

  const headers = buildHeaders(session);
  headers.cookie = buildCookieHeader(session.cookies);
  headers["x-ds-pow-response"] = powEncoded;

  const response = await fetch(`${BASE_URL}/api/v0/chat/completion`, {
    method: "POST",
    headers,
    body: JSON.stringify(completionBody),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek completion failed: ${response.status} ${text}`);
  }

  if (!response.body) {
    throw new Error("No response body from DeepSeek");
  }

  let result: Response;
  if (isStream) {
    result = await handleStreamingResponse(response, body.model, chatSessionId, messageIds, signal, prompt);
  } else {
    result = await handleNonStreamingResponse(
      response,
      body.model,
      chatSessionId,
      messageIds,
      prompt,
    );
  }

  result.headers.set("x-deepseek-chat-session-id", chatSessionId);
  return result;
}

interface ExtractedImage {
  url: string;
}

function extractImages(messages: OpenAIMessage[]): {
  images: ExtractedImage[];
  hasImages: boolean;
} {
  const images: ExtractedImage[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "image_url" && part.image_url?.url) {
          images.push({ url: part.image_url.url });
        }
      }
    }
  }
  return { images, hasImages: images.length > 0 };
}

function stripImageParts(messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages.map((msg) => {
    if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((p) => p.type !== "image_url");
      if (textParts.length === 0) return msg;
      return { ...msg, content: textParts };
    }
    return msg;
  });
}

function dataUriToBuffer(dataUri: string): Uint8Array | null {
  if (dataUri.startsWith("data:")) {
    const commaPos = dataUri.indexOf(",");
    if (commaPos === -1) return null;
    const base64 = dataUri.slice(commaPos + 1);
    try {
      return new Uint8Array(Buffer.from(base64, "base64"));
    } catch {
      return null;
    }
  }
  return null;
}

async function uploadFile(
  session: DeepSeekSession,
  fileBuffer: Uint8Array,
  fileName: string,
  modelType: string,
): Promise<string | null> {
  const challenge = await requestPoWChallengeForTarget(session, "/api/v0/file/upload_file");
  const powResponse = await solvePoWAsync(challenge);
  const powEncoded = encodePowResponse(powResponse);

  const boundary = `--deepseek-upload-${Date.now()}`;
  const header = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const headerBytes = new TextEncoder().encode(header);
  const footerBytes = new TextEncoder().encode(footer);
  const body = new Uint8Array(headerBytes.length + fileBuffer.length + footerBytes.length);
  body.set(headerBytes, 0);
  body.set(fileBuffer, headerBytes.length);
  body.set(footerBytes, headerBytes.length + fileBuffer.length);

  const headers = buildHeaders(session);
  headers.cookie = buildCookieHeader(session.cookies, session.accessToken);
  headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
  headers["x-ds-pow-response"] = powEncoded;
  headers["x-thinking-enabled"] = "0";
  headers["x-model-type"] = modelType;
  headers["x-file-size"] = String(fileBuffer.length);

  try {
    const response = await fetch(`${BASE_URL}/api/v0/file/upload_file`, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      code: number;
      data: { biz_data: { id: string; status: string } };
    };
    if (data.code !== 0) return null;
    const fileId = data.data.biz_data.id;

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const pollHeaders = buildHeaders(session);
      pollHeaders.cookie = buildCookieHeader(session.cookies, session.accessToken);
      const pollRes = await fetch(`${BASE_URL}/api/v0/file/fetch_files?file_ids=${fileId}`, {
        headers: pollHeaders,
      });
      if (!pollRes.ok) continue;
      const pollData = (await pollRes.json()) as {
        code: number;
        data: { biz_data: { files: Array<{ id: string; status: string }> } };
      };
      if (pollData.code !== 0) continue;
      const file = pollData.data.biz_data.files[0];
      if (file && file.status !== "PENDING" && file.status !== "PARSING") {
        if (file.status === "SUCCESS") return fileId;
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function requestPoWChallengeForTarget(
  session: DeepSeekSession,
  targetPath: string,
): Promise<PoWChallenge> {
  const headers = buildHeaders(session);
  headers.cookie = buildCookieHeader(session.cookies, session.accessToken);

  const response = await fetch(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
    method: "POST",
    headers,
    body: JSON.stringify({ target_path: targetPath }),
    signal: AbortSignal.timeout(30000),
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

async function requestPoWChallenge(session: DeepSeekSession): Promise<PoWChallenge> {
  return requestPoWChallengeForTarget(session, "/api/v0/chat/completion");
}

const DEBUG = !!process.env.DEBUG_DEEPSEEK;

function debug(...args: unknown[]) {
  if (DEBUG) console.error("[deepseek-oauth]", ...args);
}

async function handleStreamingResponse(
  deepseekResponse: Response,
  model: string,
  chatSessionId: string,
  messageIds?: Map<string, number>,
  signal?: AbortSignal,
  prompt?: string,
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
      let totalOutputLength = 0;
      let totalBytes = 0;
      let contentBuffer = "";
      let reasoningBuffer = "";
      let toolCallBuffer = "";
      let isToolCall = false;
      let checkedToolCall = false;
      let lastFlushTime = Date.now();

      let streamClosed = false;

      const closeStream = () => {
        if (streamClosed) return;
        streamClosed = true;
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
          choices: [{ index: 0, delta: {}, finish_reason: isToolCall ? ("tool_calls" as any) : "stop" }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\n`));

        const pLen = prompt?.length || 0;
        const usageChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: Math.ceil(pLen / 3),
            completion_tokens: Math.ceil(totalOutputLength / 3),
            total_tokens: Math.ceil((pLen + totalOutputLength) / 3),
          }
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      const parser = new DeepSeekSSEParser((content, reasoning, done, msgId) => {
        if (msgId != null && messageIds) {
          messageIds.set(chatSessionId, msgId);
        }

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
        reasoningBuffer += reasoning;
        totalOutputLength += content.length + reasoning.length;

        if (!isToolCall) {
          if (contentBuffer.includes("<tool_call>")) {
            isToolCall = true;
            contentBuffer = contentBuffer.slice(contentBuffer.indexOf("<tool_call>"));
            checkedToolCall = true;
          } else if (contentBuffer.includes("<use_mcp_tool>")) {
            isToolCall = true;
            contentBuffer = contentBuffer.slice(contentBuffer.indexOf("<use_mcp_tool>"));
            checkedToolCall = true;
          } else if (contentBuffer.includes("<function=")) {
            isToolCall = true;
            contentBuffer = contentBuffer.slice(contentBuffer.indexOf("<function="));
            checkedToolCall = true;
          } else if (contentBuffer.includes("Action:")) {
            isToolCall = true;
            contentBuffer = contentBuffer.slice(contentBuffer.indexOf("Action:"));
            checkedToolCall = true;
          } else if (!checkedToolCall && contentBuffer.length > 200) {
            checkedToolCall = true;
          }
        }

        if (isToolCall) {
          toolCallBuffer = contentBuffer;
          contentBuffer = "";

          if (done) {
            let parsedCall: any = null;

            // Strategy 1: XML parsing (<tool_call>)
            if (toolCallBuffer.includes("<tool_call>")) {
              const match = toolCallBuffer.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
              const rawJson = match ? match[1].trim() : toolCallBuffer.replace(/<tool_call>/g, "").replace(/<\/tool_call>/g, "").trim();
              try { parsedCall = JSON.parse(rawJson); } catch {}
            }
            // Strategy 2: Hermes MCP XML (<use_mcp_tool>)
            else if (toolCallBuffer.includes("<use_mcp_tool>")) {
              const serverMatch = toolCallBuffer.match(/<server_name>(.*?)<\/server_name>/);
              const toolMatch = toolCallBuffer.match(/<tool_name>(.*?)<\/tool_name>/);
              const argsMatch = toolCallBuffer.match(/<arguments>([\s\S]*?)<\/arguments>/);
              
              if (toolMatch && argsMatch) {
                // Combine server_name and tool_name if necessary, or just use tool_name 
                // For OpenAI format, we usually just pass the tool_name. If Hermes prefixes it, we need to handle that.
                // Looking at typical MCP implementations via OpenAI, the function name is usually `<server>__<tool>`.
                // Let's check how Hermes maps it. Usually it expects the raw JSON function call.
                // Wait! If Hermes explicitly asked for <use_mcp_tool>, maybe we should just return it as text and Hermes will parse it natively?
                // YES! If Hermes parses <use_mcp_tool> itself from the text response, we DON'T need to translate it into an OpenAI tool_call!
                // Wait... if Hermes parsed it from text natively, why didn't it execute the tool in my previous log?
                // Let's review the previous log: Hermes printed it out as a text response and ended the session!
                // Ah, Hermes natively parses OpenAI `tool_calls` array for executing tools. The <use_mcp_tool> format is just what DeepSeek chose to output because it saw it in the system prompt. But Hermes EXPECTS an OpenAI tool_calls chunk.
                // Let's translate it!
                let name = toolMatch[1].trim();
                if (serverMatch) name = `mcp__${serverMatch[1].trim()}__${name}`;
                
                try {
                  const args = argsMatch[1].trim();
                  JSON.parse(args); // validate
                  parsedCall = { name, arguments: args };
                } catch {}
              }
            }
            // Strategy 3: ReAct parsing (Action: name \n Action Input: {...})
            else if (toolCallBuffer.includes("Action:")) {
              const actionMatch = toolCallBuffer.match(/Action:\s*([^\n]+)/);
              const inputMatch = toolCallBuffer.match(/Action Input:\s*([\s\S]+)/);
              if (actionMatch && inputMatch) {
                const name = actionMatch[1].trim();
                let args = inputMatch[1].trim();
                args = args.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
                parsedCall = { name, arguments: args };
                try { JSON.parse(args); } catch { parsedCall = null; }
              }
            }
            // Strategy 4: Hallucinated <function=NAME> ... </function>
            else if (toolCallBuffer.includes("<function=")) {
              const nameMatch = toolCallBuffer.match(/<function=([^>]+)>/);
              if (nameMatch) {
                const name = nameMatch[1].trim();
                // Try to parse <path>...</path> style args, or just shove everything inside into JSON
                // Example: <path>desktop/test</path> <content>hello</content>
                const args: Record<string, string> = {};
                const tags = toolCallBuffer.matchAll(/<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g);
                for (const match of tags) {
                  const key = match[1];
                  const value = match[2];
                  if (key !== "function") {
                    args[key] = value.trim();
                  }
                }
                parsedCall = { name, arguments: JSON.stringify(args) };
              }
            }

            if (!parsedCall || !parsedCall.name) {
              // Malformed — emit as text
              const delta: OpenAIChatChunk["choices"][0]["delta"] = { content: toolCallBuffer };
              const chunk: OpenAIChatChunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              return;
            }

            // Emit the tool_calls delta
            const delta: OpenAIChatChunk["choices"][0]["delta"] = {
              tool_calls: [{
                index: 0,
                id: `call_${Date.now()}`,
                type: "function",
                function: {
                  name: parsedCall.name,
                  arguments: typeof parsedCall.arguments === "string"
                    ? parsedCall.arguments
                    : JSON.stringify(parsedCall.arguments || {})
                }
              }]
            };
            // finish_reason MUST be "tool_calls" so Hermes knows to continue the agentic loop
            const chunk: OpenAIChatChunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: "tool_calls" as any }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          return;
        }

        const hasPending = contentBuffer.length > 0 || reasoningBuffer.length > 0;
        const shouldFlush =
          done ||
          (hasPending &&
            (contentBuffer.length > 20 ||
              reasoningBuffer.length > 20 ||
              Date.now() - lastFlushTime > 50));
        if (shouldFlush) {
          if (hasPending) {
            const delta: OpenAIChatChunk["choices"][0]["delta"] = {};
            if (contentBuffer) delta.content = contentBuffer;
            if (reasoningBuffer) delta.reasoning_content = reasoningBuffer;
            const chunk: OpenAIChatChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            contentBuffer = "";
            reasoningBuffer = "";
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
          if (signal?.aborted) {
            debug("stream aborted by client, id:", id);
            await reader.cancel();
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        debug("reader exhausted, total bytes:", totalBytes, "id:", id);
        parser.flush();
      } catch (e) {
        debug("stream error:", e, "id:", id);
        if (!streamClosed) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: {
                  message: e instanceof Error ? e.message : "Stream error",
                  type: "server_error",
                },
              })}\n\n`,
            ),
          );
        }
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
  chatSessionId: string,
  messageIds?: Map<string, number>,
  prompt = "",
): Promise<Response> {
  if (!deepseekResponse.body) {
    throw new Error("No response body from DeepSeek");
  }
  const reader = deepseekResponse.body.getReader();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  let fullContent = "";
  let fullReasoning = "";

  const parser = new DeepSeekSSEParser((content, reasoning, _done, msgId) => {
    if (content) fullContent += content;
    if (reasoning) fullReasoning += reasoning;
    if (msgId != null && messageIds) {
      messageIds.set(chatSessionId, msgId);
    }
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
  parser.flush();

  const message: Record<string, unknown> = {
    role: "assistant",
    content: fullContent,
  };

  if (fullContent.trim().startsWith("<tool_call>")) {
    const cleanedJson = fullContent.replace("<tool_call>", "").replace("</tool_call>", "").trim();
    try {
      const parsedCall = JSON.parse(cleanedJson);
      message.content = null;
      message.tool_calls = [{
        id: `call_${Date.now()}`,
        type: "function",
        function: {
          name: parsedCall.name || "unknown",
          arguments: typeof parsedCall.arguments === "string" ? parsedCall.arguments : JSON.stringify(parsedCall.arguments || {})
        }
      }];
    } catch (e) {
      // Ignore and fallback to text
    }
  }

  if (fullReasoning) {
    message.reasoning_content = fullReasoning;
  }

  const responseBody = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: Math.ceil(prompt.length / 3),
      completion_tokens: Math.ceil(fullContent.length / 3),
      total_tokens: Math.ceil((prompt.length + fullContent.length) / 3),
    },
  };

  return new Response(JSON.stringify(responseBody), {
    headers: { "content-type": "application/json" },
  });
}
