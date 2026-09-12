# deepseek-oauth — Free DeepSeek Proxy for Hermes & Local Agents

Use **DeepSeek's free web tier** as a fully OpenAI-compatible API endpoint. No API key. No credit card. Blazing-fast WebAssembly PoW solving, background daemon, and native Windows auto-startup — just like Ollama.

## ⚡ One-line install (from GitHub)

```bash
git clone https://github.com/qsardor/deepseek-oauth
cd deepseek-oauth
node install.js
```

The installer will automatically:
- Build all packages
- Install Playwright (for browser-based login)
- Add `deepseek-oauth` to your global PATH via `npm link`
- Register a **Windows Task Scheduler** task so the proxy starts silently at every login (like Ollama)
- Boot the proxy immediately so you can start using it right away

## 🔐 Sign in (required once)

> ⚠️ **IMPORTANT: ACCOUNT BAN RISK**
> DeepSeek has very aggressive anti-bot and anti-spam measures. If you use your personal DeepSeek account for heavy API proxying or autonomous agents, **it is highly likely to be muted or banned**. 
> 
> **Recommendation:** DO NOT use your personal account. Create disposable temporary accounts. 
> You can easily generate temporary Google-routed emails directly from your terminal using our zero-dependency CLI: 
> ```bash
> npx tempgmail new --google
> ```

```bash
deepseek-oauth login
```

A browser window will open. Sign in to your temporary DeepSeek account. Done.

## 🤝 Configure Hermes

```bash
hermes config set model.provider custom
hermes config set model.base_url http://127.0.0.1:10531/v1
hermes config set model.default deepseek-chat
```

Then just run `hermes chat` — the proxy is always silently running in the background.

## 🛠 Commands

| Command | Description |
|---|---|
| `deepseek-oauth login` | Sign in to DeepSeek (opens browser) |
| `deepseek-oauth start` | Start the proxy daemon in the background |
| `deepseek-oauth stop` | Stop the background daemon |
| `deepseek-oauth install` | Register auto-startup at Windows login |
| `deepseek-oauth uninstall` | Remove the auto-startup task |
| `deepseek-oauth serve` | Run the proxy in the foreground (for debugging) |

## 🔌 Dual-Mode Endpoint (HTTP & IPC)

**Standard HTTP (OpenAI Compatible):**
```
http://127.0.0.1:10531/v1
```
Compatible with **any** OpenAI SDK client. No API key required — pass anything as the key.

**Ultra-low Latency IPC (Windows Named Pipes):**
```
\\.\pipe\ddae_ipc
```
For local applications (like game engines or high-speed agents), you can bypass HTTP entirely. Just write a JSON payload to the pipe and read the response. 

**Python IPC Example:**
```python
import json

with open(r'\\.\pipe\ddae_ipc', 'r+b', buffering=0) as pipe:
    # 1. Write Request
    req = json.dumps({"model": "chat", "messages": [{"role": "user", "content": "Hi"}]})
    pipe.write(req.encode('utf-8'))
    
    # 2. Read Response
    response_data = b""
    while True:
        chunk = pipe.read(4096)
        if not chunk: break
        response_data += chunk
        
    print(json.loads(response_data.decode('utf-8')))
```

## 🧠 What's inside

- **Synchronous WASM PoW solver** — Native WebAssembly Proof-of-Work, instantly solves DeepSeek challenges on the main thread without fragile worker files.
- **Dual-Mode Networking** — Exposes both HTTP and Windows Named Pipes simultaneously.
- **Tool call translation** — Converts `<tool_call>` responses into OpenAI `tool_calls` chunks so autonomous agents actually work.
- **Streaming usage chunks** — Emits token counts so Hermes' context bar tracks correctly.
- **Rate-limiting Mutex** — Prevents concurrent request storms from getting your account banned.
- **Graceful abort** — Cancels DeepSeek downloads immediately if the client disconnects.

## ♻️ Uninstall

```bash
deepseek-oauth uninstall   # remove auto-startup
npm unlink deepseek-oauth  # remove from PATH
```

## ?? Instructions for AI Coding Agents

If you are an AI coding assistant (Cursor, Copilot, Cline, Antigravity, etc.) reading this repository, adhere to the following architectural rules:

1. **Monorepo Structure**: The core logic is in @deepseek-oauth/core (src/transport.ts). The CLI/HTTP wrapper is in deepseek-oauth.
2. **Bundling Constraint**: The CLI is completely bundled into a single dist/cli.js file using esbuild. Do NOT implement Web Workers or use complex dynamic equire() statements, as esbuild cannot statically analyze or bundle them correctly. Keep everything synchronous or use async/await on the main thread.
3. **Proof of Work (PoW)**: DeepSeek PoW challenges are solved *synchronously* on the main thread via WebAssembly (pow.ts). Do NOT attempt to refactor this into Worker Threads.
4. **IPC / Named Pipes**: The proxy exposes a Windows Named Pipe at \\.\pipe\ddae_ipc. Always prefer this pipe for internal system-to-system integrations (like Python/Ren'Py) to avoid HTTP/TCP socket overhead.
5. **Authentication Layer**: Account auth relies on Playwright intercepting Cloudflare challenges. Do not modify the login.ts automation sequence unless DeepSeek directly changes their DOM/Cloudflare structure.
