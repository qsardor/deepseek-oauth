import { login as doLogin, loadCredentials } from "@deepseek-oauth/local";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function startLogin(force: boolean = false): Promise<void> {
  const existing = await loadCredentials();
  if (existing && !force) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question("\nYou are already logged in! Do you want to overwrite your existing login? (y/N): ");
    rl.close();
    
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Login cancelled.\n");
      return;
    }
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
