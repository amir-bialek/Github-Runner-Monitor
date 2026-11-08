// Stateless Debug it sessions (AD-10): an AES-256-GCM encrypted cookie holding
// the GitHub user ID, login and expiry. Nothing is stored on the server. The
// CSRF token is an HMAC of the cookie value with the same key (AD-11).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const SESSION_COOKIE = 'dbg_session';
export const STATE_COOKIE = 'dbg_oauth_state';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const STATE_TTL_SECONDS = 600;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface Session {
  uid: number;
  login: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

export interface SessionService {
  /** Encrypts a new session for this user, valid for 8 hours. */
  seal(user: { uid: number; login: string }): string;
  /** The session in the cookie value, or null if missing, altered, from another key or expired. */
  open(value: string | undefined): Session | null;
  csrfToken(cookieValue: string): string;
  verifyCsrf(cookieValue: string, token: unknown): boolean;
  sessionCookie(value: string): string;
  clearSessionCookie(): string;
  stateCookie(state: string): string;
  clearStateCookie(): string;
}

/**
 * Reads the 32 byte session key: 64 hex characters, base64 that decodes to
 * 32 bytes, or a 32 byte string. Returns null for anything else.
 */
export function parseSessionKey(raw: string | undefined): Buffer | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  }
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length === 32 ? bytes : null;
}

/**
 * The session key from DEBUG_IT_SESSION_ENCRYPTION_KEY. Throws when it is
 * missing or malformed, except in mock mode, where a random key is used.
 */
export function loadSessionKey(env: Record<string, string | undefined> = process.env): Buffer {
  const key = parseSessionKey(env.DEBUG_IT_SESSION_ENCRYPTION_KEY);
  if (key) return key;
  if (env.USE_MOCK_DATA === 'true') return randomBytes(32);
  throw new Error(
    'DEBUG_IT_SESSION_ENCRYPTION_KEY must be 64 hex characters, base64 of 32 bytes or a 32 byte string.',
  );
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (name && !(name in cookies)) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }
  return cookies;
}

/** Constant time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createSessionService(
  key: Buffer,
  options: { secure: boolean; now?: () => number },
): SessionService {
  if (key.length !== 32) throw new Error('The session key must be 32 bytes.');
  const now = options.now ?? Date.now;
  const flags = `HttpOnly; SameSite=Lax; Path=/${options.secure ? '; Secure' : ''}`;
  const nowSeconds = () => Math.floor(now() / 1000);

  function csrfToken(cookieValue: string): string {
    return createHmac('sha256', key).update(cookieValue).digest('base64url');
  }

  return {
    seal({ uid, login }) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const plain = JSON.stringify({ uid, login, exp: nowSeconds() + SESSION_TTL_SECONDS });
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
    },

    open(value) {
      if (!value) return null;
      try {
        const raw = Buffer.from(value, 'base64url');
        if (raw.length <= NONCE_BYTES + TAG_BYTES) return null;
        const nonce = raw.subarray(0, NONCE_BYTES);
        const tag = raw.subarray(raw.length - TAG_BYTES);
        const ciphertext = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        const data = JSON.parse(plain) as Partial<Session>;
        if (
          typeof data.uid !== 'number' ||
          typeof data.login !== 'string' ||
          typeof data.exp !== 'number' ||
          data.exp <= nowSeconds()
        ) {
          return null;
        }
        return { uid: data.uid, login: data.login, exp: data.exp };
      } catch {
        return null;
      }
    },

    csrfToken,

    verifyCsrf(cookieValue, token) {
      if (typeof token !== 'string' || token === '') return false;
      return safeEqual(csrfToken(cookieValue), token);
    },

    sessionCookie(value) {
      return `${SESSION_COOKIE}=${value}; ${flags}; Max-Age=${SESSION_TTL_SECONDS}`;
    },
    clearSessionCookie() {
      return `${SESSION_COOKIE}=; ${flags}; Max-Age=0`;
    },
    stateCookie(state) {
      return `${STATE_COOKIE}=${state}; ${flags}; Max-Age=${STATE_TTL_SECONDS}`;
    },
    clearStateCookie() {
      return `${STATE_COOKIE}=; ${flags}; Max-Age=0`;
    },
  };
}
