import { login as doLogin, loadCredentials } from "@deepseek-oauth/local";

export async function startLogin(): Promise<void> {
  const existing = await loadCredentials();
  if (existing) {
    console.log("\nYou are already logged in!");
    console.log("If you want to sign in with a different account, delete the `~/.deepseek-oauth/auth.json` file first.\n");
    return;
  }

  console.log("\nOpening browser to sign in to DeepSeek...\n");

  try {
    await doLogin();
    console.log("Authenticated.\n");
  } catch (e) {
    if (e instanceof Error && e.message.includes("Target page, context or browser has been closed")) {
      console.log("\nLogin cancelled by user (browser closed).\n");
      return;
    }
    throw new Error(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
