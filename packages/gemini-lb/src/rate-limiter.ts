import Redis from 'ioredis';
import { KeyStore, StoredKey, StoredModel, maskKey } from './key-store';
import type { Provider } from './provider-config';

/**
 * Atomically find the first (key, model) candidate that has BOTH a minute
 * and a daily slot free, then claim both in one step.
 *
 * KEYS = [minKey1, dayKey1, dateKey1, cooldownKey1, ...]
 * ARGV = [now, windowMs, today, rpm1, dpm1, rpm2, dpm2, ...]
 * Returns: 1-based candidate index, or '0' if all exhausted.
 */
const RESERVE_SLOT = `
local n = math.floor(#KEYS / 4)
local now = ARGV[1]
local window_ms = tonumber(ARGV[2])
local today = ARGV[3]

for i = 0, n - 1 do
  local minKey = KEYS[4 * i + 1]
  local dayKey = KEYS[4 * i + 2]
  local dateKey = KEYS[4 * i + 3]
  local cooldownKey = KEYS[4 * i + 4]
  local rpm = tonumber(ARGV[4 + 2 * i])
  local dpm = tonumber(ARGV[5 + 2 * i])

  -- The cooldown check must be inside the atomic reservation. A pre-read
  -- from getEnabled() alone can race with a failure in another process.
  if redis.call('EXISTS', cooldownKey) == 0 then
    -- Trim old entries outside the sliding window
    local cutoff = tostring(tonumber(now) - window_ms)
    redis.call('ZREMRANGEBYSCORE', minKey, '-inf', cutoff)

    -- Roll the daily counter if the date changed
    if redis.call('GET', dateKey) ~= today then
      redis.call('SET', dateKey, today)
      redis.call('SET', dayKey, '0')
      redis.call('EXPIRE', dateKey, 86400 * 2)
      redis.call('EXPIRE', dayKey, 86400 * 2)
    end

    local minuteUsed = redis.call('ZCARD', minKey)
    local dayUsed = tonumber(redis.call('GET', dayKey) or '0')

    if minuteUsed < rpm and dayUsed < dpm then
      local reservation = now .. ':' .. tostring(math.random(1000000))
      redis.call('ZADD', minKey, now, reservation)
      redis.call('PEXPIRE', minKey, window_ms + 5000)
      redis.call('INCR', dayKey)
      redis.call('EXPIRE', dayKey, 86400 * 2)
      return { tostring(i + 1), reservation }
    end
  end
end

return { '0', '' }
`;

const RELEASE_MIN_SLOT = `
local key = KEYS[1]
local reservation = ARGV[1]
if reservation and reservation ~= '' then
  return tostring(redis.call('ZREM', key, reservation))
end
-- Backwards-compatible fallback for callers that do not have a token.
local entries = redis.call('ZREVRANGE', key, 0, 0)
if #entries > 0 then
  return tostring(redis.call('ZREM', key, entries[1]))
end
return '0'
`;

export interface RateLimiterConfig {
  redis: Redis;
  /** Redis-backed key store (dynamic — keys can be added/removed at runtime). */
  keyStore: KeyStore;
  /**
   * Models used for keys without their own model config (seeds/legacy),
   * and to order model preference in 'auto' mode.
   */
  fallbackModels?: StoredModel[];
  /** Sliding window size in ms. @default 60000 */
  windowMs?: number;
  maxLogSize?: number;
}

export interface KeySlot {
  /** Stable key identity — safe to use in Redis key names. */
  keyId: string;
  /** Position of the key in the current enabled list (display only). */
  keyIndex: number;
  apiKey: string;
  model: string;
  /** Upstream provider selected for this slot. */
  provider: Provider;
  /** Provider-specific API prefix. */
  baseUrl?: string;
  /** True when this slot came from a backup key. */
  backup: boolean;
  /** Exact Redis sorted-set member claimed for this request. */
  reservationId?: string;
}

export interface KeyStats {
  keyId: string;
  keyIndex: number;
  maskedKey: string;
  model: string;
  provider: Provider;
  baseUrl?: string;
  backup: boolean;
  maxPerMinute: number;
  maxPerDay: number;
  minuteUsed: number;
  minuteRemaining: number;
  dayUsed: number;
  dayRemaining: number;
}

export interface RequestLog {
  timestamp: string;
  keyId: string;
  keyIndex: number;
  maskedKey: string;
  model: string;
  backup: boolean;
  action: 'claimed' | 'released' | 'exhausted';
}

interface Candidate {
  key: StoredKey;
  model: StoredModel;
}

export class GeminiRateLimiter {
  private readonly redis: Redis;
  private readonly keyStore: KeyStore;
  private readonly fallbackModels: StoredModel[];
  private readonly windowMs: number;
  private readonly requestLog: RequestLog[] = [];
  private readonly maxLogSize: number;

  constructor(config: RateLimiterConfig) {
    this.redis = config.redis;
    this.keyStore = config.keyStore;
    this.fallbackModels = config.fallbackModels ?? [];
    this.windowMs = config.windowMs ?? 60_000;
    this.maxLogSize = config.maxLogSize ?? 1000;
  }

  /** A key's own models, or the fallback list if it has none configured. */
  private modelsFor(key: StoredKey): StoredModel[] {
    return key.models.length > 0 ? key.models : this.fallbackModels;
  }

  private minKey(keyId: string, model: string): string {
    return `gemini-lb:key:${keyId}:${model}:min`;
  }

  private dayKey(keyId: string, model: string): string {
    return `gemini-lb:key:${keyId}:${model}:day`;
  }

  private dayDateKey(keyId: string, model: string): string {
    return `gemini-lb:key:${keyId}:${model}:dayDate`;
  }

  private log(
    key: StoredKey,
    keyIndex: number,
    model: string,
    action: RequestLog['action'],
  ): void {
    const entry: RequestLog = {
      timestamp: new Date().toISOString(),
      keyId: key.id,
      keyIndex,
      maskedKey: maskKey(key.key),
      model,
      backup: key.backup === true,
      action,
    };
    this.requestLog.push(entry);
    if (this.requestLog.length > this.maxLogSize) {
      this.requestLog.shift();
    }
  }

  /** All (key, model) candidates for one model. */
  private candidatesFor(enabled: StoredKey[], model: string): Candidate[] {
    const out: Candidate[] = [];
    for (const key of enabled) {
      const em = this.modelsFor(key).find((m) => m.id === model);
      if (em) out.push({ key, model: em });
    }
    return out;
  }

  /**
   * Model order for 'auto': fallback model order first (user preference),
   * then any other models configured on keys.
   */
  private autoModelOrder(enabled: StoredKey[]): string[] {
    const available = new Set<string>();
    for (const key of enabled) {
      for (const m of this.modelsFor(key)) available.add(m.id);
    }
    const order: string[] = [];
    for (const m of this.fallbackModels) {
      if (available.has(m.id) && !order.includes(m.id)) order.push(m.id);
    }
    for (const id of available) {
      if (!order.includes(id)) order.push(id);
    }
    return order;
  }

  /**
   * Atomically find a key+model with capacity (per-model limits) and claim
   * both the minute and daily slot. Returns null if all keys are exhausted.
   *
   * `excludedSlots` contains `${keyId}\\0${model}` pairs already tried by a
   * retry loop. Excluding the pair (rather than just the key) lets `auto`
   * mode try another model on the same key while preventing a 429 retry from
   * selecting the same key+model again. Normal routing excludes backup keys;
   * pass `role: 'backup'` to select a backup candidate.
   */
  async reserveMinuteSlot(
    requestedModel: string | 'auto',
    excludedSlots: ReadonlySet<string> = new Set(),
    options: { role?: 'normal' | 'backup' } = {},
  ): Promise<KeySlot | null> {
    const role = options.role ?? 'normal';
    const enabled = await this.keyStore.getEnabled({ role });
    if (enabled.length === 0) return null;

    const now = Date.now().toString();
    const today = new Date().toISOString().slice(0, 10);

    const modelOrder =
      requestedModel === 'auto' ? this.autoModelOrder(enabled) : [requestedModel];

    for (const model of modelOrder) {
      const candidates = this.candidatesFor(enabled, model).filter(
        (candidate) => !excludedSlots.has(`${candidate.key.id}\u0000${model}`),
      );
      if (candidates.length === 0) continue;

      const redisKeys: string[] = [];
      const argv: string[] = [now, this.windowMs.toString(), today];

      for (const c of candidates) {
        redisKeys.push(
          this.minKey(c.key.id, model),
          this.dayKey(c.key.id, model),
          this.dayDateKey(c.key.id, model),
          this.keyStore.cooldownKeyFor(c.key.id),
        );
        argv.push(
          c.model.maxPerMinute.toString(),
          c.model.maxPerDay.toString(),
        );
      }

      const result = (await this.redis.eval(
        RESERVE_SLOT,
        redisKeys.length,
        ...redisKeys,
        ...argv,
      )) as string | string[];

      const idx = Array.isArray(result)
        ? parseInt(result[0] ?? '0', 10)
        : parseInt(result, 10);
      const reservationId = Array.isArray(result) ? result[1] : undefined;
      if (idx > 0) {
        const c = candidates[idx - 1];
        const keyIndex = enabled.indexOf(c.key);
        this.log(c.key, keyIndex, model, 'claimed');
        return {
          keyId: c.key.id,
          keyIndex,
          apiKey: c.key.key,
          model,
          provider: c.key.provider ?? 'google',
          baseUrl: c.key.baseUrl,
          backup: c.key.backup === true,
          reservationId,
        };
      }
    }

    // Log exhaustion for configured (key, model) pairs not already tried.
    for (let i = 0; i < enabled.length; i++) {
      for (const m of this.modelsFor(enabled[i])) {
        if (!excludedSlots.has(`${enabled[i].id}\u0000${m.id}`)) {
          this.log(enabled[i], i, m.id, 'exhausted');
        }
      }
    }

    return null;
  }

  /**
   * Release a minute slot on 429 (the request failed).
   */
  async releaseOnFailure(
    keyId: string,
    model: string,
    reservationId?: string,
  ): Promise<void> {
    const key = this.minKey(keyId, model);
    await this.redis.eval(RELEASE_MIN_SLOT, 1, key, reservationId ?? '');
    const enabled = await this.keyStore.getEnabled();
    const index = enabled.findIndex((k) => k.id === keyId);
    if (index >= 0) {
      this.log(enabled[index], index, model, 'released');
    }
  }

  /** Put a failed key in a shared cooldown window. */
  async cooldown(keyId: string, durationMs?: number): Promise<void> {
    await this.keyStore.setCooldown(keyId, durationMs);
  }

  /**
   * Get current usage stats for monitoring (all keys, including disabled),
   * using each key-model's own limits.
   */
  async getStats(): Promise<KeyStats[]> {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const stats: KeyStats[] = [];
    const keys = await this.keyStore.list();

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      for (const m of this.modelsFor(key)) {
        const cutoff = (now - this.windowMs).toString();
        const minCount = await this.redis.zcount(this.minKey(key.id, m.id), cutoff, '+inf');
        const dayRaw = await this.redis.get(this.dayKey(key.id, m.id));
        const dayDate = await this.redis.get(this.dayDateKey(key.id, m.id));
        const dayUsed = dayDate === today ? parseInt(dayRaw || '0', 10) : 0;

        stats.push({
          keyId: key.id,
          keyIndex: i,
          maskedKey: maskKey(key.key),
          model: m.id,
          provider: key.provider ?? 'google',
          baseUrl: key.baseUrl,
          backup: key.backup === true,
          maxPerMinute: m.maxPerMinute,
          maxPerDay: m.maxPerDay,
          minuteUsed: minCount,
          minuteRemaining: Math.max(0, m.maxPerMinute - minCount),
          dayUsed,
          dayRemaining: Math.max(0, m.maxPerDay - dayUsed),
        });
      }
    }

    return stats;
  }

  /**
   * Get the in-memory request log (per process).
   */
  getRequestLog(): RequestLog[] {
    return [...this.requestLog];
  }
}
