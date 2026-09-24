import express, { NextFunction, Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Server } from 'http';
import Redis from 'ioredis';
import {
  createRedis,
  KeyStore,
  maskKey,
  normalizeModels,
  DEFAULT_MAX_PER_MINUTE,
  DEFAULT_MAX_PER_DAY,
  KeyErrorLog,
  GeminiRateLimiter,
  type StoredKey,
  normalizeProvider,
  normalizeBaseUrl,
  TOKEN_HARBOR_BASE_URL,
  type Provider,
} from 'gemini-lb';
import { DASHBOARD_HTML } from './html';

export interface DashboardOptions {
  /** Redis URL (defaults to process.env.REDIS_URL, then local Redis). */
  redisUrl?: string;
  /** Reuse an existing connection instead of creating one. */
  redis?: Redis;
  /** @default process.env.DASHBOARD_PORT || 4870 */
  port?: number;
  /** Bind address @default 127.0.0.1 (use 0.0.0.0 to expose) */
  host?: string;
  /** @default process.env.DASHBOARD_PASSWORD (required) */
  password?: string;
}

export interface DashboardHandle {
  port: number;
  host: string;
  close(): Promise<void>;
}

interface Defaults {
  models: string[];
  maxPerMinute: number;
  maxPerDay: number;
  windowMs: number;
}

const CONFIG_KEY = 'gemini-lb:config';

const DEFAULT_LIMITS: Defaults = {
  models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
  maxPerMinute: DEFAULT_MAX_PER_MINUTE,
  maxPerDay: DEFAULT_MAX_PER_DAY,
  windowMs: 60_000,
};

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read published dashboard defaults when available. The fallback keeps the
 * dashboard useful even when no provider process has written a config yet.
 */
async function readDefaults(redis: Redis): Promise<Defaults> {
  try {
    const raw = await redis.get(CONFIG_KEY);
    if (raw) return { ...DEFAULT_LIMITS, ...JSON.parse(raw) };
  } catch {
    // fall through to defaults
  }
  return DEFAULT_LIMITS;
}

function publicKey(k: StoredKey) {
  const provider = k.provider ?? 'google';
  return {
    id: k.id,
    masked: maskKey(k.key),
    account: k.account,
    project: k.project,
    provider,
    baseUrl:
      k.baseUrl ||
      (provider === 'tokenharbor' ? TOKEN_HARBOR_BASE_URL : undefined),
    models: k.models,
    enabled: k.enabled,
    createdAt: k.createdAt,
  };
}

function providerFromRequest(value: unknown): Provider {
  try {
    return normalizeProvider(value);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

/** Catch the most common dashboard mistake before sending a key to the wrong API. */
function providerKeyMismatch(provider: Provider, key: string): string | undefined {
  const normalized = key.trim().toLowerCase();
  if (provider === 'google' && normalized.startsWith('thk_')) {
    return 'This looks like a Token Harbor key. Select the Token Harbor provider instead of Google Gemini.';
  }
  if (provider === 'tokenharbor' && normalized.startsWith('aiza')) {
    return 'This looks like a Google Gemini key. Select the Google Gemini provider instead of Token Harbor.';
  }
  return undefined;
}

/** Wrap async handlers so rejections reach the error middleware (Express 5-friendly). */
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export async function startDashboard(
  options: DashboardOptions = {},
): Promise<DashboardHandle> {
  const password = options.password ?? process.env.DASHBOARD_PASSWORD;
  if (!password) {
    throw new Error(
      '[dashboard] No password set. Add DASHBOARD_PASSWORD=... to your .env file.',
    );
  }

  const port = options.port ?? Number(process.env.DASHBOARD_PORT ?? 4870);
  const host = options.host ?? process.env.DASHBOARD_HOST ?? '127.0.0.1';

  let redis: Redis;
  let ownRedis = false;
  if (options.redis) {
    redis = options.redis;
  } else {
    const conn = createRedis(options.redisUrl ?? process.env.REDIS_URL);
    redis = conn.redis;
    ownRedis = conn.owned;
  }

  const keyStore = new KeyStore(redis);
  const errorLog = new KeyErrorLog(redis);
  const defaults = await readDefaults(redis);
  const rateLimiter = new GeminiRateLimiter({
    redis,
    keyStore,
    fallbackModels: defaults.models.map((id) => ({
      id,
      maxPerMinute: defaults.maxPerMinute,
      maxPerDay: defaults.maxPerDay,
    })),
    windowMs: defaults.windowMs,
  });

  // ── Auth ──────────────────────────────────────────────────────────────
  const passwordHash = createHash('sha256').update(password).digest();
  const tokens = new Map<string, number>();

  function isValidToken(token?: string): boolean {
    if (!token) return false;
    const expires = tokens.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      tokens.delete(token);
      return false;
    }
    return true;
  }

  function cookieToken(req: Request): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    const match = raw.match(/(?:^|;\s*)glb_token=([^;]+)/);
    return match?.[1];
  }

  // ── App ───────────────────────────────────────────────────────────────
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.post(
    '/api/login',
    h(async (req, res) => {
      const attempt = createHash('sha256')
        .update(String(req.body?.password ?? ''))
        .digest();
      if (!timingSafeEqual(attempt, passwordHash)) {
        res.status(401).json({ error: 'Wrong password' });
        return;
      }
      const token = randomBytes(24).toString('hex');
      tokens.set(token, Date.now() + TOKEN_TTL_MS);
      res.setHeader(
        'Set-Cookie',
        `glb_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_MS / 1000}`,
      );
      res.json({ ok: true });
    }),
  );

  // Everything below requires auth (login is handled above).
  app.use('/api', (req, res, next) => {
    if (req.path === '/login') return next();
    if (!isValidToken(cookieToken(req))) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  app.post(
    '/api/logout',
    h(async (req, res) => {
      const token = cookieToken(req);
      if (token) tokens.delete(token);
      res.setHeader('Set-Cookie', 'glb_token=; HttpOnly; Path=/; Max-Age=0');
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/overview',
    h(async (_req, res) => {
      const [keys, stats, freshDefaults] = await Promise.all([
        keyStore.list(),
        rateLimiter.getStats(),
        readDefaults(redis),
      ]);
      const errors = await errorLog.getMany(keys.map((k) => k.id));
      res.json({
        keys: keys.map(publicKey),
        stats,
        errors,
        defaults: freshDefaults,
      });
    }),
  );

  app.post(
    '/api/keys',
    h(async (req, res) => {
      const key = String(req.body?.key ?? '').trim();
      let account = String(req.body?.account ?? '').trim();
      let project = String(req.body?.project ?? '').trim();
      const models = normalizeModels(req.body?.models);

      let provider: Provider;
      let baseUrl: string | undefined;
      try {
        provider = providerFromRequest(req.body?.provider);
        baseUrl = normalizeBaseUrl(
          provider,
          req.body?.baseUrl ?? req.body?.baseURL,
        );
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      // Token Harbor universal keys do not have a vendor account/project;
      // give those entries useful dashboard labels when the fields are blank.
      if (provider === 'tokenharbor') {
        account ||= 'Token Harbor';
        project ||= 'Universal';
      }

      const keyMismatch = providerKeyMismatch(provider, key);
      if (keyMismatch) {
        res.status(400).json({ error: keyMismatch });
        return;
      }

      if (!account) {
        res.status(400).json({ error: 'account is required' });
        return;
      }
      if (!project) {
        res.status(400).json({ error: 'project is required' });
        return;
      }
      if (!key) {
        res.status(400).json({ error: 'key is required' });
        return;
      }
      if (models.length === 0) {
        res.status(400).json({ error: 'at least one model is required' });
        return;
      }

      const entry = await keyStore.add(key, {
        account,
        project,
        provider,
        baseUrl,
        models,
      });
      res.status(201).json(publicKey(entry));
    }),
  );

  app.patch(
    '/api/keys/:id',
    h(async (req, res) => {
      const {
        key,
        account,
        project,
        provider,
        baseUrl: requestedBaseUrl,
        baseURL,
        enabled,
        models,
      } = req.body ?? {};
      const id = String(req.params.id);
      const existing = await keyStore.get(id);
      if (!existing) {
        res.status(404).json({ error: 'key not found' });
        return;
      }

      const patch: {
        key?: string;
        account?: string;
        project?: string;
        provider?: Provider;
        baseUrl?: string;
        enabled?: boolean;
        models?: StoredKey['models'];
      } = {};

      if (typeof key === 'string') patch.key = key;
      if (typeof account === 'string') patch.account = account;
      if (typeof project === 'string') patch.project = project;
      if (typeof enabled === 'boolean') patch.enabled = enabled;

      if (provider !== undefined) {
        try {
          patch.provider = providerFromRequest(provider);
        } catch (error) {
          res.status(400).json({
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }

      const suppliedBaseUrl = requestedBaseUrl ?? baseURL;
      if (suppliedBaseUrl !== undefined) {
        if (typeof suppliedBaseUrl !== 'string') {
          res.status(400).json({ error: 'base URL must be a string' });
          return;
        }
        try {
          patch.baseUrl = normalizeBaseUrl(
            patch.provider ?? existing.provider,
            suppliedBaseUrl,
          );
        } catch (error) {
          res.status(400).json({
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }

      const effectiveProvider = patch.provider ?? existing.provider;
      if (typeof key === 'string') {
        const keyMismatch = providerKeyMismatch(effectiveProvider, key);
        if (keyMismatch) {
          res.status(400).json({ error: keyMismatch });
          return;
        }
      }
      if (effectiveProvider === 'tokenharbor') {
        if (patch.account !== undefined && !patch.account.trim()) {
          patch.account = 'Token Harbor';
        }
        if (patch.project !== undefined && !patch.project.trim()) {
          patch.project = 'Universal';
        }
      }

      if (models !== undefined) {
        const normalized = normalizeModels(models);
        if (normalized.length === 0) {
          res.status(400).json({ error: 'at least one model is required' });
          return;
        }
        patch.models = normalized;
      }

      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'nothing to update' });
        return;
      }
      if (patch.account !== undefined && !patch.account.trim()) {
        res.status(400).json({ error: 'account cannot be empty' });
        return;
      }
      if (patch.project !== undefined && !patch.project.trim()) {
        res.status(400).json({ error: 'project cannot be empty' });
        return;
      }

      const updated = await keyStore.update(id, patch);
      if (!updated) {
        res.status(404).json({ error: 'key not found' });
        return;
      }
      res.json(publicKey(updated));
    }),
  );

  app.delete(
    '/api/keys/:id',
    h(async (req, res) => {
      const removed = await keyStore.remove(String(req.params.id));
      if (!removed) {
        res.status(404).json({ error: 'key not found' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.get('/', (_req, res) => {
    res.type('html').send(DASHBOARD_HTML);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[dashboard]', message);
    res.status(500).json({ error: message });
  });

  // ── Listen ────────────────────────────────────────────────────────────
  // NOTE: don't pass the callback to app.listen() — Express also invokes it
  // on 'error' (e.g. EADDRINUSE), which would resolve with a non-listening
  // server and hide the real error. Use the events directly instead.
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

  const actualPort = (server.address() as { port: number }).port;

  return {
    port: actualPort,
    host,
    async close() {
      tokens.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownRedis) await redis.quit();
    },
  };
}
