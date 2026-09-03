import type { DeepSeekCredentials, DeepSeekSession } from "@deepseek-oauth/core";
import { loadCredentials, saveCredentials } from "./auth-file.js";
import { loginViaBrowser, refreshSession } from "./auth.js";
import { type StoredCredentials, fromSession, toSession } from "./types.js";

// No artificial expiry - we use the session until DeepSeek's servers
// actually reject it. Silent headless refresh handles renewal automatically.

async function tryRefreshWithRetry(stored: StoredCredentials, attempts = 3): Promise<DeepSeekSession | null> {
  for (let i = 0; i < attempts; i++) {
    const refreshed = await refreshSession(stored);
    if (refreshed) return refreshed;
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return null;
}

export function deepSeekCredentials(): DeepSeekCredentials {
  let currentSession: DeepSeekSession | null = null;

  return {
    async getSession(): Promise<DeepSeekSession> {
      const envToken = process.env.DEEPSEEK_TOKEN;
      if (envToken) {
        if (currentSession?.accessToken === envToken) {
          return currentSession;
        }
        currentSession = {
          accessToken: envToken,
          cookies: {},
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          capturedAt: Date.now(),
        };
        return currentSession;
      }

      // Use in-memory session if we have one - no expiry check
      if (currentSession) {
        return currentSession;
      }

      // Load from disk - no age check, use it as-is
      const stored = await loadCredentials();
      if (stored) {
        currentSession = toSession(stored);
        return currentSession;
      }

      // Nothing on disk at all - try a silent headless refresh or fail
      throw new LoginRequired();
    },
  };
}

export class LoginRequired extends Error {
  constructor() {
    super("Not signed in to DeepSeek. Run `npx deepseek-oauth login` first.");
    this.name = "LoginRequired";
  }
}

export async function login(): Promise<DeepSeekSession> {
  const session = await loginViaBrowser();
  await saveCredentials(fromSession(session));
  return session;
}

export { loadCredentials, saveCredentials } from "./auth-file.js";
export type { StoredCredentials } from "./types.js";
