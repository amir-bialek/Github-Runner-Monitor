import type http from 'http';
import type { AddressInfo } from 'net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { createMemoryS3Client, createS3Store, S3StoreError, type S3Store } from '../src/adapters/s3Store';
import { createResultsApp, openResultsListener } from '../src/routes/debugItResults';
import { createResultValidator, loadResultSchema } from '../src/services/debugIt/resultSchema';
import {
  createResultsService,
  hashResultCode,
  MAX_WRONG_RESULT_CODES,
  newResultCode,
  RESULT_ERRORS,
  type RunHook,
} from '../src/services/debugIt/results';
import type { RunRecord, RunState } from '../src/services/debugIt/runs';
import { getS3Store, resetS3Store } from '../src/adapters/s3Store';
import { resetAnthropicAdapter } from '../src/adapters/anthropic';
import { getPersonalKeyService, resetPersonalKeyService } from '../src/services/debugIt/personalKeys';

const log = console.log as jest.Mock;
const warn = console.warn as jest.Mock;
const error = console.error as jest.Mock;

const SCHEMA_PATH = resolve(process.cwd(), '../debug-job/schema/result.v1.json');
const SCHEMA = loadResultSchema(SCHEMA_PATH) as { 'x-maxBodyBytes': number };
const MAX_BODY = SCHEMA['x-maxBodyBytes'];
const VALIDATOR = createResultValidator(SCHEMA);

const RUN_ID = '00000000-0000-4000-8000-000000000009';
const OTHER_RUN_ID = '00000000-0000-4000-8000-00000000000a';
const API_KEY = 'sk-ant-api03-test-key-acme';
const RESULT_CODE = 'fake-result-code-acme-0000000000000000000000';
const RESULT_HASH = hashResultCode(RESULT_CODE);
const NOW = new Date('2026-11-05T10:30:00.000Z');

const RESULT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/debug-results/with-patch.json'), 'utf8'),
) as Record<string, unknown>;

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: RUN_ID,
    target: { kind: 'job', id: 900001 },
    requester: { githubUserId: 1000001, login: 'dana' },
    state: 'analyzing',
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:05:00.000Z',
    repository: 'acme/payments-api',
    headRepository: 'acme/payments-api',
    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    branch: 'feature/refunds',
    jobName: 'test',
    downloads: [{ repository: 'acme/payments-api', commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', folder: 'payments-api' }],
    usageKey: 'usage/2026-11/1000001.json',
    resultCodeHash: RESULT_HASH,
    result: null,
    feedback: null,
    fixPullRequests: [],
    failureReason: null,
    ...overrides,
  };
}

interface Harness {
  app: ReturnType<typeof createResultsApp>;
  store: S3Store;
  onAccepted: jest.Mock;
  onFailed: jest.Mock;
  read(): Promise<RunRecord | undefined>;
}

async function harness(
  initial: RunRecord | null = record(),
  options: {
    store?: S3Store;
    onAccepted?: RunHook;
    apiKey?: string | null;
    apiKeyFor?: (record: RunRecord) => Promise<string | null>;
    keyRequired?: boolean;
  } = {},
): Promise<Harness> {
  const store = options.store ?? createS3Store({ bucket: 'test-bucket', client: createMemoryS3Client() });
  if (initial) await store.create(`runs/${initial.runId}.json`, initial);
  const onAccepted = jest.fn(options.onAccepted ?? (() => undefined));
  const onFailed = jest.fn();
  const service = createResultsService({
    store: () => store,
    validator: VALIDATOR,
    apiKeyFor: options.apiKeyFor ?? (() => (options.apiKey === undefined ? API_KEY : options.apiKey)),
    ...(options.keyRequired !== undefined ? { keyRequired: options.keyRequired } : {}),
    now: () => NOW,
    onAccepted,
    onFailed,
  });
  return {
    app: createResultsApp(service, MAX_BODY),
    store,
    onAccepted,
    onFailed,
    async read() {
      return (await store.read<RunRecord>(`runs/${RUN_ID}.json`))?.value;
    },
  };
}

function post(h: Harness, body: string | Buffer, code: string | null = RESULT_CODE, runId = RUN_ID): request.Test {
  const req = request(h.app).post(`/results/${runId}`).set('Content-Type', 'application/json');
  if (code !== null) req.set('Authorization', `Bearer ${code}`);
  return req.send(body);
}

const BODY = JSON.stringify(RESULT);

function allLogs(): string {
  return [log, warn, error].flatMap((m) => m.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
}

function expectNoSecretsInLogs(): void {
  const text = allLogs();
  expect(text).not.toContain(RESULT_CODE);
  expect(text).not.toContain(RESULT_HASH);
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain('PAYMENTS_TIMEOUT');
}

beforeEach(() => {
  log.mockClear();
  warn.mockClear();
  error.mockClear();
});

afterEach(() => {
  expectNoSecretsInLogs();
});

describe('result code helpers', () => {
  it('makes 43-character base64url codes and hashes them as SHA-256 hex', () => {
    const code = newResultCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newResultCode()).not.toBe(code);
    expect(hashResultCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResultCode(code)).toBe(hashResultCode(code));
  });
});

describe('POST /results/:runId', () => {
  it('accepts a valid result once and stores exactly the schema fields', async () => {
    const h = await harness();
    const res = await post(h, BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
    expect(res.headers['x-powered-by']).toBeUndefined();

    const stored = await h.read();
    expect(stored?.state).toBe('analyzing');
    expect(stored?.resultCodeHash).toBeNull();
    expect(stored?.updatedAt).toBe(NOW.toISOString());
    expect(stored?.result).toEqual(RESULT);
    expect(Object.keys(stored?.result as object).sort()).toEqual(Object.keys(RESULT).sort());
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
    expect(h.onAccepted.mock.calls[0][0]).toMatchObject({ runId: RUN_ID, resultCodeHash: null, result: RESULT });
    expect(h.onFailed).not.toHaveBeenCalled();
    expect(log.mock.calls.filter((c) => String(c[0]).startsWith('[AUDIT]'))).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(RESULT_CODE);
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
  });

  it('accepts any content type', async () => {
    const h = await harness();
    const res = await request(h.app)
      .post(`/results/${RUN_ID}`)
      .set('Authorization', `Bearer ${RESULT_CODE}`)
      .set('Content-Type', 'text/plain')
      .send(BODY);
    expect(res.status).toBe(200);
  });

  it('refuses a replay with 409 and leaves the record unchanged', async () => {
    const h = await harness();
    expect((await post(h, BODY)).status).toBe(200);
    const before = await h.read();
    const res = await post(h, BODY);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: RESULT_ERRORS.notAccepting });
    expect(await h.read()).toEqual(before);
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
  });

  it('counts wrong codes on the record and answers 401', async () => {
    const h = await harness();
    for (let i = 0; i < 4; i += 1) {
      const res = await post(h, BODY, 'wrong-code-acme');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: RESULT_ERRORS.wrongCode });
    }
    const stored = await h.read();
    expect(stored?.wrongResultCodes).toBe(4);
    expect(stored?.state).toBe('analyzing');
    expect(stored?.resultCodeHash).toBe(RESULT_HASH);
    expect(stored?.result).toBeNull();
    expect(h.onFailed).not.toHaveBeenCalled();
    expect(allLogs()).not.toContain('wrong-code-acme');
  });

  it('fails the run on the fifth wrong code; the right code then gets 409', async () => {
    const h = await harness(record({ wrongResultCodes: 4 }));
    const res = await post(h, BODY, 'wrong-code-acme');
    expect(res.status).toBe(401);
    const stored = await h.read();
    expect(stored?.wrongResultCodes).toBe(MAX_WRONG_RESULT_CODES);
    expect(stored?.state).toBe('failed');
    expect(stored?.failureReason).toBe(RESULT_ERRORS.tooManyCodes);
    expect(stored?.resultCodeHash).toBeNull();
    expect(stored?.updatedAt).toBe(NOW.toISOString());
    expect(h.onFailed).toHaveBeenCalledTimes(1);
    expect(h.onFailed.mock.calls[0][0]).toMatchObject({ runId: RUN_ID, state: 'failed' });
    expect(log.mock.calls.filter((c) => String(c[0]).startsWith('[AUDIT]'))).toHaveLength(1);

    const right = await post(h, BODY);
    expect(right.status).toBe(409);
    expect(h.onAccepted).not.toHaveBeenCalled();
  });

  it.each([
    ['no header', null],
    ['not Bearer', `Basic ${RESULT_CODE}`],
    ['empty Bearer', ''],
  ])('counts %s as a wrong code', async (_name, header) => {
    const h = await harness();
    let req = request(h.app).post(`/results/${RUN_ID}`).set('Content-Type', 'application/json');
    if (header !== null) req = req.set('Authorization', header);
    const res = await req.send(BODY);
    expect(res.status).toBe(401);
    expect((await h.read())?.wrongResultCodes).toBe(1);
  });

  it.each<RunState>(['waiting', 'cloning', 'finished', 'failed'])(
    'answers 409 without counting when the run is %s',
    async (state) => {
      const h = await harness(record({ state }));
      const res = await post(h, BODY);
      expect(res.status).toBe(409);
      const wrong = await post(h, BODY, 'wrong-code-acme');
      expect(wrong.status).toBe(409);
      const stored = await h.read();
      expect(stored?.wrongResultCodes).toBeUndefined();
      expect(stored?.result).toBeNull();
    },
  );

  it('answers 409 when the record has no valid code hash', async () => {
    const h = await harness(record({ resultCodeHash: null }));
    expect((await post(h, BODY)).status).toBe(409);
    const h2 = await harness(record({ resultCodeHash: RESULT_HASH.toUpperCase() }));
    expect((await post(h2, BODY)).status).toBe(409);
  });

  it('answers 404 for an unknown run or a malformed run ID', async () => {
    const h = await harness();
    const unknown = await post(h, BODY, RESULT_CODE, OTHER_RUN_ID);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: RESULT_ERRORS.notFound });
    expect((await post(h, BODY, RESULT_CODE, 'not-a-run')).status).toBe(404);
    expect((await post(h, BODY, RESULT_CODE, '..%2Fsettings')).status).toBe(404);
  });

  it('answers 413 for a body over the limit without consuming the code', async () => {
    const h = await harness();
    const big = JSON.stringify({ ...RESULT, explanation: 'x'.repeat(MAX_BODY) });
    const res = await post(h, big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: RESULT_ERRORS.tooLarge });
    // Exactly one byte over: the validator decides.
    const padded = BODY + ' '.repeat(MAX_BODY + 1 - Buffer.byteLength(BODY));
    expect((await post(h, padded)).status).toBe(413);
    // Exactly at the limit is fine.
    expect((await post(h, BODY + ' '.repeat(MAX_BODY - Buffer.byteLength(BODY)))).status).toBe(200);
  });

  it.each([
    ['invalid JSON', '{"schemaVersion": 1,'],
    ['empty body', ''],
    ['a schema violation', JSON.stringify({ ...RESULT, failureReason: 'PAYMENTS_TIMEOUT' })],
    ['an extra field', JSON.stringify({ ...RESULT, extra: 'PAYMENTS_TIMEOUT' })],
  ])('answers 400 for %s and stores nothing', async (_name, body) => {
    const h = await harness();
    const res = await post(h, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: RESULT_ERRORS.invalid });
    const stored = await h.read();
    expect(stored?.result).toBeNull();
    expect(stored?.resultCodeHash).toBe(RESULT_HASH);
  });

  it.each([
    ['explanation', JSON.stringify({ ...RESULT, explanation: `The key is ${API_KEY}.` })],
    ['patch', JSON.stringify({ ...RESULT, patch: `${RESULT.patch as string}+KEY=${API_KEY}\n` })],
    [
      'a \\u-escaped explanation',
      JSON.stringify({ ...RESULT, explanation: 'hidden' }).replace(
        'hidden',
        [...API_KEY].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
      ),
    ],
  ])('answers 422 when the %s holds the key; nothing is stored and the code stays', async (_name, body) => {
    expect(body.includes(API_KEY) || JSON.stringify(JSON.parse(body)).includes(API_KEY)).toBe(true);
    const h = await harness();
    const res = await post(h, body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: RESULT_ERRORS.containsKey });
    const stored = await h.read();
    expect(stored?.result).toBeNull();
    expect(stored?.resultCodeHash).toBe(RESULT_HASH);
    expect(warn.mock.calls.some((c) => String(c[0]).includes(RUN_ID))).toBe(true);
    // The code is not consumed: a clean result still lands.
    expect((await post(h, BODY)).status).toBe(200);
  });

  it('skips the key check when no key is known', async () => {
    const h = await harness(record(), { apiKey: null });
    const res = await post(h, JSON.stringify({ ...RESULT, explanation: `The key is ${API_KEY}.` }));
    expect(res.status).toBe(200);
    expect(allLogs()).not.toContain(API_KEY);
  });

  describe('personal key mode (story 5.1)', () => {
    const PERSONAL = 'sk-ant-api03-dana-personal-key-acme-WXYZ';

    it('refuses a result holding the requester\'s key, read asynchronously', async () => {
      const lookups: number[] = [];
      const h = await harness(record(), {
        keyRequired: true,
        apiKeyFor: async (r) => {
          lookups.push(r.requester.githubUserId);
          return PERSONAL;
        },
      });
      const res = await post(h, JSON.stringify({ ...RESULT, explanation: `The key is ${PERSONAL}.` }));
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: RESULT_ERRORS.containsKey });
      expect(lookups).toEqual([1000001]);
      expect(JSON.stringify(res.body)).not.toContain(PERSONAL);
      expect(allLogs()).not.toContain(PERSONAL);
      expect((await post(h, BODY)).status).toBe(200);
    });

    it('fails closed: a run whose key is gone has its result refused', async () => {
      const h = await harness(record(), { keyRequired: true, apiKeyFor: async () => null });
      const res = await post(h, BODY);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: RESULT_ERRORS.keyUnknown });
      expect((await h.read())?.result).toBeNull();
      expect(h.onAccepted).not.toHaveBeenCalled();
    });

    it('answers 503 when the key cannot be read from S3', async () => {
      const h = await harness(record(), {
        keyRequired: true,
        apiKeyFor: () => Promise.reject(new S3StoreError('unreachable', 'S3 cannot be reached.')),
      });
      const res = await post(h, BODY);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: RESULT_ERRORS.unavailable });
      expect((await h.read())?.result).toBeNull();
    });
  });

  it('accepts exactly one of two concurrent right posts', async () => {
    const h = await harness();
    const [a, b] = await Promise.all([post(h, BODY), post(h, BODY)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when S3 cannot be read', async () => {
    const store = createS3Store({ bucket: 'test-bucket', client: createMemoryS3Client() });
    const down: S3Store = {
      ...store,
      read: () => Promise.reject(new S3StoreError('unreachable', 'S3 cannot be reached.')),
    };
    const h = await harness(null, { store: down });
    const res = await post(h, BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: RESULT_ERRORS.unavailable });
  });

  it('answers 503 when the result cannot be written', async () => {
    const store = createS3Store({ bucket: 'test-bucket', client: createMemoryS3Client() });
    await store.create(`runs/${RUN_ID}.json`, record());
    const h = await harness(null, {
      store: { ...store, modify: () => Promise.reject(new S3StoreError('unreachable', 'S3 cannot be reached.')) },
    });
    expect((await post(h, BODY)).status).toBe(503);
    expect((await post(h, BODY, 'wrong-code-acme')).status).toBe(503);
  });

  it('answers 503 for a malformed run record', async () => {
    const store = createS3Store({ bucket: 'test-bucket', client: createMemoryS3Client() });
    await store.create(`runs/${RUN_ID}.json`, { runId: RUN_ID });
    const h = await harness(null, { store });
    const res = await post(h, BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: RESULT_ERRORS.unavailable });
  });

  it('answers 503 when the service fails unexpectedly', async () => {
    const store = createS3Store({ bucket: 'test-bucket', client: createMemoryS3Client() });
    await store.create(`runs/${RUN_ID}.json`, record());
    const service = createResultsService({
      store: () => store,
      validator: VALIDATOR,
      apiKeyFor: () => {
        throw new TypeError('invented failure');
      },
    });
    const res = await request(createResultsApp(service, MAX_BODY))
      .post(`/results/${RUN_ID}`)
      .set('Authorization', `Bearer ${RESULT_CODE}`)
      .set('Content-Type', 'application/json')
      .send(BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: RESULT_ERRORS.unavailable });
    expect(error.mock.calls.some((c) => String(c[0]).includes('(TypeError)'))).toBe(true);
    expect(allLogs()).not.toContain('invented failure');
  });

  it('still answers 200 when onAccepted throws or rejects', async () => {
    const h = await harness(record(), {
      onAccepted: () => {
        throw new Error('boom');
      },
    });
    expect((await post(h, BODY)).status).toBe(200);
    expect(error.mock.calls.some((c) => String(c[0]).startsWith('[ERROR]'))).toBe(true);

    error.mockClear();
    const h2 = await harness(record(), { onAccepted: () => Promise.reject(new Error('boom')) });
    expect((await post(h2, BODY)).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(error.mock.calls.some((c) => String(c[0]).startsWith('[ERROR]'))).toBe(true);
  });

  it.each([
    ['GET', `/results/${RUN_ID}`],
    ['PUT', `/results/${RUN_ID}`],
    ['POST', '/debug-it/runs/job/900001'],
    ['POST', '/results'],
    ['GET', '/health'],
    ['GET', '/api/health'],
  ])('answers 404 for %s %s', async (method, path) => {
    const h = await harness();
    const res = await request(h.app)[method.toLowerCase() as 'get' | 'put' | 'post'](path);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: RESULT_ERRORS.notFound });
  });

  it('answers 400 when the body cannot be read', async () => {
    const h = await harness();
    const res = await request(h.app)
      .post(`/results/${RUN_ID}`)
      .set('Authorization', `Bearer ${RESULT_CODE}`)
      .set('Content-Encoding', 'br-invented')
      .send(BODY);
    expect(res.status).toBe(400);
    expect((await h.read())?.result).toBeNull();
  });
});

describe('openResultsListener', () => {
  const servers: http.Server[] = [];

  describe('personal key mode default wiring (story 5.1)', () => {
    const PERSONAL = 'sk-ant-api03-dana-personal-key-acme-WXYZ';
    const REPLACEMENT = 'sk-ant-api03-dana-replacement-key-acme-QRST';
    const ENV = { USE_MOCK_DATA: 'true', DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY: '09'.repeat(32) };
    const tick = () => new Promise((r) => setTimeout(r, 5));

    beforeEach(() => {
      resetS3Store();
      resetPersonalKeyService();
      resetAnthropicAdapter();
    });

    afterAll(() => {
      resetS3Store();
      resetPersonalKeyService();
      resetAnthropicAdapter();
    });

    async function open(): Promise<string> {
      const store = getS3Store(ENV);
      const server = openResultsListener(
        { enabled: true, resultsPort: 0, credentialsMode: 'personal' },
        { schemaPath: SCHEMA_PATH, store: () => store, env: ENV },
      );
      servers.push(server!);
      if (!server!.listening) await new Promise((r) => server!.once('listening', r));
      return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    }

    const send = (base: string, body: string) =>
      request(base)
        .post(`/results/${RUN_ID}`)
        .set('Authorization', `Bearer ${RESULT_CODE}`)
        .set('Content-Type', 'application/json')
        .send(body);

    it('checks the requester\'s key; after a delete the result is refused (fail closed)', async () => {
      const keys = getPersonalKeyService(ENV, 'personal');
      expect((await keys.save(1000001, { key: PERSONAL })).ok).toBe(true);
      await tick();
      await getS3Store(ENV).create(`runs/${RUN_ID}.json`, record({ createdAt: new Date().toISOString() }));
      const base = await open();

      const leaked = await send(base, JSON.stringify({ ...RESULT, explanation: `The key is ${PERSONAL}.` }));
      expect(leaked.status).toBe(422);
      expect(leaked.body).toEqual({ error: RESULT_ERRORS.containsKey });

      expect((await keys.remove(1000001)).ok).toBe(true);
      const clean = await send(base, BODY);
      expect(clean.status).toBe(422);
      expect(clean.body).toEqual({ error: RESULT_ERRORS.keyUnknown });
      expect(allLogs()).not.toContain(PERSONAL);
    });

    it('a key replaced after the run was created: a result leaking the old key is refused', async () => {
      const keys = getPersonalKeyService(ENV, 'personal');
      await keys.save(1000001, { key: PERSONAL });
      await tick();
      await getS3Store(ENV).create(`runs/${RUN_ID}.json`, record({ createdAt: new Date().toISOString() }));
      await tick();
      await keys.save(1000001, { key: REPLACEMENT });
      const base = await open();

      const leaked = await send(base, JSON.stringify({ ...RESULT, explanation: `The key is ${PERSONAL}.` }));
      expect(leaked.status).toBe(422);
      expect(leaked.body).toEqual({ error: RESULT_ERRORS.keyUnknown });
      const clean = await send(base, BODY);
      expect(clean.body).toEqual({ error: RESULT_ERRORS.keyUnknown });
      expect(allLogs()).not.toContain(PERSONAL);
      expect(allLogs()).not.toContain(REPLACEMENT);
    });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it('opens nothing when Debug it is disabled', () => {
    expect(openResultsListener({ enabled: false, resultsPort: 0 })).toBeNull();
  });

  it('throws on a broken schema', () => {
    expect(() =>
      openResultsListener({ enabled: true, resultsPort: 0 }, { schemaPath: resolve(process.cwd(), 'package.json') }),
    ).toThrow();
  });

  it('serves POST /results/:runId and 404s everything else', async () => {
    const store = createS3Store({ bucket: 'test-bucket', client: createMemoryS3Client() });
    await store.create(`runs/${RUN_ID}.json`, record());
    const server = openResultsListener(
      { enabled: true, resultsPort: 0 },
      { schemaPath: SCHEMA_PATH, store: () => store, env: { DEBUG_IT_ANTHROPIC_API_KEY: ` ${API_KEY} ` } },
    );
    expect(server).not.toBeNull();
    servers.push(server!);
    if (!server!.listening) await new Promise((r) => server!.once('listening', r));
    await new Promise((r) => setImmediate(r));
    const { port } = server!.address() as AddressInfo;
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('[INFO]') && String(c[0]).includes(String(port)))).toBe(true);

    const base = `http://127.0.0.1:${port}`;
    expect((await request(base).get('/health')).status).toBe(404);

    // The default apiKeyFor reads the trimmed environment key.
    const withKey = await request(base)
      .post(`/results/${RUN_ID}`)
      .set('Authorization', `Bearer ${RESULT_CODE}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...RESULT, explanation: API_KEY }));
    expect(withKey.status).toBe(422);

    const ok = await request(base)
      .post(`/results/${RUN_ID}`)
      .set('Authorization', `Bearer ${RESULT_CODE}`)
      .set('Content-Type', 'application/json')
      .send(BODY);
    expect(ok.status).toBe(200);
    expect((await store.read<RunRecord>(`runs/${RUN_ID}.json`))?.value.resultCodeHash).toBeNull();
  });
});
