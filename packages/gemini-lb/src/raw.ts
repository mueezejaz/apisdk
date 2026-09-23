import { KeySelector } from './key-selector';
import { KeyErrorLog } from './error-log';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface RawGenerateOptions {
  prompt: string;
  /** Model id, or 'auto' to let the balancer pick a key+model. @default 'auto' */
  model?: string;
  /** System instruction text. */
  system?: string;
  /** Gemini generationConfig (temperature, maxOutputTokens, …). */
  generationConfig?: Record<string, unknown>;
  safetySettings?: unknown[];
  tools?: unknown[];
  /** Extra fields merged into the request body (advanced). */
  body?: Record<string, unknown>;
}

export interface RawGenerateResult {
  /** Concatenated text of the first candidate (may be '' for empty replies). */
  text: string;
  /** The actual model that served the request (resolved when model='auto'). */
  model: string;
  /** Stable key id that served the request. */
  keyId: string;
  /** Full Gemini API response. */
  raw: Record<string, unknown>;
}

export class GeminiHTTPError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GeminiHTTPError';
    this.status = status;
  }
}

function cleanHeaders(
  headers?: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

function extractText(raw: Record<string, unknown>): string {
  const candidates = raw?.candidates as any[] | undefined;
  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('');
}

/**
 * Direct Gemini REST client (no Vercel AI SDK required) that goes through
 * the same key selection / rate limiting / error tracking as the AI SDK
 * provider: picks a key+model slot, calls generateContent, releases the
 * slot and retries on 429 with another key.
 */
export class GeminiRawClient {
  private readonly keySelector: KeySelector;
  private readonly errorLog?: KeyErrorLog;
  private readonly fetch?: typeof globalThis.fetch;
  private readonly defaultHeaders?: Record<string, string | undefined>;
  private readonly maxRetries: number;

  constructor(options: {
    keySelector: KeySelector;
    errorLog?: KeyErrorLog;
    fetch?: typeof globalThis.fetch;
    defaultHeaders?: Record<string, string | undefined>;
    /** Max retries on 429. @default key selector's retry limit (3) */
    maxRetries?: number;
  }) {
    this.keySelector = options.keySelector;
    this.errorLog = options.errorLog;
    this.fetch = options.fetch;
    this.defaultHeaders = options.defaultHeaders;
    this.maxRetries = options.maxRetries ?? options.keySelector.getRetryLimit();
  }

  async generate(options: RawGenerateOptions): Promise<RawGenerateResult> {
    const requestedModel = options.model ?? 'auto';
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const slot = await this.keySelector.select(requestedModel);
      if (!slot) {
        throw new Error(
          `[gemini-lb] All API keys exhausted for model "${requestedModel}". ` +
            `Try again later or add more keys.`,
        );
      }

      try {
        const doFetch = this.fetch ?? globalThis.fetch;
        const url = `${API_BASE}/${encodeURIComponent(slot.model)}:generateContent`;

        const body: Record<string, unknown> = {
          contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
          ...(options.system
            ? { systemInstruction: { parts: [{ text: options.system }] } }
            : {}),
          ...(options.generationConfig
            ? { generationConfig: options.generationConfig }
            : {}),
          ...(options.safetySettings ? { safetySettings: options.safetySettings } : {}),
          ...(options.tools ? { tools: options.tools } : {}),
          ...options.body,
        };

        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': slot.apiKey,
            ...cleanHeaders(this.defaultHeaders),
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          let message = text.slice(0, 500) || `HTTP ${res.status}`;
          try {
            message = JSON.parse(text)?.error?.message ?? message;
          } catch {
            // keep raw message
          }
          throw new GeminiHTTPError(res.status, message);
        }

        const raw = (await res.json()) as Record<string, unknown>;
        return {
          text: extractText(raw),
          model: slot.model,
          keyId: slot.keyId,
          raw,
        };
      } catch (error) {
        lastError = error;
        // Fire-and-forget (record() never throws)
        void this.errorLog?.record(slot.keyId, {
          status:
            error instanceof GeminiHTTPError
              ? error.status
              : undefined,
          message: error instanceof Error ? error.message : String(error),
          model: slot.model,
        });
        // Free the minute slot so another key can be tried
        await this.keySelector.release(slot);

        const status =
          error instanceof GeminiHTTPError ? error.status : undefined;
        if (status !== 429) throw error; // non-rate-limit error — don't retry
        if (attempt === this.maxRetries) throw error;
      }
    }

    throw lastError;
  }
}
