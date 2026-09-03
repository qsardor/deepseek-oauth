import { parentPort } from "node:worker_threads";
import { solvePoW } from "./pow.js";
import type { PoWChallenge } from "./types.js";

parentPort?.on("message", (challenge: PoWChallenge) => {
  try {
    const response = solvePoW(challenge);
    parentPort?.postMessage({ success: true, response });
  } catch (err: any) {
    parentPort?.postMessage({ success: false, error: err.message });
  }
});
