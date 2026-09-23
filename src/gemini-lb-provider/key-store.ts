import { createHash } from 'crypto';
import Redis from 'ioredis';

const KEYS_HASH = 'gemini-lb:keys';

export const DEFAULT_MAX_PER_MINUTE = 15;
export const DEFAULT_MAX_PER_DAY = 500;

/** A model configured for one API key, with its own limits. */
export interface StoredModel {
  /** Model id, e.g. 'gemini-3.1-flash-lite'. */
  id: string;
  maxPerMinute: number;
  maxPerDay: number;
}

/**
 * An API key belonging to an account/project, with one or more models.
 * Hierarchy: Account → Project → Key → Models[]
 */
export interface StoredKey {
  /** Stable ID derived from the key value — never shifts when other keys change. */
  id: string;
  key: string;
  account: string;
  project: string;
  models: StoredModel[];
  enabled: boolean;
  createdAt: string;
}

export interface KeyStoreOptions {
  /** How long the in-memory cache may serve stale data (ms). @default 1000 */
  cacheTtlMs?: number;
  /** Raw key strings to seed on first use (persisted in the background). */
  initialKeys?: string[];
  /** Models assigned to seeded keys (and used as display fallback). */
  defaultModels?: StoredModel[];
}

export function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) return '****';
  return apiKey.slice(0, 4) + '****' + apiKey.slice(-4);
}

function keyId(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/** Validate/coerce a model list: trims ids, defaults limits, drops dupes/invalid rows. */
export function normalizeModels(input: unknown): StoredModel[] {
  if (!Array.isArray(input)) return [];
  const out: StoredModel[] = [];
  for (const row of input) {
    const id = String((row as any)?.id ?? '').trim();
    if (!id || out.some((m) => m.id === id)) continue;
    const maxPerMinute =
      Math.floor(Number((row as any)?.maxPerMinute)) || DEFAULT_MAX_PER_MINUTE;
    const maxPerDay =
      Math.floor(Number((row as any)?.maxPerDay)) || DEFAULT_MAX_PER_DAY;
    out.push({
      id,
      maxPerMinute: Math.max(1, maxPerMinute),
      maxPerDay: Math.max(1, maxPerDay),
    });
  }
  return out;
}

function parseEntry(raw: string): StoredKey | null {
  try {
    const e = JSON.parse(raw);
    if (!e || typeof e.id !== 'string' || typeof e.key !== 'string') return null;
    return {
      id: e.id,
      key: e.key,
      account: typeof e.account === 'string' ? e.account : '',
      project: typeof e.project === 'string' ? e.project : '',
      models: normalizeModels(e.models),
      enabled: e.enabled !== false,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
    };
  } catch {
    // corrupt entry — ignore
  }
  return null;
}

/**
 * Redis-backed API key storage with a short-lived in-memory cache.
 *
 * Keys live in the Redis hash `gemini-lb:keys`:
 *   field = stable key id (sha256 of the key, first 16 hex chars)
 *   value = JSON { id, key, account, project, models[], enabled, createdAt }
 *
 * The cache TTL (default 1s) means add/edit/delete from the dashboard
 * is picked up by running providers within ~1 second.
 */
export class KeyStore {
  private readonly redis: Redis;
  private readonly cacheTtlMs: number;
  private readonly defaultModels: StoredModel[];
  private cache: StoredKey[] | null = null;
  private cacheAt = 0;

  constructor(redis: Redis, options: KeyStoreOptions = {}) {
    this.redis = redis;
    this.cacheTtlMs = options.cacheTtlMs ?? 1000;
    this.defaultModels = options.defaultModels ?? [];

    if (options.initialKeys?.length) {
      const seeded = options.initialKeys
        .map((k) => k.trim())
        .filter(Boolean)
        .map<StoredKey>((k) => ({
          id: keyId(k),
          key: k,
          account: '',
          project: '',
          models: this.defaultModels,
          enabled: true,
          createdAt: new Date().toISOString(),
        }));
      this.cache = seeded;
      this.cacheAt = Date.now();
      void this.persistSeed(seeded).catch(() => {});
    }
  }

  /** All keys (enabled + disabled), account/project/createdAt order. */
  async list(): Promise<StoredKey[]> {
    if (this.cache && Date.now() - this.cacheAt < this.cacheTtlMs) {
      return this.cache;
    }

    const raw = await this.redis.hgetall(KEYS_HASH);
    const keys = Object.values(raw)
      .map(parseEntry)
      .filter((k): k is StoredKey => k !== null)
      .sort(
        (a, b) =>
          a.account.localeCompare(b.account) ||
          a.project.localeCompare(b.project) ||
          a.createdAt.localeCompare(b.createdAt),
      );

    this.cache = keys;
    this.cacheAt = Date.now();
    return keys;
  }

  /** Keys eligible for request routing. */
  async getEnabled(): Promise<StoredKey[]> {
    return (await this.list()).filter((k) => k.enabled);
  }

  async get(id: string): Promise<StoredKey | null> {
    return (await this.list()).find((k) => k.id === id) ?? null;
  }

  /**
   * Add a key. Adding the same key twice is a no-op (returns the existing entry).
   */
  async add(
    apiKey: string,
    details: {
      account: string;
      project: string;
      models: StoredModel[];
      label?: never;
    },
  ): Promise<StoredKey> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('API key is empty');

    const id = keyId(trimmed);
    const existing = await this.get(id);
    if (existing) return existing;

    const entry: StoredKey = {
      id,
      key: trimmed,
      account: details.account.trim(),
      project: details.project.trim(),
      models: normalizeModels(details.models),
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    await this.redis.hset(KEYS_HASH, id, JSON.stringify(entry));
    this.invalidate();
    return entry;
  }

  /**
   * Update account/project/label-less metadata, enable flag, models, or rotate the key value.
   * Rotating the value changes the key's identity (stats reset — correct,
   * since usage belongs to the old key value).
   */
  async update(
    id: string,
    patch: {
      key?: string;
      account?: string;
      project?: string;
      enabled?: boolean;
      models?: StoredModel[];
    },
  ): Promise<StoredKey | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    if (patch.key !== undefined && patch.key.trim() && patch.key.trim() !== existing.key) {
      // Rotation = remove old identity, add the new one (keeps account/project/models).
      await this.remove(id);
      const created = await this.add(patch.key, {
        account: patch.account ?? existing.account,
        project: patch.project ?? existing.project,
        models: patch.models ?? existing.models,
      });
      if (patch.enabled === false) {
        created.enabled = false;
        await this.redis.hset(KEYS_HASH, created.id, JSON.stringify(created));
        this.invalidate();
      }
      return created;
    }

    const next: StoredKey = { ...existing };
    if (patch.account !== undefined) next.account = patch.account.trim();
    if (patch.project !== undefined) next.project = patch.project.trim();
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.models !== undefined) next.models = normalizeModels(patch.models);

    await this.redis.hset(KEYS_HASH, id, JSON.stringify(next));
    this.invalidate();
    return next;
  }

  /** Delete a key and clean up all its Redis counters, logs, and errors. */
  async remove(id: string): Promise<boolean> {
    const removed = await this.redis.hdel(KEYS_HASH, id);
    await this.cleanupCounters(id);
    this.invalidate();
    return removed > 0;
  }

  /** Drop the in-memory cache (next read hits Redis). */
  invalidate(): void {
    this.cache = null;
    this.cacheAt = 0;
  }

  /** Persist seed keys without overwriting entries already managed in Redis. */
  private async persistSeed(entries: StoredKey[]): Promise<void> {
    for (const entry of entries) {
      await this.redis.hsetnx(KEYS_HASH, entry.id, JSON.stringify(entry));
    }
  }

  /**
   * Delete every Redis key belonging to this API key:
   * minute/daily counters, day markers, and the error log.
   * Uses SCAN so it doesn't need to know the model list.
   */
  private async cleanupCounters(id: string): Promise<void> {
    const pattern = `gemini-lb:key:${id}:*`;
    let cursor = '0';
    do {
      const [next, found] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (found.length) await this.redis.del(...found);
    } while (cursor !== '0');
  }
}
