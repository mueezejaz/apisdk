import Redis from 'ioredis';

export interface RedisConnection {
  redis: Redis;
  /** True if this factory created the connection (caller must quit it). */
  owned: boolean;
}

/**
 * Create a Redis connection from a URL, with automatic TLS for Upstash.
 * If no URL is given, connects to a local Redis instance.
 */
export function createRedis(redisUrl?: string): RedisConnection {
  if (!redisUrl) {
    return { redis: new Redis(), owned: true };
  }

  const isUpstash = redisUrl.includes('upstash');
  const redis = new Redis(redisUrl, {
    tls: isUpstash ? { rejectUnauthorized: false } : undefined,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  return { redis, owned: true };
}
