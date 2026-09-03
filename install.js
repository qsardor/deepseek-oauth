#!/usr/bin/env node
/**
 * install.js — One-shot installer for deepseek-oauth proxy
 *
 * Usage (from GitHub directly):
 *   npx github:qsardor/deepseek-oauth
 *
 * Or after cloning:
 *   node install.js
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_NAME = "DeepSeekOAuthProxy";

function step(msg) { console.log(`\n→ ${msg}...`); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.error(`  ❌ ${msg}`); process.exit(1); }

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║      DeepSeek OAuth Proxy — Installer                ║
║      Hermes-compatible OpenAI endpoint               ║
╚══════════════════════════════════════════════════════╝
`);

  // 1. Install dependencies
  step("Installing dependencies");
  try {
    execSync("npm install", { cwd: __dirname, stdio: "inherit" });
    ok("Dependencies installed");
  } catch { fail("npm install failed"); }

  // 2. Build all packages
  step("Building packages");
  try {
    execSync("npm run build", { cwd: __dirname, stdio: "inherit" });
    ok("Build complete");
  } catch { fail("Build failed"); }

  // 3. Install Playwright browser (for login)
  step("Installing Playwright browser (for login flow)");
  try {
    execSync("npx playwright install chromium --with-deps", { cwd: __dirname, stdio: "inherit" });
    ok("Playwright ready");
  } catch {
    console.log("  ⚠  Playwright install failed — login may not work until you run it manually");
  }

  // 4. Link the CLI globally so `deepseek-oauth` is in PATH
  step("Linking deepseek-oauth CLI to your global PATH");
  try {
    execSync("npm link", { cwd: join(__dirname, "packages", "deepseek-oauth"), stdio: "inherit" });
    ok("deepseek-oauth command is now globally available");
  } catch { fail("npm link failed — try running as Administrator"); }

  // 5. Register Windows logon startup task
  step("Registering auto-startup at Windows logon");
  if (platform() !== "win32") {
    console.log("  ⚠  Auto-startup is Windows-only. On Linux/macOS, add `deepseek-oauth start` to your shell rc file.");
  } else {
    const cliPath = join(__dirname, "packages", "deepseek-oauth", "dist", "cli.js");
    const nodePath = process.execPath;
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${process.env.USERNAME}</UserId></LogonTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>"${nodePath.replace(/\\/g, "\\\\")}"</Command>
      <Arguments>"${cliPath.replace(/\\/g, "\\\\")}" start --host 127.0.0.1 --port 10531</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
  </Settings>
</Task>`;

    const xmlPath = join(tmpdir(), "deepseek-oauth-task.xml");
    writeFileSync(xmlPath, Buffer.from("\uFEFF" + xml, "utf16le"));

    await new Promise((resolve) => {
      const proc = spawn("schtasks", ["/Create", "/F", "/TN", TASK_NAME, "/XML", xmlPath], { stdio: "inherit" });
      proc.on("close", (code) => {
        try { unlinkSync(xmlPath); } catch {}
        if (code === 0) ok("Auto-startup registered — proxy will start at every Windows login");
        else console.log("  ⚠  Could not register startup task. Run `deepseek-oauth install` later as Administrator.");
        resolve();
      });
    });
  }

  // 6. Start the proxy now so Hermes can immediately use it
  step("Starting the proxy in the background now");
  try {
    execSync("deepseek-oauth start", { stdio: "inherit" });
  } catch {
    console.log("  ⚠  Could not start proxy now — run `deepseek-oauth start` manually.");
  }

  console.log(`
╔══════════════════════════════════════════════════════╗
║  ✅  Installation complete!                           ║
║                                                      ║
║  Configure Hermes to use the proxy:                  ║
║                                                      ║
║  hermes config set model.provider custom             ║
║  hermes config set model.base_url \\                  ║
║      http://127.0.0.1:10531/v1                       ║
║  hermes config set model.default deepseek-chat       ║
║                                                      ║
║  Then just run: hermes chat                          ║
╚══════════════════════════════════════════════════════╝

  Sign in to DeepSeek first (required once):
    deepseek-oauth login

`);
}

main().catch((e) => { console.error(e); process.exit(1); });
