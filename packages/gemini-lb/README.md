# gemini-lb

Load-balanced Gemini client with **Redis-backed API keys**, per-model rate
limits, automatic 429 retry across keys, and error tracking.

Works two ways:

1. **Vercel AI SDK provider** — drop-in model for `generateText` / `streamText`
2. **Raw API calls** — `lb.generate()` calls Gemini directly, no AI SDK needed

## Install

Paste this folder into your project's `packages/` folder (npm/pnpm workspace)
or install it directly:

```bash
npm install file:../packages/gemini-lb     # or: npm pack + install the tarball
```

Peer deps: `ioredis` (bundled as dep), and `ai` **only if you use the AI SDK
integration** (the raw `generate()` works without it).

## Setup

All API keys live in a Redis hash (`gemini-lb:keys`) — no keys in code.
Keys are organized as **account → project → key → models[]**, each model with
its own `maxPerMinute` / `maxPerDay`.

```bash
# .env
REDIS_URL=redis://...            # same Redis for everyone
```

## Usage

### 1. Raw API call (no AI SDK)

```ts
import { createGeminiLB } from 'gemini-lb';

const lb = createGeminiLB({ redisUrl: process.env.REDIS_URL });

const res = await lb.generate({
  prompt: 'Hello!',
  // model: 'auto',              // default — balancer picks key+model
  // model: 'gemini-3.1-flash-lite',
  system: 'You are terse.',      // optional
  generationConfig: { temperature: 0.7 }, // optional
});

console.log(res.text);    // reply text
console.log(res.model);   // actual model used (resolved from 'auto')
console.log(res.keyId);   // which key served it

await lb.disconnect();
```

### 2. Vercel AI SDK

```ts
import { createGeminiLB } from 'gemini-lb';
import { generateText, streamText } from 'ai';

const lb = createGeminiLB({ redisUrl: process.env.REDIS_URL });

const { text } = await generateText({
  model: lb('gemini-3.1-flash-lite'),   // or lb('auto')
  prompt: 'Hello!',
});
```

## How requests are routed

- A Lua script atomically claims a **minute slot + daily slot** for the first
  key+model pair that has capacity under *its own* per-model limits.
- On **429**, the slot is released and the request retries with the next
  key (up to `maxRetries`, default 3).
- Every error is recorded in Redis (last 10 per key) for inspection.
- Deleting a key removes its counters too; other keys' stats are untouched
  (stable key IDs, not array indexes).

## API

| Method | Purpose |
|---|---|
| `lb.generate(opts)` | Raw Gemini call → `{ text, model, keyId, raw }` |
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
| `models` | `['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']` | Fallback models / auto order |
| `maxPerMinute` / `maxPerDay` | `15` / `500` | Fallback limits for keys without model config |
| `windowMs` | `60000` | Sliding window |
| `maxRetries` | `3` | Retries on 429 |
| `headers` / `fetch` / `name` | — | Custom headers / fetch / provider name |

Rate limits are **per key-per-model** and stored in Redis, so multiple
processes/servers sharing the same `REDIS_URL` share one global limit.
