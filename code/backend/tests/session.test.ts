import {
  createSessionService,
  loadSessionKey,
  parseCookies,
  parseSessionKey,
  SESSION_TTL_SECONDS,
} from '../src/services/session';

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);

function service(key = KEY_A, at = () => T0, secure = false) {
  return createSessionService(key, { secure, now: at });
}

describe('parseSessionKey', () => {
  test('accepts 64 hex characters', () => {
    expect(parseSessionKey('ab'.repeat(32))).toEqual(Buffer.alloc(32, 0xab));
  });

  test('accepts base64 of 32 bytes', () => {
    expect(parseSessionKey(Buffer.alloc(32, 9).toString('base64'))).toEqual(Buffer.alloc(32, 9));
  });

  test('accepts a 32 byte string', () => {
    expect(parseSessionKey('acme-payments-api-session-key-32')).toEqual(Buffer.from('acme-payments-api-session-key-32'));
  });

  test.each([undefined, '', 'short', 'ab'.repeat(31), Buffer.alloc(16).toString('base64'), 'x'.repeat(33)])(
    'rejects %p',
    (raw) => {
      expect(parseSessionKey(raw)).toBeNull();
    },
  );
});

describe('loadSessionKey', () => {
  test('throws on a bad key outside mock mode, without echoing it', () => {
    expect(() => loadSessionKey({ DEBUG_IT_SESSION_ENCRYPTION_KEY: 'not-a-key-value' })).toThrow(
      /DEBUG_IT_SESSION_ENCRYPTION_KEY/,
    );
    try {
      loadSessionKey({ DEBUG_IT_SESSION_ENCRYPTION_KEY: 'not-a-key-value' });
    } catch (error) {
      expect((error as Error).message).not.toContain('not-a-key-value');
    }
    expect(() => loadSessionKey({})).toThrow();
  });

  test('generates a random key in mock mode', () => {
    const key = loadSessionKey({ USE_MOCK_DATA: 'true' });
    expect(key).toHaveLength(32);
    expect(loadSessionKey({ USE_MOCK_DATA: 'true' }).equals(key)).toBe(false);
  });

  test('uses the configured key', () => {
    expect(loadSessionKey({ DEBUG_IT_SESSION_ENCRYPTION_KEY: '01'.repeat(32) })).toEqual(Buffer.alloc(32, 1));
  });
});

describe('seal and open', () => {
  test('round trips the user with an 8 hour expiry', () => {
    const s = service();
    const value = s.seal({ uid: 1000001, login: 'dana' });
    expect(s.open(value)).toEqual({ uid: 1000001, login: 'dana', exp: T0 / 1000 + SESSION_TTL_SECONDS });
  });

  test('layout is nonce, ciphertext, tag in base64url, with no plain text', () => {
    const value = service().seal({ uid: 1000001, login: 'dana' });
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    const raw = Buffer.from(value, 'base64url');
    const plain = JSON.stringify({ uid: 1000001, login: 'dana', exp: T0 / 1000 + SESSION_TTL_SECONDS });
    expect(raw.length).toBe(12 + Buffer.byteLength(plain) + 16);
    expect(raw.toString('utf8')).not.toContain('dana');
  });

  test('uses a fresh nonce every time', () => {
    const s = service();
    expect(s.seal({ uid: 1, login: 'dana' })).not.toBe(s.seal({ uid: 1, login: 'dana' }));
  });

  test('another key is no session', () => {
    expect(service(KEY_B).open(service(KEY_A).seal({ uid: 1000001, login: 'dana' }))).toBeNull();
  });

  test('any flipped byte is no session', () => {
    const s = service();
    const raw = Buffer.from(s.seal({ uid: 1000001, login: 'dana' }), 'base64url');
    for (let i = 0; i < raw.length; i++) {
      const altered = Buffer.from(raw);
      altered[i] = altered[i]! ^ 0x01;
      expect(s.open(altered.toString('base64url'))).toBeNull();
    }
  });

  test('after 8 hours is no session', () => {
    let now = T0;
    const s = service(KEY_A, () => now);
    const value = s.seal({ uid: 1000001, login: 'dana' });
    now = T0 + SESSION_TTL_SECONDS * 1000 - 1000;
    expect(s.open(value)).not.toBeNull();
    now = T0 + SESSION_TTL_SECONDS * 1000;
    expect(s.open(value)).toBeNull();
  });

  test.each([undefined, '', 'garbage', '!!!!', 'AAAA', Buffer.alloc(40).toString('base64url')])(
    'garbage %p is no session',
    (value) => {
      expect(service().open(value)).toBeNull();
    },
  );
});

describe('CSRF token', () => {
  test('is the base64url HMAC of the cookie and verifies only for that cookie', () => {
    const s = service();
    const a = s.seal({ uid: 1000001, login: 'dana' });
    const b = s.seal({ uid: 1000001, login: 'dana' });
    const token = s.csrfToken(a);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.verifyCsrf(a, token)).toBe(true);
    expect(s.verifyCsrf(b, token)).toBe(false);
    expect(s.verifyCsrf(a, undefined)).toBe(false);
    expect(s.verifyCsrf(a, '')).toBe(false);
    expect(s.verifyCsrf(a, token.slice(1))).toBe(false);
    expect(service(KEY_B).verifyCsrf(a, token)).toBe(false);
  });
});

describe('cookie headers', () => {
  test('session and state cookies carry the required flags', () => {
    const s = service();
    expect(s.sessionCookie('v')).toBe('dbg_session=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800');
    expect(s.clearSessionCookie()).toBe('dbg_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    expect(s.stateCookie('s')).toBe('dbg_oauth_state=s; HttpOnly; SameSite=Lax; Path=/; Max-Age=600');
    expect(s.clearStateCookie()).toBe('dbg_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  });

  test('Secure is added when asked', () => {
    expect(service(KEY_A, () => T0, true).sessionCookie('v')).toContain('; Secure');
  });
});

describe('parseCookies', () => {
  test('reads name value pairs, first wins', () => {
    expect(parseCookies('a=1; dbg_session=xyz; a=2; bad; =x')).toEqual({ a: '1', dbg_session: 'xyz' });
    expect(parseCookies(undefined)).toEqual({});
  });
});
