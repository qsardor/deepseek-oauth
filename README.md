# deepseek-oauth

Use DeepSeek's models through any OpenAI-compatible client. No API key needed.

```txt
$ npx deepseek-oauth serve
  OpenAI-compatible endpoint ready at http://127.0.0.1:10531/v1
```

---

## How it works

Sign in once via your browser, then run the proxy. That's it.

```sh
npx deepseek-oauth login    # sign in once (opens your browser)
npx deepseek-oauth serve    # start the proxy
```

Your session is stored in `~/.deepseek-oauth/auth.json` and refreshes automatically in the background. Set `DEEPSEEK_TOKEN` if you want to bypass file auth entirely (useful for CI).

## Server flags

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Interface to bind to |
| `--port` | `10531` | Port to listen on |

## Using it from code

```bash
npm i @deepseek-oauth/core @deepseek-oauth/local
```

```ts
import { createDeepSeekTransport } from "@deepseek-oauth/core";
import { deepSeekCredentials } from "@deepseek-oauth/local";

const transport = createDeepSeekTransport(deepSeekCredentials());

const res = await transport.fetch(
  new Request("http://deepseek-oauth.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "Hello!" }],
    }),
  })
);

const data = await res.json();
console.log(data.choices[0].message.content);
```

The transport object exposes `baseURL` and `fetch`. Plug them into any OpenAI-compatible client.

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

### Direct session access

```ts
import { deepSeekCredentials } from "@deepseek-oauth/local";

const session = await deepSeekCredentials().getSession();
console.log(session.accessToken);
```

## Packages

| Package | Description | Dependencies |
|---------|-------------|--------------|
| `deepseek-oauth` | CLI: `login` and `serve` commands | core + local |
| `@deepseek-oauth/core` | Transport, SSE parser, PoW solver, types | none |
| `@deepseek-oauth/local` | Browser auth (Playwright), credential storage | core |

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/v1/chat/completions` | POST | Chat (streaming and non-streaming) |
| `/v1/models` | GET | Available model list |
| `/health` | GET | Health check |

## Models

- `deepseek-chat`: chat model
- `deepseek-reasoner`: V4 with reasoning traces (DeepThink)

Set the model to `deepseek-reasoner` to get reasoning traces in the `reasoning_content` delta field.

## Limitations

- Tool calling is stripped from requests (DeepSeek's internal API doesn't support it).
- Each completion creates a new chat session. The proxy is stateless.
- Only models available through the web chat are exposed.
---

Inspired by [openai-oauth](https://github.com/EvanZhouDev/openai-oauth).

deepseek-oauth is unofficial and not affiliated with DeepSeek. Treat your credentials like passwords. Provided as-is.
