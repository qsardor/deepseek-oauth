# deepseek-oauth

Use DeepSeek's models through any OpenAI-compatible client. No API key needed.

## Setup

```sh
git clone https://github.com/Devlrxxh/deepseek-oauth.git
cd deepseek-oauth
npm run setup    # installs dependencies, builds, downloads Playwright Chromium
npm run link     # makes deepseek-oauth available globally
```

## Quick start

```sh
deepseek-oauth login   # open browser to sign in
deepseek-oauth serve   # start the proxy
```

Your session is stored in `~/.deepseek-oauth/auth.json` and refreshes automatically. Or set the `DEEPSEEK_TOKEN` environment variable with your token instead.

## Server flags

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Interface to bind to |
| `--port` | `10531` | Port to listen on |

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/v1/chat/completions` | POST | Chat (streaming and non-streaming) |
| `/v1/models` | GET | Available model list |
| `/health` | GET | Health check |

## Models

- `deepseek-instant`
- `deepseek-expert`

## Using from code

```ts
import { createDeepSeekTransport } from "@deepseek-oauth/core";
import { deepSeekCredentials } from "@deepseek-oauth/local";

const transport = createDeepSeekTransport(deepSeekCredentials());

const res = await transport.fetch(
  new Request("http://deepseek-oauth.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-instant",
      messages: [{ role: "user", content: "Hello!" }],
    }),
  })
);

const data = await res.json();
console.log(data.choices[0].message.content);
```

### With the OpenAI JS SDK

```ts
import OpenAI from "openai";
import { createDeepSeekTransport } from "@deepseek-oauth/core";
import { deepSeekCredentials } from "@deepseek-oauth/local";

const transport = createDeepSeekTransport(deepSeekCredentials());

const openai = new OpenAI({
  apiKey: "deepseek-oauth",
  baseURL: transport.baseURL,
  fetch: transport.fetch,
});
```

## Packages

| Package | Description |
|---------|-------------|
| `deepseek-oauth` | CLI: `login` and `serve` commands |
| `@deepseek-oauth/core` | Transport, SSE parser, PoW solver, types |
| `@deepseek-oauth/local` | Browser auth (Playwright), credential storage |

## Limitations

- Tool calling is not supported (DeepSeek's internal API doesn't expose it).
- Only models available through the web chat are exposed.

---

Inspired by [openai-oauth](https://github.com/EvanZhouDev/openai-oauth).

deepseek-oauth is unofficial and not affiliated with DeepSeek. Treat your credentials like passwords. Provided as-is.
