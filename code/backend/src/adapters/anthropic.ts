// The one door to the Anthropic API (AD-1, story 5.1). The backend's only
// direct Anthropic call is the personal key check: one GET /v1/models with the
// key, made once per save. No other code may name api.anthropic.com (enforced
// by ESLint). In mock mode (USE_MOCK_DATA=true) no call is made and every key
// that is not a subscription token is accepted.
//
// Errors carry fixed sentences and at most the HTTP status: never the key or
// any Anthropic response text.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const KEY_CHECK_TIMEOUT_MS = 10_000;

/** Prefixes of Claude subscription tokens (OAuth access and refresh tokens). */
const SUBSCRIPTION_PREFIXES = ['sk-ant-oat', 'sk-ant-ort'] as const;

/** Whether the key is a Claude subscription token, which Debug it never uses. */
export function isSubscriptionToken(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const value = key.trim();
  return SUBSCRIPTION_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export class AnthropicError extends Error {
  /** The HTTP status Anthropic answered with, or null when it could not be reached. */
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

export type KeyCheck = 'valid' | 'rejected';

export interface AnthropicAdapter {
  /**
   * Checks the key with exactly one Anthropic call. 'rejected' when Anthropic
   * answers 401 or 403 (or the key is a subscription token, with no call).
   * Throws AnthropicError when Anthropic cannot be reached or answers otherwise.
   */
  checkKey(key: string): Promise<KeyCheck>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal },
) => Promise<{
  status: number;
  body?: { cancel?: () => Promise<void> } | null;
}>;

export interface AnthropicAdapterOptions {
  fetch?: FetchLike;
  /** Mock mode: no call, every key that is not a subscription token is valid. */
  mock?: boolean;
  timeoutMs?: number;
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}): AnthropicAdapter {
  const doFetch: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? KEY_CHECK_TIMEOUT_MS;

  return {
    async checkKey(key: string): Promise<KeyCheck> {
      if (typeof key !== 'string' || key === '' || isSubscriptionToken(key)) return 'rejected';
      if (options.mock) return 'valid';
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(`${ANTHROPIC_API_URL}/v1/models`, {
          method: 'GET',
          headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
          // Never forward the key to a redirect target.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // The error text may hold request details: it is never passed on.
        throw new AnthropicError('Anthropic could not be reached for the key check.', null);
      }
      // The body is never read.
      try {
        await response.body?.cancel?.();
      } catch {
        // ignore
      }
      const status = response.status;
      if (status >= 200 && status < 300) return 'valid';
      if (status === 401 || status === 403) return 'rejected';
      throw new AnthropicError(`Anthropic answered the key check with status ${status}.`, status);
    },
  };
}

let singleton: AnthropicAdapter | undefined;

/** The adapter of this process; makes no call in mock mode. */
export function getAnthropicAdapter(env: Record<string, string | undefined> = process.env): AnthropicAdapter {
  if (singleton) return singleton;
  singleton = createAnthropicAdapter({ mock: env.USE_MOCK_DATA === 'true' });
  return singleton;
}

/** Forgets the singleton; for tests. */
export function resetAnthropicAdapter(): void {
  singleton = undefined;
}
