import { createInterface } from "node:readline";
import type { DeepSeekSession } from "@deepseek-oauth/core";
import { login as doLogin, loadCredentials, saveCredentials } from "@deepseek-oauth/local";

export async function startLogin(options?: { manual?: boolean }): Promise<void> {
  if (options?.manual) {
    await manualLogin();
    return;
  }

  console.log("\nOpening browser to sign in to DeepSeek...\n");

  try {
    const session = await doLogin();
    const masked =
      session.accessToken.length > 40
        ? `${session.accessToken.substring(0, 20)}...${session.accessToken.slice(-20)}`
        : session.accessToken.length > 20
          ? `${session.accessToken.substring(0, 20)}...`
          : session.accessToken;
    console.log("\n✓ Signed in successfully!");
    console.log(`  Token: ${masked}`);
    console.log(`  Cookies: ${Object.keys(session.cookies).length} entries`);
    console.log();
  } catch (e) {
    throw new Error(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function manualLogin(): Promise<void> {
  console.log("\nManual Login — Cookie Export Method");
  console.log("═══════════════════════════════════════");
  console.log("This method extracts cookies from your REAL browser session.");
  console.log("DeepSeek requires both the token AND browser cookies to work.\n");

  console.log("Step 1: Open https://chat.deepseek.com and make sure you're signed in");
  console.log("Step 2: Open DevTools (F12) → Console tab");
  console.log("Step 3: Paste this EXACT code and press Enter:\n");
  console.log('  fetch("https://chat.deepseek.com/api/v0/chat_session/create",');
  console.log('    { method: "POST", credentials: "include" })');
  console.log("    .then(r => r.text())");
  console.log("    .then(console.log)");
  console.log("    .catch(console.error);\n");
  console.log('  If you get a valid response ({"code":0,...}), skip to Step 5.');
  console.log("  If you get an HTML error, continue to Step 4.\n");

  console.log("Step 4 (if needed): Instead, paste this to extract your full session:\n");
  console.log("  copy(JSON.stringify({");
  console.log('    token: JSON.parse(localStorage.getItem("userToken")).value,');
  console.log("    cookies: document.cookie");
  console.log("  }));\n");
  console.log("  Note: Some HttpOnly cookies won't be included. We'll try anyway.\n");

  console.log("Step 5: Paste the full JSON blob (or just the token) below:\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const input = await new Promise<string>((resolve) => {
    rl.question("Paste here: ", (answer) => {
      resolve(answer.trim());
    });
  });
  rl.close();

  if (!input) {
    throw new Error("No input provided.");
  }

  let token = input;
  const cookies: Record<string, string> = {};

  try {
    const parsed = JSON.parse(input);
    if (parsed.token) {
      token = parsed.token;
    }
    if (parsed.cookies && typeof parsed.cookies === "string") {
      for (const pair of parsed.cookies.split(";")) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          cookies[pair.substring(0, eq).trim()] = pair.substring(eq + 1).trim();
        }
      }
    }
  } catch {
    console.log(
      "  (Plain token — cookies will be empty. The API may not work without session cookies.)",
    );
  }

  const session: DeepSeekSession = {
    accessToken: token,
    cookies,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    capturedAt: Date.now(),
  };

  await saveCredentials({
    accessToken: session.accessToken,
    cookies: session.cookies,
    userAgent: session.userAgent,
    capturedAt: session.capturedAt,
  });

  console.log("\n✓ Credentials saved!");
  console.log(`  Token: ${token.substring(0, 20)}...`);
  console.log(`  Cookies: ${Object.keys(cookies).length} entries`);
  console.log("\n  Now run: node packages/deepseek-oauth/dist/cli.js serve\n");
}
