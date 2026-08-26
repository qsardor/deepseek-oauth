import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

import { startLogin } from "./login.js";
import { startServer } from "./server.js";
import { startDaemon, stopDaemon } from "./daemon.js";

export async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("deepseek-oauth")
    .version(pkg.version)
    .usage("$0 [command]")
    .command(
      "serve",
      "Start the OpenAI-compatible proxy server",
      (yargs) =>
        yargs
          .option("host", { type: "string", default: "127.0.0.1", describe: "Host to bind to" })
          .option("port", { type: "number", default: 10531, describe: "Port to bind to" }),
      async (args) => {
        const { host, port } = args;
        const server = await startServer({ host, port });
        console.log(`\n  OpenAI-compatible endpoint ready at http://${host}:${port}/v1`);
        console.log("  Use this as your OpenAI base URL. No API key required.\n");
        console.log("  Press Ctrl+C to stop\n");
        await server.closed();
      },
    )
    .command(
      "start",
      "Start the server in the background (like Ollama)",
      (yargs) =>
        yargs
          .option("host", { type: "string", default: "127.0.0.1", describe: "Host to bind to" })
          .option("port", { type: "number", default: 10531, describe: "Port to bind to" }),
      (args) => {
        startDaemon(args.host, args.port);
      },
    )
    .command(
      "stop",
      "Stop the background server",
      () => {},
      () => {
        stopDaemon();
      },
    )
    .command(
      "login",
      "Sign in to DeepSeek in your browser",
      (yargs) =>
        yargs.option("force", {
          alias: "y",
          type: "boolean",
          default: false,
          describe: "Force login (overwrite existing session without prompting)",
        }),
      async (args) => {
        await startLogin(args.force);
      },
    )
    .demandCommand(
      1,
      "Run `deepseek-oauth start` to start the proxy in the background, or `deepseek-oauth login` to sign in",
    )
    .parse();
}
