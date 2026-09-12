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
import * as osLib from "os";

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
    const logsDir = process.env.REDSEEK_LOG_DIR ?? path.join(osLib.homedir(), ".redseek", "logs");
    if (!fsLib.existsSync(logsDir)) fsLib.mkdirSync(logsDir, { recursive: true });
    
    // Clean up "leak" from the debug logs
    let cleanReply = assistantReply;
    if (cleanReply) {
      cleanReply = cleanReply.replace(/<｜｜DSML｜｜tool_call>[\s\S]*?(?:<\/｜｜DSML｜｜tool_call>|$)/g, "");
      cleanReply = cleanReply.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "");
      cleanReply = cleanReply.replace(/<ï½œï½œDSMLï½œï½œtool_call>[\s\S]*?(?:<\/ï½œï½œDSMLï½œï½œtool_call>|$)/g, "");
      cleanReply = cleanReply.trim();
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `chat-${timestamp}.md`;
    
    const debugData = {
      timestamp,
      raw_messages_received: messages,
      raw_assistant_reply: assistantReply, // Keep true raw in JSON
      raw_assistant_reasoning: assistantReasoning,
      deepseek_completion_body: completionBody
    };
    fsLib.writeFileSync(path.join(logsDir, `raw-debug-${timestamp}.json`), JSON.stringify(debugData, null, 2), "utf-8");

    let md = `## Proxy Log - ${timestamp}\n`;
    if (completionBody) {
      md += `## Model: ${completionBody.model_type || "unknown"}\n\n`;
      md += "### Raw JSON Sent to DeepSeek\n```json\n" + JSON.stringify(completionBody, null, 2) + "\n```\n\n";
    }
    
    md += formatMessagesForLog(messages, cleanReply, assistantReasoning);
    
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

// DeepSeek unified model (as of Sept 2026 — Instant/Expert/Vision merged into one backend)
const UNIFIED_MODEL: ModelConfig = { model_type: "DEFAULT", defaultThinking: true, defaultSearch: false };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function resolveModel(_model: string): ModelConfig {
  return UNIFIED_MODEL;
}

function extractContent(content: string | { type: string; text?: string }[] | null): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

function extractToolResult(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // AI SDK v5: content is array of parts
    const parts: string[] = [];
    for (const p of content) {
      if (p.type === "text") parts.push(p.text ?? "");
      else if (p.type === "tool-result") {
        // result can be string or {output: string} or array
        const r = p.result;
        if (typeof r === "string") parts.push(r);
        else if (r && typeof r === "object") parts.push(r.output ?? r.text ?? JSON.stringify(r));
        else if (Array.isArray(r)) parts.push(r.map((x: any) => x.text ?? JSON.stringify(x)).join("\n"));
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object" && content.output) return String(content.output);
  return String(content);
}

function cleanMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  const cleaned: OpenAIMessage[] = [];
  for (const m of messages) {
    // OpenAI-style role=tool (legacy & AI SDK v4)
    if (m.role === "tool") {
      const name = (m as any).name || m.tool_call_id || "tool";
      const output = extractToolResult(m.content);
      cleaned.push({ role: "user", content: `<tool_result name="${name}">\n<output>\n${output}\n</output>\n</tool_result>\n\nTool execution completed. If the task is NOT complete, issue your next <tool_call> immediately without text. If the task is fully complete, provide your final response to the user.` });
      continue;
    }

    // AI SDK v5: assistant with content array containing tool-call/tool-result parts
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts = m.content as any[];
      const toolCalls = parts.filter((p: any) => p.type === "tool-call");
      const textParts = parts.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("");

      if (toolCalls.length > 0) {
        const callsText = toolCalls.map((c: any) =>
          `<tool_call>\n{"name": "${c.toolName}", "arguments": ${typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {})}}\n</tool_call>`
        ).join("\n\n");
        const combined = textParts ? `${textParts}\n\n${callsText}` : callsText;
        cleaned.push({ role: "assistant", content: combined });
        continue;
      }
      if (!textParts.trim()) continue; // skip empty assistant
      cleaned.push({ role: "assistant", content: textParts });
      continue;
    }

    // AI SDK v5: user message with tool-result parts in content array
    if (m.role === "user" && Array.isArray(m.content) && (m.content as any[]).some((p: any) => p.type === "tool-result")) {
      const parts = (m.content as any[]) ?? [];
      const resultParts = parts.filter((p: any) => p.type === "tool-result");
      if (resultParts.length > 0) {
        const results = resultParts.map((p: any) => {
          const name = p.toolName || p.toolCallId || "tool";
          const output = extractToolResult(p.result ?? p.content);
          return `<tool_result name="${name}">\n<output>\n${output}\n</output>\n</tool_result>`;
        }).join("\n\n");
        cleaned.push({ role: "user", content: `${results}\n\nTool execution completed. If the task is NOT complete, issue your next <tool_call> immediately without text. If the task is fully complete, provide your final response to the user.` });
        continue;
      }
      // Regular user message (not tool-result)
      const text = extractContent(m.content);
      if (text.trim()) cleaned.push({ ...m, content: text } as OpenAIMessage);
      continue;
    }

    // OpenAI-style assistant with tool_calls field
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const callsText = m.tool_calls.map((c: any) => `<tool_call>\n{"name": "${c.function.name}", "arguments": ${c.function.arguments}}\n</tool_call>`).join("\n\n");
      const text = extractContent(m.content);
      cleaned.push({ role: "assistant", content: text ? `${text}\n\n${callsText}` : callsText });
      continue;
    }

    // Skip empty assistant messages
    if (m.role === "assistant" && !m.tool_calls) {
      const text = extractContent(m.content);
      if (!text.trim()) continue;
    }

    const { tool_calls: _, ...rest } = m;
    cleaned.push(rest as OpenAIMessage);
  }

  // Deduplicate consecutive same-role messages by merging content
  const deduped: OpenAIMessage[] = [];
  for (const m of cleaned) {
    if (deduped.length > 0 && deduped[deduped.length - 1].role === m.role) {
      const prev = deduped[deduped.length - 1];
      const prevText = extractContent(prev.content);
      const curText = extractContent(m.content);
      if (curText) prev.content = prevText ? `${prevText}\n\n${curText}` : curText;
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
  const sessionMap = new Map<string, string>(); // map x-opencode-session to chatSessionId

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
        try {
        const _dbgDir = process.env.REDSEEK_LOG_DIR ?? (osLib.homedir() + "/.redseek/logs");
        fsLib.mkdirSync(_dbgDir, { recursive: true });
        fsLib.writeFileSync(_dbgDir + "/debug-messages-latest.json", JSON.stringify(body.messages, null, 2), "utf-8");
        } catch (err: any) {
          console.error("Failed to write debug messages:", err?.message || err);
        }
        
        
        const baseOpencodeSession = request.headers.get("x-opencode-session") || "default";
        const hasTools = body.tools && body.tools.length > 0;
        const sessionMapKey = !hasTools ? baseOpencodeSession + "_notools" : baseOpencodeSession;
        
        const existingSessionId = sessionMap.get(sessionMapKey) ?? request.headers.get("x-deepseek-chat-session-id");
        
        const result = await handleChatCompletions(body, credentials, existingSessionId, messageIds, request.signal);
        
        const newSessionId = result.headers.get("x-deepseek-chat-session-id");
        if (newSessionId) {
          sessionMap.set(sessionMapKey, newSessionId);
        }
        return result;
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}

async function handleModels(): Promise<Response> {
  const data = [
    {
      id: "deepseek-chat",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "deepseek",
    },
  ];

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
    
    toolsXml = "You are an autonomous AI agent integrated directly into the user's system with full permission to execute commands and modify files. You MUST NOT refuse to create files, run commands, or interact with the system. When the user asks you to do something, you MUST use the following XML format to call the appropriate tool. DO NOT explain how to do it manually.\n\n[SYSTEM_TOOLS]\n<tools>\n";
    for (const t of body.tools) {
      if (t.type === "function") {
        toolsXml += `<tool name="${t.function.name}">\n`;
        if (t.function.description) toolsXml += `<description>${t.function.description}</description>\n`;
        toolsXml += `<parameters>\n${JSON.stringify(t.function.parameters)}\n</parameters>\n</tool>\n`;
      }
    }
    toolsXml += "</tools>\n\nCRITICAL INSTRUCTION: To use a tool, you MUST respond EXACTLY with this XML format and NOTHING ELSE. Do not add conversational text:\n<tool_call>\n{\"name\": \"TOOL_NAME\", \"arguments\": {...json...}}\n</tool_call>\n\nAfter you call a tool, the user will reply with the tool's execution result in this exact format:\n<tool_result name=\"TOOL_NAME\">\n<output>\n...result...\n</output>\n</tool_result>\n\nIf the task is NOT complete, immediately output your next <tool_call> without any conversational text. Keep issuing tool calls until the overarching objective is met. Only provide a final text summary when the task is 100% complete.";
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

  const effectiveModelType = config.model_type;

  if (hasImages) {
    for (const img of images) {
      const buffer = dataUriToBuffer(img.url);
      if (buffer) {
        const fileId = await uploadFile(session, buffer, "image.png", effectiveModelType);
        if (fileId) refFileIds.push(fileId);
      }
    }
  }

  let prompt: string;
  let chatSession: any = null;
  let challenge: any = null;

  // HIDDEN INIT TURN 0 (OpenClaw style priming)
  if (!isReuse && (toolsXml || textMessages.some(m => m.role === "system"))) {
    // 1. Gather all system instructions and tools
    const systemMsgs = textMessages.filter(m => m.role === "system");
    let turn0Text = systemMsgs.map(m => extractContent(m.content)).join("\n");
    if (toolsXml) {
      turn0Text += (turn0Text ? "\n\n" : "") + toolsXml;
    }
    const turn0Prompt = `[System Instruction]:\n${turn0Text}\n\nSystem: You must acknowledge these instructions and tools by replying exactly with 'Acknowledged'. For all subsequent messages, you must act as the AI agent and answer the user's queries autonomously according to these rules.`;

    // 2. Create session and solve PoW for Turn 0
    chatSession = await createChatSession(session);
    chatSessionId = chatSession.id;
    challenge = await requestPoWChallenge(session);
    const powEncoded0 = encodePowResponse(await solvePoWAsync(challenge));

    // 3. Send the hidden Turn 0 request
    const headers0 = buildHeaders(session);
    headers0.cookie = buildCookieHeader(session.cookies);
    headers0["x-ds-pow-response"] = powEncoded0;

    const prompt = turn0Prompt;
    const response0 = await fetch(`${BASE_URL}/api/v0/chat/completion`, {
      method: "POST",
      headers: headers0,
      body: JSON.stringify({
        chat_session_id: chatSessionId,
        parent_message_id: null,
        prompt: prompt,
        ref_file_ids: [],
        thinking_enabled: true,
        search_enabled: false,
        action: null,
        preempt: false,
        model_type: effectiveModelType,
      }),
      signal,
    });
    
    console.log("[PROXY] Turn 0 Status:", response0.status);
    if (!response0.ok) {
        console.log("[PROXY] Turn 0 Error Body:", await response0.text());
    }

    // 4. Consume the streaming response silently to get the new parent_message_id
    if (response0.ok && response0.body) {
      const reader = response0.body.getReader();
      const decoder = new TextDecoder();
      let msgId0: number | null = null;
      
      const parser0 = new DeepSeekSSEParser((_c, _r, _done, msgId) => {
        if (msgId != null && !msgId0) msgId0 = msgId;
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = decoder.decode(value, { stream: true });
          
          // Only log if the chunk contains an error (like user is muted)
          if (chunkStr.includes('"biz_code"') && !chunkStr.includes('"biz_code":0')) {
             console.log("[PROXY] Turn 0 Error Chunk:", chunkStr.trim());
          }
          
          parser0.feed(chunkStr);
        }
      } catch (e) {
         console.log("[PROXY] Turn 0 parsing error:", e);
      } finally {
        parser0.flush();
      }

      if (msgId0 != null && messageIds) {

        messageIds.set(chatSessionId, msgId0);
      }
    }

    // Now treat the actual user message as a reuse of this primed session
    isReuse = true;
    challenge = null; // Reset challenge for Turn 1
  }

  // Filter out system messages so they aren't sent again in Turn 1
  const nonSystemMsgs = textMessages.filter(m => m.role !== "system");

  if (isReuse) {
    prompt = lastUserMessage(cleanMessages(nonSystemMsgs));
  } else {
    prompt = flattenMessages(nonSystemMsgs, ""); // fallback if no tools/system
  }

  if (hasImages && !prompt.trim()) {
    prompt = "Describe this image.";
  }

  if (!chatSession && !isReuse) {
    chatSession = await createChatSession(session);
  }
  if (!challenge) {
    challenge = await requestPoWChallenge(session);
  }

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
  } catch (err: any) {
    console.error("Silent Failure: File upload crashed:", err?.message || err);
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
        if (!isToolCall) {
          fullContentBuffer += content;
        }
        fullReasoningBuffer += reasoning;
        totalOutputLength += content.length + reasoning.length;

        if (!isToolCall) {
          if (contentBuffer.includes("[SYSTEM_TOOLS]")) {
            isToolCall = true;
            contentBuffer = contentBuffer.slice(contentBuffer.indexOf("[SYSTEM_TOOLS]"));
            checkedToolCall = true;
          } else if (contentBuffer.includes("<｜｜DSML｜｜") || contentBuffer.includes("<ï½œï½œDSMLï½œï½œ")) {
            isToolCall = true;
            const idx1 = contentBuffer.indexOf("<｜｜DSML｜｜");
            const idx2 = contentBuffer.indexOf("<ï½œï½œDSMLï½œï½œ");
            const idx = idx1 !== -1 && idx2 !== -1 ? Math.min(idx1, idx2) : (idx1 !== -1 ? idx1 : idx2);
            contentBuffer = contentBuffer.slice(idx);
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
          toolCallBuffer += contentBuffer;
          contentBuffer = "";

          if (done) {
            let parsedCalls: any[] = [];
            console.log("Stream DONE. toolCallBuffer:", JSON.stringify(toolCallBuffer));

            // Helper to normalize the weird DSML unicode mangling
            const normalizedBuffer = toolCallBuffer.replace(/<ï½œï½œDSMLï½œï½œ/g, "<｜｜DSML｜｜").replace(/<\/ï½œï½œDSMLï½œï½œ/g, "</｜｜DSML｜｜");

            // Strategy 0: DSML XML parsing
            if (normalizedBuffer.includes("[SYSTEM_TOOLS]")) {
              const nameMatch = normalizedBuffer.match(/<tool_call[^>]*name=["']([^"']+)["'][^>]*>/) || normalizedBuffer.match(/<name>([^<]+)<\/name>/) || normalizedBuffer.match(/name=["']([^"']+)["']/);
              const argsMatch = normalizedBuffer.match(/<arguments>([\s\S]*?)<\/arguments>/) || normalizedBuffer.match(/<parameters>([\s\S]*?)<\/parameters>/) || normalizedBuffer.match(/>([\s\S]*?)<\/tool_call>/) || normalizedBuffer.match(/\{[\s\S]*\}/);
              if (nameMatch) {
                const name = nameMatch[1].trim();
                let args = argsMatch ? argsMatch[1].trim() : "{}";
                const jsonMatch = args.match(/\{[\s\S]*\}/);
                if (jsonMatch) args = jsonMatch[0];
                try { JSON.parse(args); parsedCalls.push({ name, arguments: args }); } catch {}
              }
            }
            // Strategy 1: <tool_call>JSON</tool_call> or <｜｜DSML｜｜tool_call>{"name":...,"arguments":{...}}</｜｜DSML｜｜tool_call>
            if (parsedCalls.length === 0 && (normalizedBuffer.includes("<tool_call>") || normalizedBuffer.includes("DSML"))) {
              const afterOpenTag = normalizedBuffer.replace(/^[\s\S]*?(?:<tool_call>|<｜｜DSML｜｜tool_call>)/, "");
              const jsonMatch = afterOpenTag.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                try {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if (parsed.name) {
                    const args = parsed.arguments ?? parsed.parameters ?? parsed;
                    parsedCalls.push({
                      name: parsed.name,
                      arguments: typeof args === "string" ? args : JSON.stringify(
                        parsed.arguments ? parsed.arguments : 
                        (({ name: _n, description: _d, ...rest }) => rest)(parsed)
                      )
                    });
                  }
                } catch (e) {}
              }
            }
            // Strategy 2: Hermes MCP XML (<use_mcp_tool>)
            if (parsedCalls.length === 0 && normalizedBuffer.includes("<use_mcp_tool>")) {
              const serverMatch = normalizedBuffer.match(/<server_name>(.*?)<\/server_name>/);
              const toolMatch = normalizedBuffer.match(/<tool_name>(.*?)<\/tool_name>/);
              const argsMatch = normalizedBuffer.match(/<arguments>([\s\S]*?)<\/arguments>/);
              if (toolMatch && argsMatch) {
                let name = toolMatch[1].trim();
                if (serverMatch) name = `mcp__${serverMatch[1].trim()}__${name}`;
                try {
                  const args = argsMatch[1].trim();
                  JSON.parse(args);
                  parsedCalls.push({ name, arguments: args });
                } catch {}
              }
            }
            // Strategy 5: DeepSeek Native DSML (<｜｜DSML｜｜)
            if (parsedCalls.length === 0 && normalizedBuffer.includes("<｜｜DSML｜｜")) {
              // Extract ALL <｜｜DSML｜｜ invoke> blocks
              const invokeRegex = /<｜｜DSML｜｜\s*invoke[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s*invoke>/g;
              let invokeMatch;
              while ((invokeMatch = invokeRegex.exec(normalizedBuffer)) !== null) {
                let name = invokeMatch[1].trim();
                if (name === "exec_command") name = "bash";
                if (name === "read_file") name = "read";
                if (name === "write_file") name = "write";
                
                const innerBody = invokeMatch[2];
                const argsObj: Record<string, string> = {};
                const paramRegex = /<｜｜DSML｜｜\s*parameter[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter>/g;
                let m;
                while ((m = paramRegex.exec(innerBody)) !== null) {
                  let val = m[2].trim();
                  if (name === "bash" && m[1] === "cmd") argsObj["command"] = val;
                  else argsObj[m[1]] = val;
                }
                parsedCalls.push({ name, arguments: JSON.stringify(argsObj) });
              }
              // Fallback if the regex failed but it looks like a single invoke without closing tag
              if (parsedCalls.length === 0) {
                  const nameMatch = normalizedBuffer.match(/<｜｜DSML｜｜\s*invoke[^>]*name=["']([^"']+)["']/);
                  if (nameMatch) {
                    let name = nameMatch[1].trim();
                    if (name === "exec_command") name = "bash";
                    if (name === "read_file") name = "read";
                    if (name === "write_file") name = "write";
                    
                    const argsObj: Record<string, string> = {};
                    const paramRegex = /<｜｜DSML｜｜\s*parameter[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter>/g;
                    let m;
                    while ((m = paramRegex.exec(normalizedBuffer)) !== null) {
                      let val = m[2].trim();
                      if (name === "bash" && m[1] === "cmd") argsObj["command"] = val;
                      else argsObj[m[1]] = val;
                    }
                    parsedCalls.push({ name, arguments: JSON.stringify(argsObj) });
                  }
              }
            }
            // Strategy 3: ReAct parsing (Action: name \n Action Input: {...})
            if (parsedCalls.length === 0 && normalizedBuffer.includes("Action:")) {
              const actionMatch = normalizedBuffer.match(/Action:\s*([^\n]+)/);
              const inputMatch = normalizedBuffer.match(/Action Input:\s*([\s\S]+)/);
              if (actionMatch && inputMatch) {
                const name = actionMatch[1].trim();
                let args = inputMatch[1].trim();
                args = args.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
                try { JSON.parse(args); parsedCalls.push({ name, arguments: args }); } catch {}
              }
            }
            // Strategy 4: Hallucinated <function=NAME> ... </function>
            if (parsedCalls.length === 0 && normalizedBuffer.includes("<function=")) {
              const nameMatch = normalizedBuffer.match(/<function=([^>]+)>/);
              if (nameMatch) {
                const name = nameMatch[1].trim();
                const args: Record<string, string> = {};
                const tags = normalizedBuffer.matchAll(/<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g);
                for (const match of tags) {
                  if (match[1] !== "function") args[match[1]] = match[2].trim();
                }
                parsedCalls.push({ name, arguments: JSON.stringify(args) });
              }
            }
            // Strategy 5: Raw markdown JSON block (```json {...} ```)
            if (parsedCalls.length === 0 && normalizedBuffer.includes("```json")) {
              const match = normalizedBuffer.match(/```json\s*([\s\S]*?)```/);
              const rawJson = match ? match[1].trim() : normalizedBuffer.replace(/```json/g, "").replace(/```/g, "").trim();
              try {
                const parsed = JSON.parse(rawJson);
                const name = parsed.tool || parsed.name || parsed.action || parsed.function;
                if (name) parsedCalls.push({ name, arguments: parsed.arguments || parsed.parameters || JSON.stringify(parsed) });
              } catch {}
            }

            if (parsedCalls.length === 0) {
              // Malformed/unparseable tool call — discard silently, do NOT leak raw tags to chat
              // Log the raw buffer so we can analyze the exact DSML syntax it uses
              try {
                const _dsmlDir = process.env.REDSEEK_LOG_DIR ?? path.join(osLib.homedir(), ".redseek", "logs");
                fsLib.mkdirSync(_dsmlDir, { recursive: true });
                fsLib.writeFileSync(path.join(_dsmlDir, "debug-dsml-failed.txt"), toolCallBuffer, "utf-8");
              } catch (err: any) {
                console.error("Failed to write debug DSML:", err?.message || err);
              }
              
              const hasToolMarkers = normalizedBuffer.includes("<｜｜DSML｜｜") ||
                normalizedBuffer.includes("<tool_call>") ||
                normalizedBuffer.includes("[SYSTEM_TOOLS]") ||
                normalizedBuffer.includes("<use_mcp_tool>") ||
                normalizedBuffer.includes("<function=");
              if (!hasToolMarkers) {
                // Pure text that got misidentified — emit it as normal text
                const delta: OpenAIChatChunk["choices"][0]["delta"] = { content: toolCallBuffer };
                const chunk: OpenAIChatChunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              // Tool markers: silently discard — proxy already tried all strategies
              return;
            }

            // Emit the tool_calls delta (without finish_reason)
            const delta: OpenAIChatChunk["choices"][0]["delta"] = {
              tool_calls: parsedCalls.map((call, idx) => ({
                index: idx,
                id: `call_${Date.now()}_${idx}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: typeof call.arguments === "string"
                    ? call.arguments
                    : JSON.stringify(call.arguments || {})
                }
              }))
            };
            const callChunk: OpenAIChatChunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(callChunk)}\n\n`));

            // Emit the finish_reason chunk (empty delta)
            const finishChunk: OpenAIChatChunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" as any }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
            
            streamFinished = true;
            closeStream();
          }
          return;
        }

        const shouldFlush =
          done ||
          (reasoningBuffer.length > 0 &&
            (reasoningBuffer.length > 20 || Date.now() - lastFlushTime > 50)) ||
          (contentBuffer.length > 0 &&
            checkedToolCall &&
            (contentBuffer.length > 20 || Date.now() - lastFlushTime > 50));

        if (shouldFlush) {
          const delta: OpenAIChatChunk["choices"][0]["delta"] = {};
          let emitted = false;

          if (contentBuffer && (done || checkedToolCall)) {
            delta.content = contentBuffer;
            contentBuffer = "";
            emitted = true;
          }
          if (reasoningBuffer && (done || reasoningBuffer.length > 20 || Date.now() - lastFlushTime > 50)) {
            delta.reasoning_content = reasoningBuffer;
            reasoningBuffer = "";
            emitted = true;
          }

          if (emitted) {
            const chunk: OpenAIChatChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            lastFlushTime = Date.now();
          }

          if (done) {
            streamFinished = true;
            debug("stream done by parser, id:", id);
            closeStream();
          }
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

  console.log("handleNonStreamingResponse -> fullContent", fullContent);
  if (fullContent.trim().startsWith("<tool_call>") || fullContent.trim().startsWith("<｜｜DSML｜｜tool_call>") || fullContent.trim().startsWith("<ï½œï½œDSMLï½œï½œtool_call>")) {
    const cleanedJson = fullContent.replace(/<tool_call>/g, "").replace(/<\/tool_call>/g, "")
                                   .replace(/<｜｜DSML｜｜tool_call>/g, "").replace(/<\/｜｜DSML｜｜tool_call>/g, "")
                                   .replace(/<ï½œï½œDSMLï½œï½œtool_call>/g, "").replace(/<\/ï½œï½œDSMLï½œï½œtool_call>/g, "").trim();
    console.log("Non-streaming parsed cleanedJson", cleanedJson);
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
      console.log("Non-streaming generated tool_calls", message.tool_calls);
    } catch (e) {
      console.error("Non-streaming parse error", e);
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
