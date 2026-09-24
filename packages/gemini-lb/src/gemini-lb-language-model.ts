import {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider';
import { createGoogle, type GoogleProvider } from '@ai-sdk/google';
import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from '@ai-sdk/openai-compatible';
import { KeySelector } from './key-selector';
import { KeySlot } from './rate-limiter';
import { KeyErrorLog } from './error-log';
import {
  GOOGLE_BASE_URL,
  TOKEN_HARBOR_BASE_URL,
} from './provider-config';

export interface GeminiLBLanguageModelConfig {
  provider: string;
  keySelector: KeySelector;
  errorLog?: KeyErrorLog;
  defaultHeaders?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
}

function extractStatus(error: unknown): number | undefined {
  if (error instanceof Response) return error.status;
  const e = error as { statusCode?: unknown; status?: unknown };
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.status === 'number') return e.status;
  return undefined;
}

export class GeminiLBLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider: string;
  readonly modelId: string;

  private readonly keySelector: KeySelector;
  private readonly errorLog?: KeyErrorLog;
  private readonly defaultHeaders?: Record<string, string | undefined>;
  private readonly fetch?: typeof globalThis.fetch;
  private readonly googleProviderCache = new Map<string, GoogleProvider>();
  private readonly openAIProviderCache = new Map<
    string,
    OpenAICompatibleProvider
  >();

  private definedHeaders(blocked: string[] = []): Record<string, string> {
    const blockedNames = new Set(blocked.map((name) => name.toLowerCase()));
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.defaultHeaders ?? {})) {
      if (value !== undefined && !blockedNames.has(key.toLowerCase())) {
        out[key] = value;
      }
    }
    return out;
  }

  constructor(
    modelId: string,
    config: GeminiLBLanguageModelConfig,
  ) {
    this.provider = config.provider;
    this.modelId = modelId;
    this.keySelector = config.keySelector;
    this.errorLog = config.errorLog;
    this.defaultHeaders = config.defaultHeaders;
    this.fetch = config.fetch;
  }

  private getGoogleProvider(apiKey: string, baseUrl?: string): GoogleProvider {
    const resolvedBaseUrl = baseUrl ?? GOOGLE_BASE_URL;
    const cacheKey = `${apiKey}\u0000${resolvedBaseUrl}`;
    if (!this.googleProviderCache.has(cacheKey)) {
      this.googleProviderCache.set(
        cacheKey,
        createGoogle({
          apiKey,
          baseURL: resolvedBaseUrl,
          headers: this.definedHeaders(['x-goog-api-key']),
          fetch: this.fetch,
        }),
      );
    }
    return this.googleProviderCache.get(cacheKey)!;
  }

  private getOpenAIProvider(apiKey: string, baseUrl?: string): OpenAICompatibleProvider {
    const resolvedBaseUrl = baseUrl ?? TOKEN_HARBOR_BASE_URL;
    const cacheKey = `${apiKey}\u0000${resolvedBaseUrl}`;
    if (!this.openAIProviderCache.has(cacheKey)) {
      this.openAIProviderCache.set(
        cacheKey,
        createOpenAICompatible({
          name: 'tokenharbor',
          baseURL: resolvedBaseUrl,
          apiKey,
          headers: this.definedHeaders(['authorization']),
          fetch: this.fetch,
        }),
      );
    }
    return this.openAIProviderCache.get(cacheKey)!;
  }

  private getModelForSlot(slot: KeySlot): LanguageModelV4 {
    if (slot.provider === 'tokenharbor') {
      return this.getOpenAIProvider(slot.apiKey, slot.baseUrl)(slot.model);
    }
    return this.getGoogleProvider(slot.apiKey, slot.baseUrl)(slot.model);
  }

  private optionsForSlot(
    slot: KeySlot,
    options: LanguageModelV4CallOptions,
  ): LanguageModelV4CallOptions {
    if (!options.headers) return options;
    const blocked = slot.provider === 'tokenharbor'
      ? new Set(['authorization'])
      : new Set(['x-goog-api-key']);
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(options.headers)) {
      if (!blocked.has(key.toLowerCase())) headers[key] = value;
    }
    return { ...options, headers };
  }

  private recordError(slot: KeySlot, error: unknown): void {
    if (!this.errorLog) return;
    // Fire-and-forget: recording must never affect the request path.
    void this.errorLog.record(slot.keyId, {
      status: extractStatus(error),
      message: error instanceof Error ? error.message : String(error),
      model: slot.model,
    });
  }

  private async executeWithRetry<T>(
    fn: (slot: KeySlot) => Promise<T>,
  ): Promise<T> {
    const maxRetries = this.keySelector.getRetryLimit();
    let lastError: unknown;
    const triedSlots = new Set<string>();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const slot = triedSlots.size === 0
        ? await this.keySelector.select(this.modelId)
        : await this.keySelector.select(this.modelId, triedSlots);
      if (!slot) {
        if (lastError) throw lastError;
        throw new Error(
          `[gemini-lb] All API keys exhausted for model "${this.modelId}". ` +
          `Try again later or add more keys.`,
        );
      }

      try {
        return await fn(slot);
      } catch (error) {
        triedSlots.add(`${slot.keyId}\u0000${slot.model}`);
        lastError = error;
        this.recordError(slot, error);
        // Release the slot on failure so it can be retried
        await this.keySelector.release(slot);

        // If it's a 429, try the next key
        const status = extractStatus(error);
        const is429 = status === 429;

        if (!is429) {
          // Non-rate-limit error — don't retry, throw immediately
          throw error;
        }

        // If this was the last attempt, throw
        if (attempt === maxRetries) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    return this.executeWithRetry(async (slot) =>
      this.getModelForSlot(slot).doGenerate(this.optionsForSlot(slot, options)),
    );
  }

  async doStream(options: LanguageModelV4CallOptions) {
    return this.executeWithRetry(async (slot) =>
      this.getModelForSlot(slot).doStream(this.optionsForSlot(slot, options)),
    );
  }

  get supportedUrls() {
    // Keep the native Google URL behavior for existing Google keys. Other
    // upstreams (including custom Token Harbor-compatible gateways) are left
    // unlisted so the AI SDK downloads remote inputs instead of assuming that
    // a URL is supported by every provider behind this load balancer.
    const google = /^https:\/\/generativelanguage\.googleapis\.com\/.*/;
    const tokenHarbor = /^https:\/\/tokenharbor\.ai\/.*/;
    return {
      'image/*': [google, tokenHarbor],
      'video/*': [google, tokenHarbor],
      'audio/*': [google, tokenHarbor],
      'application/pdf': [google, tokenHarbor],
    };
  }
}
