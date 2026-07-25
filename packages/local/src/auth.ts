import type { DeepSeekSession } from "@deepseek-oauth/core";
import type { StoredCredentials } from "./types.js";

const DEEPSEEK_URL = "https://chat.deepseek.com";

export async function loginViaBrowser(): Promise<DeepSeekSession> {
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });

    const page = await context.newPage();

    console.log("\nOpening browser to sign in to DeepSeek...");
    console.log("Please sign in at chat.deepseek.com in the opened browser window.");
    console.log("The process will continue automatically once you're signed in.\n");

    await page.goto(DEEPSEEK_URL, { waitUntil: "networkidle", timeout: 60000 });

    try {
      await page.waitForURL(
        (url) => url.href.startsWith(DEEPSEEK_URL) && !url.href.includes("/sign_in"),
        { timeout: 300000 },
      );
    } catch {
      console.log("Proceeding with current page state...");
    }

    await page.waitForTimeout(2000);

    const token = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("userToken");
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed.value || null;
      } catch {
        return null;
      }
    });

    if (!token) {
      throw new Error(
        "Could not extract authentication token. Make sure you're signed in to chat.deepseek.com.",
      );
    }

    const cookies = await context.cookies();
    const cookieMap: Record<string, string> = {};
    for (const c of cookies) {
      cookieMap[c.name] = c.value;
    }

    const userAgent = await page.evaluate(() => navigator.userAgent);

    return {
      accessToken: token,
      cookies: cookieMap,
      userAgent,
      capturedAt: Date.now(),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function refreshSession(stored: StoredCredentials): Promise<DeepSeekSession | null> {
  const { chromium } = await import("playwright");

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const storedCookies = Object.entries(stored.cookies).map(([name, value]) => ({
      name,
      value,
      domain: ".deepseek.com",
      path: "/",
    }));

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });

    if (storedCookies.length > 0) {
      await context.addCookies(storedCookies);
    }

    const page = await context.newPage();

    await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    await page.waitForTimeout(3000);

    const token = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("userToken");
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed.value || null;
      } catch {
        return null;
      }
    });

    if (!token) {
      return null;
    }

    const cookies = await context.cookies();
    const cookieMap: Record<string, string> = {};
    for (const c of cookies) {
      cookieMap[c.name] = c.value;
    }

    const userAgent = await page.evaluate(() => navigator.userAgent);

    return {
      accessToken: token,
      cookies: cookieMap,
      userAgent,
      capturedAt: Date.now(),
    };
  } catch {
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
