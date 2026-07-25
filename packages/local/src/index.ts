import type { DeepSeekCredentials, DeepSeekSession } from "@deepseek-oauth/core";
import { loadCredentials, saveCredentials } from "./auth-file.js";
import { loginViaBrowser, refreshSession } from "./auth.js";
import { type StoredCredentials, fromSession, toSession } from "./types.js";

const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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

      if (currentSession) {
        const age = Date.now() - currentSession.capturedAt;
        if (age < SESSION_MAX_AGE_MS) {
          return currentSession;
        }
      }

      const stored = await loadCredentials();
      if (stored) {
        const age = Date.now() - stored.capturedAt;
        if (age < SESSION_MAX_AGE_MS) {
          currentSession = toSession(stored);
          return currentSession;
        }

        const refreshed = await refreshSession(stored);
        if (refreshed) {
          currentSession = refreshed;
          await saveCredentials(fromSession(refreshed));
          return currentSession;
        }
      }

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
