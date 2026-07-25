import { login as doLogin } from "@deepseek-oauth/local";

export async function startLogin(): Promise<void> {
  console.log("\nOpening browser to sign in to DeepSeek...\n");

  try {
    await doLogin();
    console.log("Authenticated.\n");
  } catch (e) {
    throw new Error(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
