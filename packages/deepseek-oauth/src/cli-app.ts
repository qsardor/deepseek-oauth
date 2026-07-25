import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startLogin } from "./login.js";
import { startServer } from "./server.js";

export async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("deepseek-oauth")
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
      "login",
      "Sign in to DeepSeek in your browser",
      (yargs) =>
        yargs.option("manual", {
          type: "boolean",
          describe: "Manually paste your token instead of opening a browser",
        }),
      async (args) => {
        await startLogin({ manual: args.manual ?? false });
      },
    )
    .demandCommand(
      1,
      "Run `deepseek-oauth serve` to start the proxy, or `deepseek-oauth login` to sign in",
    )
    .parse();
}
