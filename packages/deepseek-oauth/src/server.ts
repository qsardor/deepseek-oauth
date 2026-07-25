import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { createDeepSeekTransport } from "@deepseek-oauth/core";
import { LoginRequired, deepSeekCredentials } from "@deepseek-oauth/local";
import { readBody, sendJson, sendText } from "./shared.js";

const DEBUG = !!process.env.DEBUG_DEEPSEEK;

function debug(...args: unknown[]) {
  if (DEBUG) console.error("[deepseek-oauth-server]", ...args);
}

export interface ServerOptions {
  host: string;
  port: number;
}

export interface ServerInstance {
  closed(): Promise<void>;
  close(): void;
}

export async function startServer(options: ServerOptions): Promise<ServerInstance> {
  const transport = createDeepSeekTransport(deepSeekCredentials());

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handleRequest(req, res, transport);
    } catch (e) {
      if (e instanceof LoginRequired) {
        sendText(res, 401, "Not signed in to DeepSeek. Run `deepseek-oauth login` first.");
        return;
      }
      console.error("Request error:", e);
      sendText(res, 500, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  let closedResolve: () => void;
  let closedReject: (err: Error) => void;
  const closedPromise = new Promise<void>((resolve, reject) => {
    closedResolve = resolve;
    closedReject = reject;
  });

  server.on("error", (err: Error) => {
    closedReject(err);
  });

  server.listen(options.port, options.host);

  server.on("close", () => {
    closedResolve?.();
  });

  return {
    async closed() {
      await closedPromise;
    },
    close() {
      server.close();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: ReturnType<typeof createDeepSeekTransport>,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (path === "/health" || path === "/v1/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (path === "/v1/models" || path === "/models") {
    const response = await transport.fetch(new Request(`http://localhost${path}`));
    const data = await response.json();
    sendJson(res, response.status, data);
    return;
  }

  if (path === "/v1/chat/completions" || path === "/chat/completions") {
    if (req.method !== "POST") {
      sendText(res, 405, "Method not allowed");
      return;
    }

    const body = await readBody(req);
    const response = await transport.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      res.writeHead(response.status, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      if (!response.body) {
        sendText(res, 500, "No response body from DeepSeek");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let totalChunks = 0;

      debug("piping SSE stream to client");

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          const ok = res.write(text);
          totalChunks++;
          debug("piped chunk", totalChunks, "length:", text.length);
          if (!ok) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
      } finally {
        debug("SSE stream complete, total chunks:", totalChunks);
        res.end();
      }
    } else {
      const data = await response.json();
      sendJson(res, response.status, data);
    }
    return;
  }

  sendText(res, 404, `Not found: ${path}`);
}
