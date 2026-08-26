import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function getPidFile() {
  const dir = process.env.DEEPSEEK_OAUTH_HOME || join(homedir(), ".deepseek-oauth");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "server.pid");
}

export function startDaemon(host: string, port: number) {
  const pidFile = getPidFile();
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf-8"));
    try {
      process.kill(pid, 0); // Check if process is actually alive
      console.log(`\nServer is already running in the background (PID: ${pid}).`);
      console.log("Run `deepseek-oauth stop` to shut it down.\n");
      return;
    } catch {
      // Process is dead, clean up old PID file
      rmSync(pidFile);
    }
  }

  console.log("Starting server in the background...");
  
  const logFile = join(process.env.DEEPSEEK_OAUTH_HOME || join(homedir(), ".deepseek-oauth"), "server.log");
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const child = spawn(process.execPath, [process.argv[1], "serve", "--host", host, "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true
  });

  child.unref(); // Detach completely

  if (child.pid) {
    writeFileSync(pidFile, String(child.pid), "utf-8");
    console.log(`\n  Boom! Server is online in the background (PID: ${child.pid}).`);
    console.log(`  OpenAI-compatible endpoint ready at http://${host}:${port}/v1`);
    console.log("  You can safely close this terminal window.");
    console.log("  To stop it later, just run `deepseek-oauth stop`\n");
  } else {
    console.error("Failed to start daemon.");
  }
}

export function stopDaemon() {
  const pidFile = getPidFile();
  if (!existsSync(pidFile)) {
    console.log("\nNo server is currently running in the background.\n");
    return;
  }
  
  const pid = Number(readFileSync(pidFile, "utf-8"));
  try {
    process.kill(pid);
    console.log(`\nServer (PID: ${pid}) has been successfully stopped.\n`);
  } catch (e) {
    console.log("\nServer was not running or already stopped.\n");
  }
  
  rmSync(pidFile);
}
