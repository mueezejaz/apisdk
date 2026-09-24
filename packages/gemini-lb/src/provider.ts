import Redis from 'ioredis';
import { ProviderV4 } from '@ai-sdk/provider';
import { createRedis } from './redis';
import {
  KeyStore,
  StoredModel,
  DEFAULT_MAX_PER_MINUTE,
  DEFAULT_MAX_PER_DAY,
} from './key-store';
import { KeyErrorLog } from './error-log';
import { GeminiRateLimiter, KeyStats, RequestLog } from './rate-limiter';
import { KeySelector } from './key-selector';
import { GeminiLBLanguageModel } from './gemini-lb-language-model';
import { GeminiRawClient, RawGenerateOptions, RawGenerateResult } from './raw';
import {
  normalizeBaseUrl,
  normalizeProvider,
  type Provider,
} from './provider-config';

export interface GeminiLBProviderSettings {
  /**
   * Seed API keys — persisted to Redis on first run (never overwrites
   * keys already stored there). Once seeded, manage keys in Redis
   * directly; this option becomes optional.
   */
  keys?: string[];

  /** Provider assigned to seeded keys when no per-key metadata is available. @default 'google' */
  defaultProvider?: Provider;

  /** Base URL assigned to seeded Token Harbor keys. @default Token Harbor /v1 */
  defaultBaseUrl?: string;

  /**
   * Redis connection URL or instance. Keys and rate-limit state live here.
   */
  redisUrl?: string;
  redis?: Redis;

  /**
   * Fallback models (also used to seed keys and order 'auto' mode).
   * Each key's own model config in Redis takes priority.
   * @default Google models, or ['th-orchestra'] when defaultProvider is Token Harbor
   */
  models?: string[];

  /**
   * Fallback max requests per minute (keys without per-model config).
   * @default 15
   */
  maxPerMinute?: number;

  /**
   * Fallback max requests per day (keys without per-model config).
   * @default 500
   */
  maxPerDay?: number;

  /**
   * Sliding window size in milliseconds.
   * @default 60000 (1 minute)
   */
  windowMs?: number;

  /**
   * Max retries on 429 errors.
   * @default 3
   */
  maxRetries?: number;

  /**
   * Custom headers to include in requests.
   */
  headers?: Record<string, string | undefined>;

  /**
   * Custom fetch implementation.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Custom provider name.
   * @default 'gemini-lb'
   */
  name?: string;
}

export interface GeminiLBProvider extends ProviderV4 {
  (modelId: string): GeminiLBLanguageModel;
  languageModel(modelId: string): GeminiLBLanguageModel;
  chat(modelId: string): GeminiLBLanguageModel;
  chatModel(modelId: string): GeminiLBLanguageModel;

  /**
   * Direct provider API call (no AI SDK needed): picks a key+model slot,
   * calls Google Gemini or Token Harbor, releases the slot and retries on 429.
   *
   *   const res = await lb.generate({ prompt: 'Hi' });   // model: 'auto'
   *   res.text; res.model; res.keyId; res.raw;
   */
  generate(options: RawGenerateOptions): Promise<RawGenerateResult>;

  /** Per-key / per-model usage stats (read from Redis). */
  getStats(): Promise<KeyStats[]>;
  /** In-memory request log of this process. */
  getRequestLog(): RequestLog[];
  /** The Redis-backed key store (list/add/update/remove keys). */
  getKeyStore(): KeyStore;
  /** Close the Redis connection if this provider created it. */
  disconnect(): Promise<void>;
}

export function createGeminiLB(
  settings: GeminiLBProviderSettings,
): GeminiLBProvider {
  let redis: Redis;
  let ownRedis = false;

  if (settings.redis) {
    redis = settings.redis;
  } else {
    const conn = createRedis(settings.redisUrl);
    redis = conn.redis;
    ownRedis = conn.owned;
  }

  const defaultProvider = normalizeProvider(settings.defaultProvider);
  const defaultModelIds =
    settings.models ??
    (defaultProvider === 'tokenharbor'
      ? ['th-orchestra']
      : ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
  const maxPerMinute = settings.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
  const maxPerDay = settings.maxPerDay ?? DEFAULT_MAX_PER_DAY;

  const fallbackModels: StoredModel[] = defaultModelIds.map((id) => ({
    id,
    maxPerMinute,
    maxPerDay,
  }));

  const defaultBaseUrl = normalizeBaseUrl(defaultProvider, settings.defaultBaseUrl);
  const keyStore = new KeyStore(redis, {
    initialKeys: settings.keys,
    defaultModels: fallbackModels,
    defaultProvider,
    defaultBaseUrl,
  });
  const errorLog = new KeyErrorLog(redis);

  const rateLimiter = new GeminiRateLimiter({
    redis,
    keyStore,
    fallbackModels,
    windowMs: settings.windowMs,
  });

  const keySelector = new KeySelector({
    rateLimiter,
    maxRetries: settings.maxRetries,
  });

  const rawClient = new GeminiRawClient({
    keySelector,
    errorLog,
    fetch: settings.fetch,
    defaultHeaders: settings.headers,
  });

  const providerName = settings.name ?? 'gemini-lb';

  function createModel(modelId: string): GeminiLBLanguageModel {
    return new GeminiLBLanguageModel(modelId, {
      provider: providerName,
      keySelector,
      errorLog,
      defaultHeaders: settings.headers,
      fetch: settings.fetch,
    });
  }

  const provider = function (modelId: string) {
    if (new.target) {
      throw new Error(
        'The gemini-lb provider factory function cannot be called with the new keyword.',
      );
    }
    return createModel(modelId);
  } as GeminiLBProvider;

  Object.assign(provider, { specificationVersion: 'v4' as const });
  provider.languageModel = createModel;
  provider.chat = createModel;
  provider.chatModel = createModel;
  provider.embeddingModel = () => {
    throw new Error('gemini-lb does not provide embedding models');
  };
  provider.imageModel = () => {
    throw new Error('gemini-lb does not provide image models');
  };
  provider.generate = (options) => rawClient.generate(options);
  provider.getStats = () => rateLimiter.getStats();
  provider.getRequestLog = () => rateLimiter.getRequestLog();
  provider.getKeyStore = () => keyStore;
  provider.disconnect = async () => {
    if (ownRedis) {
      await redis.quit();
    }
  };

  return provider;
}
