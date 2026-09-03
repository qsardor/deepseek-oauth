import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredCredentials } from "./types.js";

let dpapi: any = null;
if (process.platform === "win32") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dpapi = require("win-dpapi");
  } catch {
    // ignore
  }
}

function getAuthDir(): string {
  return process.env.DEEPSEEK_OAUTH_HOME || join(homedir(), ".deepseek-oauth");
}

export function getAuthFilePath(): string {
  return join(getAuthDir(), "auth.json");
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  const path = getAuthFilePath();
  try {
    const data = await readFile(path, "utf-8");
    const json = JSON.parse(data);
    if (json._encrypted && dpapi) {
      const decoded = Buffer.from(json.data, "base64");
      const decrypted = dpapi.unprotectData(decoded, null, "CurrentUser");
      return JSON.parse(decrypted.toString("utf-8")) as StoredCredentials;
    }
    return json as StoredCredentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  const dir = getAuthDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  let outData: string;
  if (dpapi) {
    const buffer = Buffer.from(JSON.stringify(creds, null, 2), "utf-8");
    const encrypted = dpapi.protectData(buffer, null, "CurrentUser");
    outData = JSON.stringify({ _encrypted: true, data: encrypted.toString("base64") }, null, 2);
  } else {
    outData = JSON.stringify(creds, null, 2);
  }
  await writeFile(getAuthFilePath(), outData, { mode: 0o600 });
}
