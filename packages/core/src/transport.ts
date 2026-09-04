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


import * as path from "path";
import * as fsLib from "fs";

function formatMessagesForLog(messages: any[], assistantReply?: string, assistantReasoning?: string) {
  let md = "# RedSeek Chat History\n\n";
  for (const msg of messages) {
    md += "## [" + (msg.role || "unknown").toUpperCase() + "]\n";
    if (msg.role === "tool") md += "Tool Result for: " + msg.tool_call_id + "\n";
    if (typeof msg.content === "string") md += msg.content + "\n\n";
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) if (part.type === "text") md += part.text + "\n\n";
    }
    if (msg.tool_calls) {
      for (const call of msg.tool_calls) {
        md += "**Tool Call:** `" + call.function.name + "`\n" +
              "```json\n" + call.function.arguments + "\n```\n\n";
      }
    }
  }
  if (assistantReply || assistantReasoning) {
    md += "## [ASSISTANT]\n";
    if (assistantReasoning) md += "<think>\n" + assistantReasoning + "\n</think>\n\n";
    if (assistantReply) md += assistantReply + "\n\n";
  }
  return md;
}

function writeChatHistory(messages: any[], assistantReply?: string, assistantReasoning?: string, completionBody?: any) {
  try {
    const logsDir = path.join(process.cwd(), "logs");
    if (!fsLib.existsSync(logsDir)) fsLib.mkdirSync(logsDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `chat-${timestamp}.md`;
    
    let md = `## Proxy Log - ${timestamp}\n`;
    if (completionBody) {
      md += `## Model: ${completionBody.model_type || "unknown"}\n\n`;
      md += "### Raw JSON Sent to DeepSeek\n```json\n" + JSON.stringify(completionBody, null, 2) + "\n```\n\n";
    }
    
    md += formatMessagesForLog(messages, assistantReply, assistantReasoning);
    
    fsLib.writeFileSync(path.join(logsDir, filename), md, "utf-8");
    fsLib.writeFileSync(path.join(logsDir, "chat-LATEST.md"), md, "utf-8");
  } catch (e) {
    console.error("[PROXY] Failed to write chat history:", e);
  }
}

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
      const name = (m as any).name || m.tool_call_id || "tool";
      cleaned.push({ role: "user", content: `|DSML|\n<tool_result name="${name}">\n<output>\n${extractContent(m.content)}\n</output>\n</tool_result>` });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const callsText = m.tool_calls.map((c: any) => `|DSML|\n<tool_call name="${c.function.name}">\n<arguments>\n${c.function.arguments}\n</arguments>\n</tool_call>`).join("\n\n");
      const text = extractContent(m.content);
      const combined = text ? `${text}\n\n${callsText}` : callsText;
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

function flattenMessages(messages: OpenAIMessage[], toolsXml?: string): string {
  const cleaned = cleanMessages(messages);
  const parts: string[] = [];
  let hasSystem = false;
  for (const m of cleaned) {
    const text = extractContent(m.content);
    if (m.role === "system") {
      hasSystem = true;
      parts.push(`[System Instruction]:\n${text}${toolsXml ? "\n\n" + toolsXml : ""}`);
    } else if (m.role === "user") {
      parts.push(`Human: ${text}`);
    } else if (m.role === "assistant") {
      parts.push(`Assistant: ${text}`);
    } else {
      parts.push(text);
    }
  }
  if (toolsXml && !hasSystem) parts.unshift(`[System Instruction]:\n${toolsXml}`);
  return parts.join("\n\n");
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

  let toolsXml = "";
  if (body.tools && body.tools.length > 0) {
    // Disable DeepSeek's own web search so it doesn't answer from memory instead of using tools
    const raw2 = body as unknown as Record<string, unknown>;
    raw2.search = false;
    
    toolsXml = "|DSML|\n<tools>\n";
    for (const t of body.tools) {
      if (t.type === "function") {
        toolsXml += `<tool name="${t.function.name}">\n`;
        if (t.function.description) toolsXml += `<description>${t.function.description}</description>\n`;
        toolsXml += `<parameters>\n${JSON.stringify(t.function.parameters)}\n</parameters>\n</tool>\n`;
      }
    }
    toolsXml += "</tools>";
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
    prompt = flattenMessages(textMessages, toolsXml);
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
    result = await handleStreamingResponse(response, body.model, chatSessionId, messageIds, signal, prompt, undefined, body.messages, completionBody);
  } else {
    result = await handleNonStreamingResponse(response, body.model, chatSessionId, messageIds, prompt, body.messages, completionBody);
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
  session?: any,
  messages?: any[],
  completionBody?: any,
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
      let fullContentBuffer = "";
      let fullReasoningBuffer = "";
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
        fullContentBuffer += content;
        fullReasoningBuffer += reasoning;
        totalOutputLength += content.length + reasoning.length;

        if (!isToolCall) {
          if (contentBuffer.includes("|DSML|")) {
            isToolCall = true;
            contentBuffer = contentBuffer.slice(contentBuffer.indexOf("|DSML|"));
            checkedToolCall = true;
          } else if (contentBuffer.includes("<tool_call>")) {
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
          } else if (contentBuffer.includes("```json")) {
            isToolCall = true;
            contentBuffer = contentBuffer.slice(contentBuffer.indexOf("```json"));
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

            // Strategy 0: DSML XML parsing
            if (toolCallBuffer.includes("|DSML|")) {
              const nameMatch = toolCallBuffer.match(/<tool_call[^>]*name=["']([^"']+)["'][^>]*>/) || toolCallBuffer.match(/<name>([^<]+)<\/name>/) || toolCallBuffer.match(/name=["']([^"']+)["']/);
              const argsMatch = toolCallBuffer.match(/<arguments>([\s\S]*?)<\/arguments>/) || toolCallBuffer.match(/<parameters>([\s\S]*?)<\/parameters>/) || toolCallBuffer.match(/>([\s\S]*?)<\/tool_call>/) || toolCallBuffer.match(/\{[\s\S]*\}/);
              if (nameMatch) {
                const name = nameMatch[1].trim();
                let args = argsMatch ? argsMatch[1].trim() : "{}";
                const jsonMatch = args.match(/\{[\s\S]*\}/);
                if (jsonMatch) args = jsonMatch[0];
                parsedCall = { name, arguments: args };
                try { JSON.parse(args); } catch { parsedCall = null; }
              }
            }
            // Strategy 1: XML parsing (<tool_call>JSON</tool_call>)
            if (!parsedCall && toolCallBuffer.includes("<tool_call>")) {
              const match = toolCallBuffer.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
              const rawJson = match ? match[1].trim() : toolCallBuffer.replace(/<tool_call>/g, "").replace(/<\/tool_call>/g, "").trim();
              try { parsedCall = JSON.parse(rawJson); } catch {}
            }
            // Strategy 2: Hermes MCP XML (<use_mcp_tool>)
            if (!parsedCall && toolCallBuffer.includes("<use_mcp_tool>")) {
              const serverMatch = toolCallBuffer.match(/<server_name>(.*?)<\/server_name>/);
              const toolMatch = toolCallBuffer.match(/<tool_name>(.*?)<\/tool_name>/);
              const argsMatch = toolCallBuffer.match(/<arguments>([\s\S]*?)<\/arguments>/);
              if (toolMatch && argsMatch) {
                let name = toolMatch[1].trim();
                if (serverMatch) name = `mcp__${serverMatch[1].trim()}__${name}`;
                try {
                  const args = argsMatch[1].trim();
                  JSON.parse(args);
                  parsedCall = { name, arguments: args };
                } catch {}
              }
            }
            // Strategy 3: ReAct parsing (Action: name \n Action Input: {...})
            if (!parsedCall && toolCallBuffer.includes("Action:")) {
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
            if (!parsedCall && toolCallBuffer.includes("<function=")) {
              const nameMatch = toolCallBuffer.match(/<function=([^>]+)>/);
              if (nameMatch) {
                const name = nameMatch[1].trim();
                const args: Record<string, string> = {};
                const tags = toolCallBuffer.matchAll(/<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g);
                for (const match of tags) {
                  if (match[1] !== "function") args[match[1]] = match[2].trim();
                }
                parsedCall = { name, arguments: JSON.stringify(args) };
              }
            }
            // Strategy 5: Raw markdown JSON block (```json {...} ```)
            if (!parsedCall && toolCallBuffer.includes("```json")) {
              const match = toolCallBuffer.match(/```json\s*([\s\S]*?)```/);
              const rawJson = match ? match[1].trim() : toolCallBuffer.replace(/```json/g, "").replace(/```/g, "").trim();
              try {
                const parsed = JSON.parse(rawJson);
                const name = parsed.tool || parsed.name || parsed.action || parsed.function;
                if (name) parsedCall = { name, arguments: parsed.arguments || parsed.parameters || JSON.stringify(parsed) };
              } catch {}
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
          if (messages) writeChatHistory(messages, fullContentBuffer, fullReasoningBuffer, completionBody);
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

      if (messages) writeChatHistory(messages, fullContentBuffer, fullReasoningBuffer, completionBody);
      if (!streamFinished) { debug("stream fallback close, id:", id); closeStream(); }
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
  messages?: any[],
  completionBody?: any,
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

  if (messages) writeChatHistory(messages, fullContent, fullReasoning, completionBody);
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
