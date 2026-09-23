import { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createGoogle, type GoogleProvider } from '@ai-sdk/google';
import { KeySelector } from './key-selector';
import { KeySlot } from './rate-limiter';
import { KeyErrorLog } from './error-log';

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
  private readonly providerCache = new Map<string, GoogleProvider>();

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

  private getGoogleProvider(apiKey: string): GoogleProvider {
    if (!this.providerCache.has(apiKey)) {
      this.providerCache.set(
        apiKey,
        createGoogle({
          apiKey,
          headers: this.defaultHeaders,
          fetch: this.fetch,
        }),
      );
    }
    return this.providerCache.get(apiKey)!;
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

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const slot = await this.keySelector.select(this.modelId);
      if (!slot) {
        throw new Error(
          `[gemini-lb] All API keys exhausted for model "${this.modelId}". ` +
          `Try again later or add more keys.`,
        );
      }

      try {
        return await fn(slot);
      } catch (error) {
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
    return this.executeWithRetry(async (slot) => {
      const googleProvider = this.getGoogleProvider(slot.apiKey);
      const model = googleProvider(slot.model);
      return model.doGenerate(options);
    });
  }

  async doStream(options: LanguageModelV4CallOptions) {
    return this.executeWithRetry(async (slot) => {
      const googleProvider = this.getGoogleProvider(slot.apiKey);
      const model = googleProvider(slot.model);
      return model.doStream(options);
    });
  }

  get supportedUrls() {
    return {
      'image/*': [/^https:\/\/generativelanguage\.googleapis\.com\/.*/],
      'video/*': [/^https:\/\/generativelanguage\.googleapis\.com\/.*/],
      'audio/*': [/^https:\/\/generativelanguage\.googleapis\.com\/.*/],
      'application/pdf': [/^https:\/\/generativelanguage\.googleapis\.com\/.*/],
    };
  }
}
