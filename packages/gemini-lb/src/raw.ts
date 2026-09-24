import { KeySelector } from './key-selector';
import { KeyErrorLog } from './error-log';
import {
  GOOGLE_BASE_URL,
  TOKEN_HARBOR_BASE_URL,
  joinBaseUrl,
  type Provider,
} from './provider-config';

export interface RawGenerateOptions {
  prompt: string;
  /** Model id, or 'auto' to let the balancer pick a key+model. @default 'auto' */
  model?: string;
  /** System instruction text. */
  system?: string;
  /** Generation settings. Gemini names are mapped for OpenAI-compatible providers. */
  generationConfig?: Record<string, unknown>;
  /** Gemini safety settings; ignored by OpenAI-compatible providers. */
  safetySettings?: unknown[];
  /** Provider-specific tools. For Token Harbor use OpenAI's `tools` shape. */
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
  /** Upstream provider that served the request. */
  provider: Provider;
  /** True when the request was served by a backup key. */
  backup: boolean;
  /** Full provider API response. */
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
  blocked: string[] = [],
): Record<string, string> {
  const blockedNames = new Set(blocked.map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && !blockedNames.has(k.toLowerCase())) out[k] = v;
    }
  }
  return out;
}

function extractText(raw: Record<string, unknown>, provider: Provider): string {
  if (provider === 'tokenharbor') {
    const message = (raw?.choices as any[] | undefined)?.[0]?.message;
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('');
    }
    return '';
  }

  const candidates = raw?.candidates as any[] | undefined;
  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('');
}

function buildGeminiBody(options: RawGenerateOptions): Record<string, unknown> {
  return {
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
}

function buildOpenAICompatibleBody(options: RawGenerateOptions): Record<string, unknown> {
  const config = options.generationConfig ?? {};
  const mapped: Record<string, unknown> = {};
  const copy = (target: string, ...sources: string[]) => {
    for (const source of sources) {
      if (config[source] !== undefined) {
        mapped[target] = config[source];
        return;
      }
    }
  };

  // Accept both OpenAI names and the Gemini-style names used by the existing
  // raw API. Explicit `body` values win below (streaming is not supported by
  // this raw helper, so it always remains disabled).
  copy('temperature', 'temperature');
  copy('top_p', 'top_p', 'topP');
  copy('max_tokens', 'max_tokens', 'maxTokens', 'maxOutputTokens');
  copy('stop', 'stop', 'stopSequences');
  copy('presence_penalty', 'presence_penalty', 'presencePenalty');
  copy('frequency_penalty', 'frequency_penalty', 'frequencyPenalty');
  copy('seed', 'seed');
  copy('response_format', 'response_format', 'responseFormat');

  return {
    model: options.model && options.model !== 'auto' ? options.model : undefined,
    messages: [
      ...(options.system ? [{ role: 'system', content: options.system }] : []),
      { role: 'user', content: options.prompt },
    ],
    ...mapped,
    ...(options.tools ? { tools: options.tools } : {}),
    ...options.body,
    stream: false,
  };
}

/**
 * Direct REST client for Google Gemini and OpenAI-compatible Token Harbor
 * keys. It goes through the same key selection, rate limiting, and error
 * tracking as the AI SDK provider: picks a key+model slot, calls the selected
 * provider, releases the slot, and retries on 429 with another eligible slot.
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
    return this.keySelector.executeWithFailover(
      requestedModel,
      async (slot) => {
        const doFetch = this.fetch ?? globalThis.fetch;
        const isTokenHarbor = slot.provider === 'tokenharbor';
        const baseUrl = slot.baseUrl ?? (isTokenHarbor ? TOKEN_HARBOR_BASE_URL : GOOGLE_BASE_URL);
        const url = isTokenHarbor
          ? joinBaseUrl(baseUrl, '/chat/completions')
          : joinBaseUrl(
              baseUrl,
              `/models/${encodeURIComponent(slot.model)}:generateContent`,
            );
        const body = isTokenHarbor
          ? {
              ...buildOpenAICompatibleBody(options),
              // `auto` is resolved by the slot, never sent to the gateway.
              model: slot.model,
            }
          : buildGeminiBody(options);

        const providerHeaders = isTokenHarbor
          ? { Authorization: `Bearer ${slot.apiKey}` }
          : { 'x-goog-api-key': slot.apiKey };
        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...providerHeaders,
            ...cleanHeaders(
              this.defaultHeaders,
              isTokenHarbor ? ['authorization'] : ['x-goog-api-key'],
            ),
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
          text: extractText(raw, slot.provider),
          model: slot.model,
          keyId: slot.keyId,
          provider: slot.provider ?? 'google',
          backup: slot.backup === true,
          raw,
        };
      },
      {
        maxRetries: this.maxRetries,
        onFailure: (slot, error) => {
          // Fire-and-forget (record() never throws)
          void this.errorLog?.record(slot.keyId, {
            status:
              error instanceof GeminiHTTPError
                ? error.status
                : undefined,
            message: error instanceof Error ? error.message : String(error),
            model: slot.model,
          });
        },
        isRetryable: (error) =>
          error instanceof GeminiHTTPError && error.status === 429,
      },
    );
  }
}
