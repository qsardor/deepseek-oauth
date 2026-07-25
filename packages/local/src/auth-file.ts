import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredCredentials } from "./types.js";

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
    return JSON.parse(data) as StoredCredentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  const dir = getAuthDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(getAuthFilePath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
}
