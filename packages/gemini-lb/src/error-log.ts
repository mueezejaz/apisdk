import Redis from 'ioredis';

export interface KeyErrorEntry {
  /** ISO timestamp of the error. */
  ts: string;
  /** HTTP status code, if known (429, 401, 500, …). */
  status?: number;
  /** Truncated error message. */
  message: string;
  /** Model the request was targeting. */
  model: string;
}

/**
 * Stores the last N errors per API key in Redis:
 *   list `gemini-lb:key:{keyId}:errors`  (newest first, capped, 7-day TTL)
 *
 * Recording is fire-and-forget safe: it never throws, so a Redis hiccup
 * can't break an in-flight model request.
 */
export class KeyErrorLog {
  private readonly redis: Redis;
  private readonly max: number;
  private readonly ttlSeconds: number;

  constructor(redis: Redis, options: { max?: number; ttlDays?: number } = {}) {
    this.redis = redis;
    this.max = options.max ?? 10;
    this.ttlSeconds = (options.ttlDays ?? 7) * 86_400;
  }

  private listKey(keyId: string): string {
    return `gemini-lb:key:${keyId}:errors`;
  }

  async record(keyId: string, entry: Omit<KeyErrorEntry, 'ts'> & { ts?: string }): Promise<void> {
    try {
      const record: KeyErrorEntry = {
        ts: entry.ts ?? new Date().toISOString(),
        status: entry.status,
        message: entry.message.slice(0, 500),
        model: entry.model,
      };
      await this.redis
        .multi()
        .lpush(this.listKey(keyId), JSON.stringify(record))
        .ltrim(this.listKey(keyId), 0, this.max - 1)
        .expire(this.listKey(keyId), this.ttlSeconds)
        .exec();
    } catch {
      // Error logging must never break the request path.
    }
  }

  /** Last (up to `max`) errors for one key, newest first. */
  async get(keyId: string): Promise<KeyErrorEntry[]> {
    const raw = await this.redis.lrange(this.listKey(keyId), 0, this.max - 1);
    return raw
      .map((r) => {
        try {
          return JSON.parse(r) as KeyErrorEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is KeyErrorEntry => e !== null);
  }

  /** Errors for many keys at once: { keyId: [entries…] }. */
  async getMany(keyIds: string[]): Promise<Record<string, KeyErrorEntry[]>> {
    const result: Record<string, KeyErrorEntry[]> = {};
    await Promise.all(
      keyIds.map(async (id) => {
        result[id] = await this.get(id);
      }),
    );
    return result;
  }
}
