import { GeminiRateLimiter, KeySlot } from './rate-limiter';
import { DEFAULT_KEY_COOLDOWN_MS } from './key-store';

export interface KeySelectorConfig {
  rateLimiter: GeminiRateLimiter;
  maxRetries?: number;
  /** Failed-key cooldown duration. @default 20000 */
  cooldownMs?: number;
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof Response) return error.status;
  const value = error as { statusCode?: unknown; status?: unknown };
  if (typeof value?.statusCode === 'number') return value.statusCode;
  if (typeof value?.status === 'number') return value.status;
  return undefined;
}

export class KeySelector {
  private readonly rateLimiter: GeminiRateLimiter;
  private readonly maxRetries: number;
  private readonly cooldownMs: number;

  constructor(config: KeySelectorConfig) {
    this.rateLimiter = config.rateLimiter;
    this.maxRetries = config.maxRetries ?? 3;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_KEY_COOLDOWN_MS;
  }

  /**
   * Select the best key+model slot. On failure, retries with other keys.
   * Returns null if all eligible slots are exhausted.
   */
  async select(
    model: string | 'auto',
    excludedSlots?: ReadonlySet<string>,
  ): Promise<KeySlot | null> {
    return excludedSlots === undefined
      ? this.rateLimiter.reserveMinuteSlot(model)
      : this.rateLimiter.reserveMinuteSlot(model, excludedSlots, { role: 'normal' });
  }

  /** Select a configured backup key for the same model. */
  async selectBackup(
    model: string | 'auto',
    excludedSlots?: ReadonlySet<string>,
  ): Promise<KeySlot | null> {
    return excludedSlots === undefined
      ? this.rateLimiter.reserveMinuteSlot(model, new Set(), { role: 'backup' })
      : this.rateLimiter.reserveMinuteSlot(model, excludedSlots, { role: 'backup' });
  }

  /** Put a failed key in the shared cooldown window. */
  async cooldown(
    keyId: string,
    durationMs: number = this.cooldownMs,
  ): Promise<void> {
    await this.rateLimiter.cooldown(keyId, durationMs);
  }

  /**
   * Execute a request with normal-key retries and one same-model backup
   * attempt. Any failed key is released and placed in a shared cooldown.
   */
  async executeWithFailover<T>(
    model: string | 'auto',
    execute: (slot: KeySlot) => Promise<T>,
    options: {
      onFailure?: (slot: KeySlot, error: unknown) => Promise<void> | void;
      isRetryable?: (error: unknown) => boolean;
      cooldownMs?: number;
      maxRetries?: number;
    } = {},
  ): Promise<T> {
    const triedSlots = new Set<string>();
    const maxRetries = options.maxRetries ?? this.maxRetries;
    let lastError: unknown;
    let backupAttempted = false;
    const isRetryable = options.isRetryable ?? ((error: unknown) => statusOf(error) === 429);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const slot = triedSlots.size === 0
        ? await this.select(model)
        : await this.select(model, triedSlots);
      if (!slot) {
        if (lastError) throw lastError;
        if (!backupAttempted) {
          const backup = await this.selectBackup(model, triedSlots);
          if (backup) {
            backupAttempted = true;
            try {
              return await execute(backup);
            } catch (backupError) {
              triedSlots.add(`${backup.keyId}\u0000${backup.model}`);
              await this.handleFailure(backup, backupError, options);
              throw backupError;
            }
          }
        }
        throw new Error(
          `[gemini-lb] All API keys exhausted for model "${model}". ` +
          `Try again later or add more keys.`,
        );
      }

      try {
        return await execute(slot);
      } catch (error) {
        triedSlots.add(`${slot.keyId}\u0000${slot.model}`);
        lastError = error;
        await this.handleFailure(slot, error, options);

        // A configured backup gets one immediate same-model attempt for every
        // failed normal request, regardless of whether the error was a 429.
        if (!backupAttempted) {
          const backup = await this.selectBackup(slot.model, triedSlots);
          if (backup) {
            backupAttempted = true;
            try {
              return await execute(backup);
            } catch (backupError) {
              triedSlots.add(`${backup.keyId}\u0000${backup.model}`);
              lastError = backupError;
              await this.handleFailure(backup, backupError, options);
              throw backupError;
            }
          }
        }

        if (!isRetryable(error) || attempt === maxRetries) throw error;
      }
    }

    throw lastError;
  }

  private async handleFailure(
    slot: KeySlot,
    error: unknown,
    options: {
      onFailure?: (slot: KeySlot, error: unknown) => Promise<void> | void;
      cooldownMs?: number;
    },
  ): Promise<void> {
    try {
      await options.onFailure?.(slot, error);
    } catch {
      // Error reporting must not mask the upstream failure.
    }
    try {
      await this.release(slot);
    } catch {
      // Releasing the minute slot is best effort during upstream failure.
    } finally {
      try {
        await this.cooldown(slot.keyId, options.cooldownMs);
      } catch {
        // Cooldown is best effort if Redis is temporarily unavailable.
      }
    }
  }

  /**
   * Release a slot when a request fails (429 or other error).
   */
  async release(slot: KeySlot): Promise<void> {
    await this.rateLimiter.releaseOnFailure(
      slot.keyId,
      slot.model,
      slot.reservationId,
    );
  }

  getRetryLimit(): number {
    return this.maxRetries;
  }
}
