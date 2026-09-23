import { GeminiRateLimiter, KeySlot } from './rate-limiter';

export interface KeySelectorConfig {
  rateLimiter: GeminiRateLimiter;
  maxRetries?: number;
}

export class KeySelector {
  private readonly rateLimiter: GeminiRateLimiter;
  private readonly maxRetries: number;

  constructor(config: KeySelectorConfig) {
    this.rateLimiter = config.rateLimiter;
    this.maxRetries = config.maxRetries ?? 3;
  }

  /**
   * Select the best key+model slot. On failure, retries with other keys.
   * Returns null if all keys are exhausted.
   */
  async select(model: string | 'auto'): Promise<KeySlot | null> {
    return this.rateLimiter.reserveMinuteSlot(model);
  }

  /**
   * Release a slot when a request fails (429 or other error).
   */
  async release(slot: KeySlot): Promise<void> {
    await this.rateLimiter.releaseOnFailure(slot.keyId, slot.model);
  }

  getRetryLimit(): number {
    return this.maxRetries;
  }
}
