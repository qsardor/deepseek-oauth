import type { DeepSeekSession } from "@deepseek-oauth/core";

export interface StoredCredentials {
  accessToken: string;
  cookies: Record<string, string>;
  userAgent: string;
  capturedAt: number;
}

export function toSession(stored: StoredCredentials): DeepSeekSession {
  return {
    accessToken: stored.accessToken,
    cookies: stored.cookies,
    userAgent: stored.userAgent,
    capturedAt: stored.capturedAt,
  };
}

export function fromSession(session: DeepSeekSession): StoredCredentials {
  return {
    accessToken: session.accessToken,
    cookies: session.cookies,
    userAgent: session.userAgent,
    capturedAt: session.capturedAt,
  };
}
