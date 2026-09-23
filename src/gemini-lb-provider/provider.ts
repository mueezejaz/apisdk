import Redis from 'ioredis';
import { ProviderV4 } from '@ai-sdk/provider';
import { createRedis } from './redis';
import { KeyStore, StoredModel, DEFAULT_MAX_PER_MINUTE, DEFAULT_MAX_PER_DAY } from './key-store';
import { KeyErrorLog } from './error-log';
import { GeminiRateLimiter } from './rate-limiter';
import { KeySelector } from './key-selector';
import { GeminiLBLanguageModel } from './gemini-lb-language-model';

export interface GeminiLBProviderSettings {
  /**
   * Seed API keys — persisted to Redis on first run (never overwrites
   * keys already stored there). Seeded keys get `models` below as their
   * model config. Once seeded, manage everything via the dashboard.
   */
  keys?: string[];

  /**
   * Redis connection URL or instance.
   */
  redisUrl?: string;
  redis?: Redis;

  /**
   * Models assigned to seeded keys, and the fallback model order for
   * 'auto' mode. Each key's own model config (dashboard) takes priority.
   * @default ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']
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

interface GeminiLBProvider extends ProviderV4 {
  (modelId: string): GeminiLBLanguageModel;
  languageModel(modelId: string): GeminiLBLanguageModel;
  chat(modelId: string): GeminiLBLanguageModel;
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

  const defaultModelIds = settings.models ?? [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
  ];
  const maxPerMinute = settings.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
  const maxPerDay = settings.maxPerDay ?? DEFAULT_MAX_PER_DAY;

  const fallbackModels: StoredModel[] = defaultModelIds.map((id) => ({
    id,
    maxPerMinute,
    maxPerDay,
  }));

  const keyStore = new KeyStore(redis, {
    initialKeys: settings.keys,
    defaultModels: fallbackModels,
  });
  const errorLog = new KeyErrorLog(redis);

  // Publish defaults so the dashboard can prefill its add-key form
  // (and show the same fallback limits for legacy/seeded keys).
  void redis
    .set(
      'gemini-lb:config',
      JSON.stringify({
        models: defaultModelIds,
        maxPerMinute,
        maxPerDay,
        windowMs: settings.windowMs ?? 60_000,
      }),
    )
    .catch(() => {});

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

  provider.languageModel = createModel;
  provider.chat = createModel;

  // Attach utility methods
  (provider as any).getStats = () => rateLimiter.getStats();
  (provider as any).getRequestLog = () => rateLimiter.getRequestLog();
  (provider as any).getErrors = () => errorLog;
  (provider as any).getKeyStore = () => keyStore;
  (provider as any).disconnect = async () => {
    if (ownRedis) {
      await redis.quit();
    }
  };

  return provider;
}
