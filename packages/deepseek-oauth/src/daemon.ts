import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, mkdirSync, openSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const TASK_NAME = "DeepSeekOAuthProxy";

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

export function installStartup(host: string, port: number): void {
  if (process.platform !== "win32") {
    console.error("\n  ❌ Auto-startup is only supported on Windows via Task Scheduler.\n");
    process.exit(1);
  }

  const nodePath = process.execPath.replace(/\\/g, "\\\\");
  const cliPath = process.argv[1].replace(/\\/g, "\\\\");

  // Build the XML task definition for full control over the task
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${process.env.USERNAME}</UserId>
    </LogonTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>"${nodePath}"</Command>
      <Arguments>"${cliPath}" start --host ${host} --port ${port}</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
  </Settings>
</Task>`;

  const xmlPath = join(tmpdir(), "deepseek-oauth-task.xml");

  // Write as UTF-16LE (required by schtasks /XML)
  const buf = Buffer.from("\uFEFF" + xml, "utf16le");
  writeFileSync(xmlPath, buf);

  const result = spawn(
    "schtasks",
    ["/Create", "/F", "/TN", TASK_NAME, "/XML", xmlPath],
    { stdio: "inherit" }
  );

  result.on("close", (code) => {
    try { unlinkSync(xmlPath); } catch { /* ignore */ }
    if (code === 0) {
      console.log(`\n  ✅ DeepSeek proxy will now auto-start every time you log into Windows.`);
      console.log(`  Just like Ollama — silently available at http://${host}:${port}/v1`);
      console.log(`\n  To remove this, run: deepseek-oauth uninstall\n`);
    } else {
      console.error("\n  ❌ Failed to register startup task.\n");
    }
  });
}

export function uninstallStartup(): void {
  if (process.platform !== "win32") {
    console.error("\n  ❌ Auto-startup is only supported on Windows.\n");
    process.exit(1);
  }

  const result = spawn("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { stdio: "inherit", shell: true });
  result.on("close", (code) => {
    if (code === 0) {
      console.log("\n  ✅ Auto-startup task removed. The proxy will no longer start automatically.\n");
    } else {
      console.error("\n  ❌ Could not find startup task. Was it ever installed?\n");
    }
  });
}

