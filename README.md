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

```bash
deepseek-oauth login
```

A browser window will open. Sign in to your DeepSeek account (or create a free one). Done.

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

## 🔌 OpenAI API endpoint

```
http://127.0.0.1:10531/v1
```

Compatible with **any** OpenAI SDK client. No API key required — pass anything as the key.

## 🧠 What's inside

- **Base64 WASM solver** — Native WebAssembly Proof-of-Work, inlined into the binary. No compiler needed.
- **Worker Threads** — PoW runs off the main thread so the event loop never freezes.
- **Tool call translation** — Converts `<tool_call>` responses into OpenAI `tool_calls` chunks so autonomous agents actually work.
- **Streaming usage chunks** — Emits token counts so Hermes' context bar tracks correctly.
- **Rate-limiting Mutex** — Prevents concurrent request storms from getting your account banned.
- **Graceful abort** — Cancels DeepSeek downloads immediately if the client disconnects.

## ♻️ Uninstall

```bash
deepseek-oauth uninstall   # remove auto-startup
npm unlink deepseek-oauth  # remove from PATH
```
