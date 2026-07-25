import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_SIZE = 10 * 1024 * 1024;

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}
