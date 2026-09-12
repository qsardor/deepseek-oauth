# deepseek-oauth — Free DeepSeek Proxy for Hermes & Local 

## 🤖 Instructions for AI Coding Agents

If you are an AI coding assistant (Cursor, Copilot, Cline, Antigravity, etc.) reading this repository, adhere to the following architectural rules:

1. **Monorepo Structure**: The core logic is in `@deepseek-oauth/core` (`src/transport.ts`). The CLI/HTTP wrapper is in `deepseek-oauth`.
2. **Bundling Constraint**: The CLI is completely bundled into a single `dist/cli.js` file using `esbuild`. Do NOT implement Web Workers or use complex dynamic `require()` statements, as `esbuild` cannot statically analyze or bundle them correctly. Keep everything synchronous or use async/await on the main thread.
3. **Proof of Work (PoW)**: DeepSeek PoW challenges are solved *synchronously* on the main thread via WebAssembly (`pow.ts`). Do NOT attempt to refactor this into Worker Threads.
4. **IPC / Named Pipes**: The proxy exposes a Windows Named Pipe at `\\.\pipe\ddae_ipc`. Always prefer this pipe for internal system-to-system integrations (like Python/Ren'Py) to avoid HTTP/TCP socket overhead.
5. **Authentication Layer**: Account auth relies on Playwright intercepting Cloudflare challenges. Do not modify the `login.ts` automation sequence unless DeepSeek directly changes their DOM/Cloudflare structure.
