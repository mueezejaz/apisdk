/** Providers supported by the Redis-backed load balancer. */
export type Provider = 'google' | 'tokenharbor';

export const PROVIDERS: readonly Provider[] = ['google', 'tokenharbor'];

/** Token Harbor's documented OpenAI-compatible gateway. */
export const TOKEN_HARBOR_BASE_URL = 'https://tokenharbor.ai/v1';

/** Google's native Gemini API prefix. */
export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const PROVIDER_LABELS: Record<Provider, string> = {
  google: 'Google Gemini',
  tokenharbor: 'Token Harbor (OpenAI compatible)',
};

/**
 * Normalize provider names received from old clients or API callers.
 * Google Gemini is kept as the canonical name, while common aliases are
 * accepted so existing Gemini-oriented integrations can migrate easily.
 */
export function normalizeProvider(value: unknown, fallback: Provider = 'google'): Provider {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
  switch (normalized) {
    case 'google':
    case 'gemini':
    case 'google-gemini':
    case 'google-generative-ai':
      return 'google';
    case 'tokenharbor':
    case 'token-harbor':
    case 'openai-compatible':
    case 'openai':
      return 'tokenharbor';
    default:
      throw new Error(`unsupported provider "${String(value)}"`);
  }
}

/**
 * Validate and canonicalize a provider base URL.
 *
 * Token Harbor uses `https://tokenharbor.ai/v1`; accepting the root URL as a
 * convenience is useful for clients that describe it as the gateway URL. A
 * full `/chat/completions` URL is also accepted and reduced to its base URL so
 * the request builder can append the endpoint exactly once.
 */
export function normalizeBaseUrl(
  provider: Provider,
  value: unknown,
): string | undefined {
  const p = normalizeProvider(provider);
  const raw = value === undefined || value === null ? '' : String(value).trim();

  if (!raw) {
    return p === 'tokenharbor' ? TOKEN_HARBOR_BASE_URL : undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('base URL must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('base URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('base URL must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('base URL must not contain a query string or fragment');
  }

  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) {
    pathname = pathname.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }

  // The quickstart documents /v1, while a number of integrations show the
  // origin only because their client appends /v1 itself.
  if (p === 'tokenharbor' && !pathname) {
    pathname = '/v1';
  }

  parsed.pathname = pathname || '/';
  return parsed.toString().replace(/\/$/, '');
}

/** Append an API path to a normalized base URL without duplicating slashes. */
export function joinBaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}
