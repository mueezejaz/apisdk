# gemini-lb

Load-balanced AI client with **Redis-backed API keys**, per-model rate limits,
automatic 429 retry across keys, and error tracking. Google Gemini and
[Token Harbor](https://tokenharbor.ai/docs/getting-started/quickstart) keys can
be managed together.

Works two ways:

1. **Vercel AI SDK provider** — drop-in model for `generateText` / `streamText`
2. **Raw API calls** — `lb.generate()` calls the selected provider directly, no AI SDK needed

## Install

Paste this folder into your project's `packages/` folder (npm/pnpm workspace)
or install it directly:

```bash
npm install file:../packages/gemini-lb     # or: npm pack + install the tarball
```

Peer deps: `ioredis` (bundled as dep), and `ai` only if you use the AI SDK
integration. The current AI SDK adapter uses the v4 provider interface.

## Setup

All API keys live in a Redis hash (`gemini-lb:keys`) — no keys in code.
Keys are organized as **account → project → key → models[]**, with a
`provider` and optional `baseUrl` on each key.

- **Google Gemini** uses Google's native `generateContent` API.
- **Token Harbor** uses its OpenAI-compatible Chat Completions API. The
  documented values are:
  - Base URL: `https://tokenharbor.ai/v1`
  - API key: `thk_live_…`
  - Endpoint: `/v1/chat/completions`
  - Model: any id returned by `/v1/models`, for example `th-orchestra`

```bash
# .env
REDIS_URL=redis://...            # same Redis for everyone
```

The dashboard can add either provider. Select **Google Gemini** or **Token
Harbor · OpenAI compatible**, enter the provider-specific base URL, API key,
and model id. Token Harbor's default base URL is filled in automatically.

## Usage

### 1. Raw API call (no AI SDK)

```ts
import { createGeminiLB } from 'gemini-lb';

const lb = createGeminiLB({ redisUrl: process.env.REDIS_URL });

const res = await lb.generate({
  prompt: 'Hello!',
  // model: 'auto',              // default — balancer picks key+model
  // model: 'gemini-3.1-flash-lite',
  // model: 'th-orchestra',       // Token Harbor model id
  // system: 'You are terse.',    // optional
  // generationConfig: { temperature: 0.7 }, // optional
});

console.log(res.text);       // reply text
console.log(res.model);      // actual model used (resolved from 'auto')
console.log(res.keyId);      // which key served it
console.log(res.provider);   // 'google' or 'tokenharbor'

await lb.disconnect();
```

`model: 'auto'` considers configured Google models first, then other models
attached to enabled keys (including Token Harbor models). A key is only used
for a model it has configured.

### 2. Vercel AI SDK

```ts
import { createGeminiLB } from 'gemini-lb';
import { generateText, streamText } from 'ai';

const lb = createGeminiLB({ redisUrl: process.env.REDIS_URL });

const { text } = await generateText({
  model: lb('gemini-3.1-flash-lite'),   // or lb('th-orchestra')
  prompt: 'Hello!',
});
```

The same model id can be routed to Google or Token Harbor when both keys have
that model configured. The selected key's provider and base URL determine the
wire protocol; requests are not sent to Google's API with a Token Harbor key,
or vice versa.

## How requests are routed

- A Lua script atomically claims a **minute slot + daily slot** for the first
  eligible key+model pair under its own limits.
- On **429**, the slot is released and the request retries with another
  eligible key+model pair (up to `maxRetries`, default 3).
- Every error is recorded in Redis (last 10 per key) for inspection.
- Deleting a key removes its counters too; changing a key's provider or base
  URL resets that key's usage/error history. Other keys' stats are untouched
  (stable key IDs, not array indexes).

## API

| Method | Purpose |
|---|---|
| `lb.generate(opts)` | Raw Google/Token Harbor call → `{ text, model, keyId, provider, raw }` |
| `lb(modelId)` / `lb.chat(modelId)` | AI SDK `LanguageModelV4` (`'auto'` supported) |
| `lb.getStats()` | Per-key per-model usage from Redis |
| `lb.getRequestLog()` | This process's claim/release/exhausted log |
| `lb.getKeyStore()` | `list() / getEnabled() / add() / update() / remove()` |
| `lb.disconnect()` | Close Redis (if this instance created it) |

### Settings (`createGeminiLB({...})`)

| Option | Default | Notes |
|---|---|---|
| `redisUrl` / `redis` | — | Where keys + rate-limit state live |
| `keys` | — | One-time seed (never overwrites Redis) |
| `defaultProvider` | `'google'` | Provider for seeded raw keys |
| `defaultBaseUrl` | Token Harbor `/v1` | Base URL for seeded Token Harbor keys |
| `models` | Gemini defaults, or `['th-orchestra']` for Token Harbor seeds | Fallback models / auto order |
| `maxPerMinute` / `maxPerDay` | `15` / `500` | Fallback limits for keys without model config |
| `windowMs` | `60000` | Sliding window |
| `maxRetries` | `3` | Retries on 429 |
| `headers` / `fetch` / `name` | — | Custom headers / fetch / provider name |

For the raw API, Gemini-shaped `safetySettings` and `tools` are not translated
to OpenAI automatically. Put OpenAI-specific fields in `body` when using a
Token Harbor key.

Rate limits are **per key-per-model** and stored in Redis, so multiple
processes/servers sharing the same `REDIS_URL` share one global limit.

## Live Token Harbor smoke test

From the workspace root, after adding an enabled Token Harbor key in the
dashboard:

```bash
npm run test:tokenharbor
```

The test reads the key from Redis, prefers a configured `:free` model, sends
one tiny request through the same load-balancer path, and prints only masked
key information. Set `TOKENHARBOR_TEST_MODEL` to test a specific configured
model instead. The raw key is never printed or written by this script.
