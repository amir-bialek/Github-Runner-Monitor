import express from 'express';
import request from 'supertest';
import { createAnthropicAdapter, AnthropicError, type AnthropicAdapter } from '../src/adapters/anthropic';
import { createMockGitHubApp } from '../src/adapters/githubApp';
import { createMemoryS3Client, createS3Store, type S3Client, type S3Command } from '../src/adapters/s3Store';
import { registerDebugIt } from '../src/routes/debugIt';
import { CHECK_ERRORS } from '../src/routes/checkChain';
import { DEBUG_IT_DEFAULTS, type CredentialsMode } from '../src/services/debugItConfig';
import { createSessionService } from '../src/services/session';
import { createSettingsService } from '../src/services/debugIt/settings';
import {
  createPersonalKeyService,
  decryptPersonalKey,
  encryptPersonalKey,
  getPersonalKeyService,
  loadPersonalKeyEncryptionKey,
  parsePersonalKey,
  PERSONAL_KEY_ERRORS,
  personalKeyKey,
  resetPersonalKeyService,
} from '../src/services/debugIt/personalKeys';
import { createResultsService, hashResultCode, RESULT_ERRORS } from '../src/services/debugIt/results';
import { createResultValidator, loadResultSchema } from '../src/services/debugIt/resultSchema';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { RunRecord } from '../src/services/debugIt/runs';

const log = console.log as jest.Mock;
const info = console.info as jest.Mock;
const warn = console.warn as jest.Mock;
const error = console.error as jest.Mock;

const SESSION_KEY = Buffer.alloc(32, 7);
const ENCRYPTION_KEY = Buffer.alloc(32, 9);
const KEY = 'sk-ant-api03-dana-known-test-key-acme-0123456789-WXYZ';
const OTHER_KEY = 'sk-ant-api03-dana-replacement-key-acme-9876543210-QRST';
const DANA = { uid: 1000001, login: 'dana' }; // allowed user
const LEE = { uid: 1000002, login: 'lee' }; // not an allowed user
const OBJECT = 'debug-it/personal-keys/1000001.json';

function allLogs(): string {
  return [log, info, warn, error].flatMap((m) => m.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
}

// Every form of the key a careless implementation could leak.
function leakForms(key: string): string[] {
  return [key, key.slice(0, -4), Buffer.from(key).toString('base64'), Buffer.from(key).toString('hex')];
}

function expectNoLeak(text: string, key = KEY): void {
  for (const form of leakForms(key)) expect(text).not.toContain(form);
}

// A memory client that records every command and can be made to fail.
function recordingClient() {
  const inner = createMemoryS3Client();
  const commands: S3Command[] = [];
  let fail: (c: S3Command) => boolean = () => false;
  const client: S3Client = {
    async send(command) {
      commands.push(command);
      if (fail(command)) {
        const e = new Error('TimeoutError') as Error & { $metadata: object };
        e.name = 'TimeoutError';
        e.$metadata = {};
        throw e;
      }
      return inner.send(command);
    },
  };
  return {
    client,
    inner,
    commands,
    setFail: (f: (c: S3Command) => boolean) => {
      fail = f;
    },
  };
}

function checkingAdapter(answer: 'valid' | 'rejected' | Error = 'valid') {
  return {
    checkKey: jest.fn(async (_key: string) => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  } satisfies AnthropicAdapter;
}

function service(options: { mode?: CredentialsMode | undefined; adapter?: AnthropicAdapter | undefined } = {}) {
  const s3 = recordingClient();
  const store = createS3Store({ bucket: 'acme-bucket', client: s3.client });
  const adapter = options.adapter ?? checkingAdapter();
  const keys = createPersonalKeyService({
    store,
    adapter,
    encryptionKey: ENCRYPTION_KEY,
    credentialsMode: options.mode ?? 'personal',
    now: () => new Date('2026-11-06T10:00:00.000Z'),
  });
  // Every byte ever stored under the object, across every version.
  const storedBodies = () =>
    s3.commands.filter((c) => c.name === 'PutObjectCommand' && c.input.Key === OBJECT).map((c) => String(c.input.Body));
  const versions = async () =>
    ((await s3.inner.send({ name: 'ListObjectVersionsCommand', input: { Prefix: OBJECT } })) as {
      Versions: unknown[];
      DeleteMarkers: unknown[];
    });
  return { keys, store, adapter, s3, storedBodies, versions };
}

beforeEach(() => {
  for (const m of [log, info, warn, error]) m.mockClear();
});

describe('encryption', () => {
  test('round trip; a fresh nonce each write; AAD binds the object key', () => {
    const a = encryptPersonalKey(ENCRYPTION_KEY, OBJECT, KEY, 'now');
    const b = encryptPersonalKey(ENCRYPTION_KEY, OBJECT, KEY, 'now');
    expect(a.v).toBe(1);
    expect(Buffer.from(a.nonce, 'base64')).toHaveLength(12);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptPersonalKey(ENCRYPTION_KEY, OBJECT, a)).toBe(KEY);
    // Copied over another user's object, it does not decrypt.
    expect(decryptPersonalKey(ENCRYPTION_KEY, 'debug-it/personal-keys/1000002.json', a)).toBeNull();
    expect(decryptPersonalKey(Buffer.alloc(32, 1), OBJECT, a)).toBeNull();
    expect(decryptPersonalKey(ENCRYPTION_KEY, OBJECT, { ...a, tag: Buffer.alloc(16).toString('base64') })).toBeNull();
    expect(decryptPersonalKey(ENCRYPTION_KEY, OBJECT, { ...a, v: 2 })).toBeNull();
    expect(decryptPersonalKey(ENCRYPTION_KEY, OBJECT, 'nope')).toBeNull();
    expectNoLeak(JSON.stringify(a));
  });

  test('parsePersonalKey', () => {
    expect(parsePersonalKey({ key: KEY })).toBe(KEY);
    expect(parsePersonalKey({ key: `  ${KEY}\n` })).toBe(KEY);
    for (const body of [undefined, null, [], 'x', {}, { key: 42 }, { key: '' }, { key: '   ' }, { key: 'a'.repeat(257) }, { key: 'sk-ant\u0001x' }, { key: 'sk-ant-é' }]) {
      expect(parsePersonalKey(body)).toBeNull();
    }
    expect(parsePersonalKey({ key: 'a'.repeat(256) })).toBe('a'.repeat(256));
    // Short keys are refused, so last4 is never most of the key.
    for (const key of ['WXYZ', 'abc', 'a'.repeat(19), `  ${'a'.repeat(19)}  `]) expect(parsePersonalKey({ key })).toBeNull();
    expect(parsePersonalKey({ key: 'a'.repeat(20) })).toBe('a'.repeat(20));
  });

  test('loadPersonalKeyEncryptionKey', () => {
    expect(loadPersonalKeyEncryptionKey({ DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY: '09'.repeat(32) })).toEqual(ENCRYPTION_KEY);
    expect(() => loadPersonalKeyEncryptionKey({})).toThrow(/DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY/);
    expect(loadPersonalKeyEncryptionKey({ USE_MOCK_DATA: 'true' })).toHaveLength(32);
  });

  test('getPersonalKeyService needs the encryption key only in personal key mode', () => {
    resetPersonalKeyService();
    expect(() => getPersonalKeyService({}, 'personal')).toThrow(/DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY/);
    resetPersonalKeyService();
    expect(getPersonalKeyService({}, 'organization').credentialsMode).toBe('organization');
    resetPersonalKeyService();
    expect(getPersonalKeyService({ USE_MOCK_DATA: 'true' }, 'personal').credentialsMode).toBe('personal');
    resetPersonalKeyService();
  });
});

describe('service', () => {
  test('save: one key check, encrypted object, last 4 only', async () => {
    const { keys, adapter, storedBodies } = service();
    const outcome = await keys.save(DANA.uid, { key: KEY });
    expect(outcome).toEqual({ ok: true, body: { credentialsMode: 'personal', saved: true, last4: 'WXYZ' } });
    expect(adapter.checkKey).toHaveBeenCalledTimes(1);
    const [body] = storedBodies();
    const stored = JSON.parse(body!);
    expect(Object.keys(stored).sort()).toEqual(['ciphertext', 'nonce', 'savedAt', 'tag', 'v']);
    expectNoLeak(body!);
    expect(body).not.toContain('WXYZ');
    expect(await keys.keyFor(DANA.uid)).toMatchObject({ status: 'saved', key: KEY });
    expect(await keys.status(DANA.uid)).toEqual({ ok: true, body: { credentialsMode: 'personal', saved: true, last4: 'WXYZ' } });
    expect(log.mock.calls.map((c) => c.join(' '))).toContain('[AUDIT] Debug it personal key saved by GitHub user 1000001');
  });

  test('replace: overwritten with a new nonce, last 4 of the new key, If-Match used', async () => {
    const { keys, storedBodies, s3 } = service();
    await keys.save(DANA.uid, { key: KEY });
    const outcome = await keys.save(DANA.uid, { key: OTHER_KEY });
    expect(outcome).toEqual({ ok: true, body: { credentialsMode: 'personal', saved: true, last4: 'QRST' } });
    const [first, second] = storedBodies().map((b) => JSON.parse(b));
    expect(first.nonce).not.toBe(second.nonce);
    const puts = s3.commands.filter((c) => c.name === 'PutObjectCommand');
    expect(puts[0]!.input.IfNoneMatch).toBe('*');
    expect(puts[1]!.input.IfMatch).toBeDefined();
    expect(await keys.keyFor(DANA.uid)).toMatchObject({ status: 'saved', key: OTHER_KEY });
  });

  test('a conflicting write retries with a fresh nonce', async () => {
    const { keys, s3, storedBodies } = service();
    let first = true;
    s3.setFail(() => false);
    const realSend = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (first && command.name === 'PutObjectCommand') {
        first = false;
        // Someone else creates the object first: the create gets 412.
        await s3.inner.send({ name: 'PutObjectCommand', input: { ...command.input, IfNoneMatch: undefined, Body: '{}' } });
      }
      return realSend(command);
    };
    expect((await keys.save(DANA.uid, { key: KEY })).ok).toBe(true);
    const nonces = storedBodies().map((b) => (JSON.parse(b) as { nonce?: string }).nonce).filter(Boolean);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(await keys.keyFor(DANA.uid)).toMatchObject({ status: 'saved', key: KEY });
  });

  test('keyFor answers when the key was saved', async () => {
    const { keys } = service();
    await keys.save(DANA.uid, { key: KEY });
    expect(await keys.keyFor(DANA.uid)).toEqual({ status: 'saved', key: KEY, savedAt: '2026-11-06T10:00:00.000Z' });
  });

  test('a short key (mock mode accepts any key): 400 malformed, nothing stored', async () => {
    const { keys, s3 } = service({ adapter: createAnthropicAdapter({ mock: true }) });
    expect(await keys.save(DANA.uid, { key: 'WXYZ' })).toEqual({ ok: false, status: 400, error: PERSONAL_KEY_ERRORS.malformed });
    expect(s3.commands).toEqual([]);
  });

  test('a save and a delete of the same user at once never interleave: the delete wins when it comes second', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const adapter = {
      checkKey: jest.fn(async () => {
        await gate;
        return 'valid' as const;
      }),
    };
    const { keys, s3, versions } = service({ adapter });
    const saving = keys.save(DANA.uid, { key: KEY });
    const deleting = keys.remove(DANA.uid);
    await new Promise((done) => setImmediate(done));
    // The delete waits for the save: S3 is not touched yet.
    expect(s3.commands).toEqual([]);
    release();
    expect((await saving).ok).toBe(true);
    expect((await deleting).ok).toBe(true);
    const names = s3.commands.map((c) => c.name);
    expect(names.lastIndexOf('PutObjectCommand')).toBeLessThan(names.indexOf('ListObjectVersionsCommand'));
    const left = await versions();
    expect([...left.Versions, ...left.DeleteMarkers]).toEqual([]);
    expect(await keys.keyFor(DANA.uid)).toEqual({ status: 'none' });
  });

  test('a failed save does not block the next call of the same user', async () => {
    const { keys, s3 } = service();
    s3.setFail((c) => c.name === 'PutObjectCommand');
    expect((await keys.save(DANA.uid, { key: KEY })).ok).toBe(false);
    s3.setFail(() => false);
    expect((await keys.save(DANA.uid, { key: KEY })).ok).toBe(true);
  });

  test('subscription token: 400, no Anthropic call, nothing stored', async () => {
    const { keys, adapter, s3 } = service();
    const token = 'sk-ant-oat01-dana-subscription-acme-0000';
    expect(await keys.save(DANA.uid, { key: token })).toEqual({
      ok: false,
      status: 400,
      error: PERSONAL_KEY_ERRORS.subscriptionToken,
    });
    expect(adapter.checkKey).not.toHaveBeenCalled();
    expect(s3.commands).toEqual([]);
    expect(allLogs()).not.toContain(token);
  });

  test('rejected key: 400, nothing stored', async () => {
    const { keys, s3 } = service({ adapter: checkingAdapter('rejected') });
    expect(await keys.save(DANA.uid, { key: KEY })).toEqual({ ok: false, status: 400, error: 'Anthropic did not accept this API key.' });
    expect(s3.commands).toEqual([]);
  });

  test.each([
    ['unreachable', new AnthropicError('Anthropic could not be reached for the key check.', null), 'Anthropic could not be reached'],
    ['5xx', new AnthropicError('Anthropic answered the key check with status 503.', 503), 'Anthropic answered with status 503'],
    ['other', new TypeError(`boom ${KEY}`), 'unknown error'],
  ])('Anthropic %s: 502, nothing stored, one [ERROR] line with the status only', async (_name, failure, detail) => {
    const { keys, s3 } = service({ adapter: checkingAdapter(failure) });
    expect(await keys.save(DANA.uid, { key: KEY })).toEqual({ ok: false, status: 502, error: PERSONAL_KEY_ERRORS.unreachable });
    expect(s3.commands).toEqual([]);
    expect(error.mock.calls.map((c) => c.join(' '))).toEqual([
      `[ERROR] Debug it personal key check failed for GitHub user 1000001: ${detail}.`,
    ]);
    expectNoLeak(allLogs());
  });

  test('malformed bodies: 400, no Anthropic call', async () => {
    const { keys, adapter } = service();
    for (const body of [undefined, {}, { key: 7 }, { key: '' }, { key: 'x'.repeat(257) }, { key: 'sk\u0000ant' }]) {
      expect(await keys.save(DANA.uid, body)).toEqual({ ok: false, status: 400, error: PERSONAL_KEY_ERRORS.malformed });
    }
    expect(adapter.checkKey).not.toHaveBeenCalled();
  });

  test('S3 failure on save: 503', async () => {
    const { keys, s3 } = service();
    s3.setFail((c) => c.name === 'PutObjectCommand');
    expect(await keys.save(DANA.uid, { key: KEY })).toEqual({ ok: false, status: 503, error: PERSONAL_KEY_ERRORS.s3Save });
    expectNoLeak(allLogs());
  });

  test('organization mode: save and delete 409, status saved false, no S3 call', async () => {
    const { keys, s3, adapter } = service({ mode: 'organization' });
    expect(await keys.save(DANA.uid, { key: KEY })).toEqual({ ok: false, status: 409, error: 'Personal keys are used only in personal key mode.' });
    expect(await keys.remove(DANA.uid)).toEqual({ ok: false, status: 409, error: PERSONAL_KEY_ERRORS.organizationMode });
    expect(await keys.status(DANA.uid)).toEqual({ ok: true, body: { credentialsMode: 'organization', saved: false, last4: null } });
    expect(await keys.keyFor(DANA.uid)).toEqual({ status: 'none' });
    expect(s3.commands).toEqual([]);
    expect(adapter.checkKey).not.toHaveBeenCalled();
  });

  test('delete: every version removed, listeners told, count answered', async () => {
    const { keys, versions } = service();
    await keys.save(DANA.uid, { key: KEY });
    await keys.save(DANA.uid, { key: OTHER_KEY });
    const told: number[] = [];
    keys.onDeleted((uid) => {
      told.push(uid);
      return 2;
    });
    keys.onDeleted(() => {
      throw new Error('listener failure');
    });
    expect(await keys.remove(DANA.uid)).toEqual({
      ok: true,
      body: { credentialsMode: 'personal', saved: false, last4: null, cancelledRuns: 2 },
    });
    expect(told).toEqual([DANA.uid]);
    const left = await versions();
    expect(left.Versions).toEqual([]);
    expect(left.DeleteMarkers).toEqual([]);
    expect(await keys.keyFor(DANA.uid)).toEqual({ status: 'none' });
    expect(await keys.status(DANA.uid)).toEqual({ ok: true, body: { credentialsMode: 'personal', saved: false, last4: null } });
  });

  test('delete with S3 down: 503, listeners not told', async () => {
    const { keys, s3 } = service();
    await keys.save(DANA.uid, { key: KEY });
    const listener = jest.fn(() => 0);
    keys.onDeleted(listener);
    s3.setFail((c) => c.name === 'ListObjectVersionsCommand');
    expect(await keys.remove(DANA.uid)).toEqual({ ok: false, status: 503, error: PERSONAL_KEY_ERRORS.s3Delete });
    expect(listener).not.toHaveBeenCalled();
  });

  test('an unreadable object: keyFor unreadable with one [ERROR] line, status not saved', async () => {
    const { keys, store } = service();
    await store.create(personalKeyKey(DANA.uid), encryptPersonalKey(ENCRYPTION_KEY, 'debug-it/personal-keys/1000002.json', KEY, 'x'));
    expect(await keys.keyFor(DANA.uid)).toEqual({ status: 'unreadable' });
    expect(error.mock.calls.map((c) => c.join(' '))).toEqual(['[ERROR] Debug it personal key of GitHub user 1000001 cannot be read.']);
    expect(await keys.status(DANA.uid)).toEqual({ ok: true, body: { credentialsMode: 'personal', saved: false, last4: null } });
  });

  test('keyFor and status with S3 down', async () => {
    const { keys, s3 } = service();
    s3.setFail(() => true);
    await expect(keys.keyFor(DANA.uid)).rejects.toMatchObject({ name: 'S3StoreError' });
    expect(await keys.status(DANA.uid)).toEqual({ ok: false, status: 503, error: PERSONAL_KEY_ERRORS.s3Read });
  });

  test('mock mode adapter: saved with no Anthropic call', async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    try {
      const { keys } = service({ adapter: createAnthropicAdapter({ mock: true }) });
      expect((await keys.save(DANA.uid, { key: KEY })).ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('routes', () => {
  function build(options: { mode?: CredentialsMode; adapter?: AnthropicAdapter; enabled?: boolean } = {}) {
    const made = service({ mode: options.mode, adapter: options.adapter });
    const settingsStore = createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() });
    const settings = createSettingsService({
      store: settingsStore,
      config: { administrators: [], allowedRepositories: ['acme/payments-api'], allowedUsers: ['1000001'] },
    });
    const session = createSessionService(SESSION_KEY, { secure: false });
    const github = { ...createMockGitHubApp(), checkMembership: jest.fn(async () => true) };
    const app = express();
    app.use(express.json());
    const mounted = registerDebugIt(
      app,
      {
        ...DEBUG_IT_DEFAULTS,
        enabled: options.enabled ?? true,
        credentialsMode: options.mode ?? 'personal',
        publicUrl: 'https://monitor.acme.example',
      },
      {
        session,
        githubApp: github,
        env: {},
        settings,
        isolation: { status: () => ({ state: 'on', reason: null, checkedAt: null }) },
        personalKeys: made.keys,
      },
    );
    const responses: string[] = [];
    const as = (user = DANA) => {
      const value = session.seal(user);
      const cookie = `dbg_session=${value}`;
      const csrf = session.csrfToken(value);
      const keep = async (test: request.Test) => {
        const res = await test;
        responses.push(JSON.stringify(res.body) + res.text + JSON.stringify(res.headers));
        return res;
      };
      return {
        get: () => keep(request(app).get('/debug-it/personal-key').set('Cookie', cookie)),
        put: (body: unknown, token: string | null = csrf) => {
          const req = request(app).put('/debug-it/personal-key').set('Cookie', cookie);
          if (token !== null) req.set('X-CSRF-Token', token);
          return keep(req.send(body as object));
        },
        putRaw: (raw: string) =>
          keep(
            request(app)
              .put('/debug-it/personal-key')
              .set('Cookie', cookie)
              .set('X-CSRF-Token', csrf)
              .set('Content-Type', 'application/json')
              .send(raw),
          ),
        del: (token: string | null = csrf) => {
          const req = request(app).delete('/debug-it/personal-key').set('Cookie', cookie);
          if (token !== null) req.set('X-CSRF-Token', token);
          return keep(req);
        },
        session: () => keep(request(app).get('/debug-it/session').set('Cookie', cookie)),
      };
    };
    return { app, mounted, as, responses, ...made };
  }

  test('Debug it off: no route is registered', async () => {
    const { app, mounted } = build({ enabled: false });
    expect(mounted).toBe(false);
    expect((await request(app).get('/debug-it/personal-key')).status).toBe(404);
    expect((await request(app).put('/debug-it/personal-key').send({ key: KEY })).status).toBe(404);
  });

  test('save, read, replace and delete answer only the last 4', async () => {
    const { as, storedBodies } = build();
    expect((await as().get()).body).toEqual({ credentialsMode: 'personal', saved: false, last4: null });
    const saved = await as().put({ key: KEY });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ credentialsMode: 'personal', saved: true, last4: 'WXYZ' });
    expect((await as().get()).body).toEqual({ credentialsMode: 'personal', saved: true, last4: 'WXYZ' });
    expect((await as().put({ key: OTHER_KEY })).body.last4).toBe('QRST');
    const deleted = await as().del();
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ credentialsMode: 'personal', saved: false, last4: null, cancelledRuns: 0 });
    expect((await as().get()).body).toEqual({ credentialsMode: 'personal', saved: false, last4: null });
    expect(storedBodies()).toHaveLength(2);
  });

  test('the session answer carries the credentials mode', async () => {
    const { as } = build();
    expect((await as().session()).body.credentialsMode).toBe('personal');
  });

  test('state changes need a CSRF token; every call needs a session and an allowed user', async () => {
    const { app, as, s3 } = build();
    expect((await as().put({ key: KEY }, null)).status).toBe(403);
    expect((await as().del(null)).status).toBe(403);
    expect((await request(app).get('/debug-it/personal-key')).status).toBe(401);
    const lee = await as(LEE).get();
    expect(lee.status).toBe(403);
    expect(lee.body).toEqual({ error: CHECK_ERRORS.notAllowedUser });
    expect((await as(LEE).put({ key: KEY })).status).toBe(403);
    expect(s3.commands.filter((c) => String(c.input.Key ?? c.input.Prefix ?? '').includes('personal-keys'))).toEqual([]);
  });

  test('refusals are one sentence', async () => {
    const { as } = build({ adapter: checkingAdapter('rejected') });
    const rejected = await as().put({ key: KEY });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: 'Anthropic did not accept this API key.' });
    const token = await as().put({ key: 'sk-ant-oat01-dana-acme-0000' });
    expect(token.status).toBe(400);
    expect(token.body).toEqual({ error: PERSONAL_KEY_ERRORS.subscriptionToken });
    for (const body of [{}, { key: 5 }, { key: '' }, { key: 'k'.repeat(300) }]) {
      const res = await as().put(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: PERSONAL_KEY_ERRORS.malformed });
    }
  });

  test('a body the JSON parser refuses: 400 one sentence, no key in any log or answer', async () => {
    const { as, responses } = build();
    const res = await as().putRaw(`{"key": "${KEY}" oops`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PERSONAL_KEY_ERRORS.malformed });
    expectNoLeak(allLogs());
    expectNoLeak(responses.join('\n'));
  });

  test('Anthropic unreachable: 502', async () => {
    const { as } = build({ adapter: checkingAdapter(new AnthropicError('x', null)) });
    const res = await as().put({ key: KEY });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: PERSONAL_KEY_ERRORS.unreachable });
  });

  test('S3 failures: 503', async () => {
    const { as, s3 } = build();
    s3.setFail((c) => String(c.input.Key ?? c.input.Prefix ?? '').includes('personal-keys'));
    expect((await as().get()).status).toBe(503);
    expect((await as().put({ key: KEY })).status).toBe(503);
    const del = await as().del();
    expect(del.status).toBe(503);
    expect(del.body).toEqual({ error: PERSONAL_KEY_ERRORS.s3Delete });
  });

  test('organization mode: PUT and DELETE 409, GET saved false', async () => {
    const { as } = build({ mode: 'organization' });
    expect((await as().get()).body).toEqual({ credentialsMode: 'organization', saved: false, last4: null });
    const put = await as().put({ key: KEY });
    expect(put.status).toBe(409);
    expect(put.body).toEqual({ error: 'Personal keys are used only in personal key mode.' });
    expect((await as().del()).status).toBe(409);
  });

  test('a known key saved, read, used and deleted never reaches S3 in plain text, a log line or an answer', async () => {
    const { as, keys, responses, storedBodies, versions } = build();
    await as().put({ key: KEY });
    await as().get();
    await as().put({ key: KEY });

    // Used: the requester's key is read for a run and checked against a result.
    expect(await keys.keyFor(DANA.uid)).toMatchObject({ status: 'saved', key: KEY });
    const runStore = createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() });
    const code = 'fake-result-code-acme-0000000000000000000000';
    const runId = '00000000-0000-4000-8000-000000000009';
    await runStore.create(`runs/${runId}.json`, {
      runId,
      state: 'analyzing',
      requester: { githubUserId: DANA.uid, login: DANA.login },
      resultCodeHash: hashResultCode(code),
    });
    const schemaPath = resolve(process.cwd(), '../debug-job/schema/result.v1.json');
    const results = createResultsService({
      store: () => runStore,
      validator: createResultValidator(loadResultSchema(schemaPath)),
      keyRequired: true,
      apiKeyFor: async (r: RunRecord) => {
        const found = await keys.keyFor(r.requester.githubUserId);
        return found.status === 'saved' ? found.key : null;
      },
    });
    const result = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/debug-results/with-patch.json'), 'utf8'));
    const refused = await results.acceptResult(runId, `Bearer ${code}`, Buffer.from(JSON.stringify({ ...result, explanation: KEY })));
    expect(refused).toEqual({ status: 422, body: { error: RESULT_ERRORS.containsKey } });
    responses.push(JSON.stringify(refused));

    await as().del();
    // After the delete the result check fails closed.
    const afterDelete = await results.acceptResult(runId, `Bearer ${code}`, Buffer.from(JSON.stringify(result)));
    expect(afterDelete).toEqual({ status: 422, body: { error: RESULT_ERRORS.keyUnknown } });

    expect(storedBodies().length).toBeGreaterThan(0);
    for (const body of storedBodies()) expectNoLeak(body);
    const left = await versions();
    expect([...left.Versions, ...left.DeleteMarkers]).toEqual([]);
    expectNoLeak(responses.join('\n'));
    expect(responses.join('\n')).toContain('WXYZ');
    expectNoLeak(allLogs());
    expect(JSON.stringify(await runStore.read(`runs/${runId}.json`))).not.toContain(KEY);
  });
});
