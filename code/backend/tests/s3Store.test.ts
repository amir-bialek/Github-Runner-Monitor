const mockSdk = {
  regions: [] as Array<string | undefined>,
  sent: [] as Array<{ type: string; input: any }>,
};

// Stands in for the SDK module; the test never loads the real one.
jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    type = 'PutObjectCommand';
    constructor(public input: any) {}
  }
  class S3Client {
    constructor(config: { region?: string }) {
      mockSdk.regions.push(config.region);
    }
    async send(command: { type: string; input: any }) {
      mockSdk.sent.push(command);
      return { ETag: '"aws-1"' };
    }
  }
  return { __esModule: true, S3Client, PutObjectCommand };
});

import {
  createMemoryS3Client,
  createS3Store,
  getS3Store,
  resetS3Store,
  S3Command,
  S3StoreError,
} from '../src/adapters/s3Store';

const BUCKET = 'acme-runner-monitor';

function s3Error(name: string, status?: number): Error {
  const error = new Error(name) as Error & { $metadata?: { httpStatusCode?: number } };
  error.name = name;
  error.$metadata = status === undefined ? {} : { httpStatusCode: status };
  return error;
}

function getResponse(value: unknown, etag: string) {
  return { ETag: etag, Body: { transformToString: async () => JSON.stringify(value) } };
}

// A fake `{ send }` client: each call shifts the next scripted answer.
function fakeClient(answers: Array<unknown | ((c: S3Command) => unknown)>) {
  const calls: S3Command[] = [];
  const client = {
    send: jest.fn(async (command: S3Command) => {
      calls.push(command);
      if (!answers.length) throw new Error(`unexpected ${command.name}`);
      const next = answers.shift();
      const answer = typeof next === 'function' ? (next as (c: S3Command) => unknown)(command) : next;
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
  return { client, calls, store: createS3Store({ bucket: BUCKET, client }) };
}

async function expectStoreError(promise: Promise<unknown>, kind: string): Promise<S3StoreError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(S3StoreError);
    expect((error as S3StoreError).kind).toBe(kind);
    return error as S3StoreError;
  }
  throw new Error('expected the call to fail');
}

describe('s3Store against a fake client', () => {
  test('create sends If-None-Match: * under debug-it/ and returns the ETag', async () => {
    const { store, calls } = fakeClient([{ ETag: '"e1"' }]);
    await expect(store.create('runs/r1.json', { runId: 'r1', repository: 'acme/payments-api' })).resolves.toBe('"e1"');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('PutObjectCommand');
    expect(calls[0]!.input).toMatchObject({
      Bucket: BUCKET,
      Key: 'debug-it/runs/r1.json',
      IfNoneMatch: '*',
      ContentType: 'application/json',
    });
    expect(calls[0]!.input.IfMatch).toBeUndefined();
    expect(JSON.parse(calls[0]!.input.Body as string)).toEqual({ runId: 'r1', repository: 'acme/payments-api' });
  });

  test('create on an existing record does not retry and throws exists', async () => {
    const { store, calls } = fakeClient([s3Error('PreconditionFailed', 412)]);
    const error = await expectStoreError(store.create('runs/r1.json', { secret: 'body-value' }), 'exists');
    expect(calls).toHaveLength(1);
    expect(error.message).not.toContain('body-value');
  });

  test('read returns null for a missing record', async () => {
    const { store, calls } = fakeClient([s3Error('NoSuchKey', 404)]);
    await expect(store.read('settings.json')).resolves.toBeNull();
    expect(calls[0]).toEqual({ name: 'GetObjectCommand', input: { Bucket: BUCKET, Key: 'debug-it/settings.json' } });
  });

  test('read returns the value and ETag', async () => {
    const { store } = fakeClient([getResponse({ monthlyCap: 5 }, '"e7"')]);
    await expect(store.read('settings.json')).resolves.toEqual({ value: { monthlyCap: 5 }, etag: '"e7"' });
  });

  test('modify of an existing record sends If-Match with the ETag just read', async () => {
    const { store, calls } = fakeClient([getResponse({ count: 1 }, '"e1"'), { ETag: '"e2"' }]);
    const result = await store.modify<{ count: number }>('usage/2026-11/1000001.json', (c) => ({ count: (c?.count ?? 0) + 1 }));
    expect(result).toEqual({ count: 2 });
    expect(calls.map((c) => c.name)).toEqual(['GetObjectCommand', 'PutObjectCommand']);
    expect(calls[1]!.input).toMatchObject({ Key: 'debug-it/usage/2026-11/1000001.json', IfMatch: '"e1"' });
    expect(calls[1]!.input.IfNoneMatch).toBeUndefined();
  });

  test('modify of a missing record creates it with If-None-Match: *', async () => {
    const { store, calls } = fakeClient([s3Error('NoSuchKey', 404), { ETag: '"e1"' }]);
    const fn = jest.fn((current: { count: number } | null) => ({ count: (current?.count ?? 0) + 1 }));
    await expect(store.modify('usage/2026-11/1000001.json', fn)).resolves.toEqual({ count: 1 });
    expect(fn).toHaveBeenCalledWith(null);
    expect(calls[1]!.input).toMatchObject({ IfNoneMatch: '*' });
    expect(calls[1]!.input.IfMatch).toBeUndefined();
  });

  test.each([412, 409])('modify rereads and retries after %i, using the fresh value and ETag', async (status) => {
    const { store, calls } = fakeClient([
      getResponse({ count: 1 }, '"e1"'),
      s3Error('PreconditionFailed', status),
      getResponse({ count: 5 }, '"e2"'),
      { ETag: '"e3"' },
    ]);
    const fn = jest.fn((current: { count: number } | null) => ({ count: (current?.count ?? 0) + 1 }));
    await expect(store.modify('settings.json', fn)).resolves.toEqual({ count: 6 });
    expect(fn).toHaveBeenNthCalledWith(1, { count: 1 });
    expect(fn).toHaveBeenNthCalledWith(2, { count: 5 });
    expect(calls[1]!.input.IfMatch).toBe('"e1"');
    expect(calls[3]!.input.IfMatch).toBe('"e2"');
  });

  test('modify gives up after 1 try and 5 retries with a showable conflict error', async () => {
    const answers: unknown[] = [];
    for (let i = 0; i < 10; i += 1) {
      answers.push(getResponse({ count: i }, `"e${i}"`), s3Error('PreconditionFailed', i % 2 ? 409 : 412));
    }
    const { store, calls } = fakeClient(answers);
    const error = await expectStoreError(store.modify('settings.json', () => ({ token: 'body-value' })), 'conflict');
    expect(calls.filter((c) => c.name === 'PutObjectCommand')).toHaveLength(6);
    expect(calls.filter((c) => c.name === 'GetObjectCommand')).toHaveLength(6);
    expect(error.message).not.toContain('body-value');
    expect(error.message).toMatch(/^[A-Z][^\n]*\.$/);
  });

  test('modify writes nothing when fn returns undefined', async () => {
    const { store, calls } = fakeClient([getResponse({ count: 3 }, '"e1"')]);
    await expect(store.modify('settings.json', () => undefined)).resolves.toEqual({ count: 3 });
    expect(calls.map((c) => c.name)).toEqual(['GetObjectCommand']);
  });

  test.each([
    ['a network error with no status', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['a timeout', s3Error('TimeoutError')],
    ['a 503', s3Error('ServiceUnavailable', 503)],
    ['a 500', s3Error('InternalError', 500)],
  ])('%s maps to unreachable', async (_label, failure) => {
    const { store } = fakeClient([failure]);
    const error = await expectStoreError(store.read('settings.json'), 'unreachable');
    expect(error.message).toContain('S3 cannot be reached');
  });

  test('a write that cannot reach S3 is unreachable, not retried', async () => {
    const { store, calls } = fakeClient([getResponse({ a: 1 }, '"e1"'), s3Error('TimeoutError')]);
    await expectStoreError(store.modify('settings.json', () => ({ a: 2 })), 'unreachable');
    expect(calls).toHaveLength(2);
  });

  test('other S3 refusals map to failed', async () => {
    const { store } = fakeClient([s3Error('AccessDenied', 403)]);
    await expectStoreError(store.read('settings.json'), 'failed');
  });

  test('checkReachable sends HeadBucket and maps network failures', async () => {
    const ok = fakeClient([{}]);
    await expect(ok.store.checkReachable()).resolves.toBeUndefined();
    expect(ok.calls[0]).toEqual({ name: 'HeadBucketCommand', input: { Bucket: BUCKET } });
    const down = fakeClient([s3Error('TimeoutError')]);
    await expectStoreError(down.store.checkReachable(), 'unreachable');
  });

  test('deleteAllVersions pages and deletes every version of only the exact key', async () => {
    const key = 'debug-it/runs/r1.json';
    const { store, calls } = fakeClient([
      {
        Versions: [{ Key: key, VersionId: 'v3' }, { Key: key, VersionId: 'v2' }],
        DeleteMarkers: [{ Key: key, VersionId: 'm1' }],
        IsTruncated: true,
        NextKeyMarker: key,
        NextVersionIdMarker: 'v2',
      },
      {
        Versions: [{ Key: key, VersionId: 'v1' }, { Key: 'debug-it/runs/r1.json.bak', VersionId: 'x1' }],
        DeleteMarkers: [],
        IsTruncated: false,
      },
      {}, {}, {}, {},
    ]);
    await expect(store.deleteAllVersions('runs/r1.json')).resolves.toBe(4);
    const lists = calls.filter((c) => c.name === 'ListObjectVersionsCommand');
    expect(lists[0]!.input).toEqual({ Bucket: BUCKET, Prefix: key });
    expect(lists[1]!.input).toEqual({ Bucket: BUCKET, Prefix: key, KeyMarker: key, VersionIdMarker: 'v2' });
    const deletes = calls.filter((c) => c.name === 'DeleteObjectCommand');
    expect(deletes.map((c) => c.input.VersionId).sort()).toEqual(['m1', 'v1', 'v2', 'v3']);
    expect(deletes.every((c) => c.input.Key === key)).toBe(true);
  });

  test('deleteAllVersions maps an unreachable S3', async () => {
    const { store } = fakeClient([s3Error('ServiceUnavailable', 503)]);
    await expectStoreError(store.deleteAllVersions('runs/r1.json'), 'unreachable');
  });

  test.each(['', '/settings.json', '../settings.json', 'runs/../settings.json', 'runs//r1.json', './x.json', 'a\\b'])(
    'refuses the key %j without calling S3',
    async (key) => {
      const { store, client } = fakeClient([]);
      await expectStoreError(store.read(key), 'failed');
      await expectStoreError(store.create(key, {}), 'failed');
      await expectStoreError(store.modify(key, () => ({})), 'failed');
      await expectStoreError(store.deleteAllVersions(key), 'failed');
      expect(client.send).not.toHaveBeenCalled();
    },
  );
});

describe('s3Store memory backend', () => {
  const store = () => createS3Store({ bucket: BUCKET, client: createMemoryS3Client({ pageSize: 2 }) });

  test('create, read and conditional create', async () => {
    const s = store();
    await expect(s.read('runs/r1.json')).resolves.toBeNull();
    const etag = await s.create('runs/r1.json', { runId: 'r1' });
    await expect(s.read('runs/r1.json')).resolves.toEqual({ value: { runId: 'r1' }, etag });
    await expectStoreError(s.create('runs/r1.json', { runId: 'r1' }), 'exists');
  });

  test('modify updates with fresh ETags and creates when missing', async () => {
    const s = store();
    const add = (c: { count: number } | null) => ({ count: (c?.count ?? 0) + 1 });
    await expect(s.modify('usage/2026-11/1000001.json', add)).resolves.toEqual({ count: 1 });
    await expect(s.modify('usage/2026-11/1000001.json', add)).resolves.toEqual({ count: 2 });
    const first = await s.read('usage/2026-11/1000001.json');
    await s.modify('usage/2026-11/1000001.json', add);
    const second = await s.read('usage/2026-11/1000001.json');
    expect(second!.etag).not.toBe(first!.etag);
  });

  test('concurrent modifies all land, none lost', async () => {
    const s = store();
    await s.create('usage/2026-11/1000001.json', { entries: [] as string[] });
    await Promise.all(
      ['r1', 'r2', 'r3'].map((runId) =>
        s.modify<{ entries: string[] }>('usage/2026-11/1000001.json', (c) => ({ entries: [...(c?.entries ?? []), runId] })),
      ),
    );
    const result = await s.read<{ entries: string[] }>('usage/2026-11/1000001.json');
    expect(result!.value.entries.sort()).toEqual(['r1', 'r2', 'r3']);
  });

  test('a stale If-Match is refused with the same conflict semantics', async () => {
    const client = createMemoryS3Client();
    const s = createS3Store({ bucket: BUCKET, client });
    await s.create('settings.json', { v: 1 });
    // Another writer changes the record every time between our read and write.
    const fn = jest.fn((c: { v: number } | null) => {
      void client.send({
        name: 'PutObjectCommand',
        input: { Bucket: BUCKET, Key: 'debug-it/settings.json', Body: JSON.stringify({ v: 99 }) },
      });
      return { v: (c?.v ?? 0) + 1 };
    });
    await expectStoreError(s.modify('settings.json', fn), 'conflict');
    expect(fn).toHaveBeenCalledTimes(6);
  });

  test('deleteAllVersions removes every version and delete marker of the exact key only', async () => {
    const client = createMemoryS3Client({ pageSize: 2 });
    const s = createS3Store({ bucket: BUCKET, client });
    await s.create('runs/r1.json', { n: 1 });
    await s.modify('runs/r1.json', () => ({ n: 2 }));
    await s.modify('runs/r1.json', () => ({ n: 3 }));
    await client.send({ name: 'DeleteObjectCommand', input: { Bucket: BUCKET, Key: 'debug-it/runs/r1.json' } });
    await s.create('runs/r1.json.bak', { n: 9 });
    await expect(s.deleteAllVersions('runs/r1.json')).resolves.toBe(4);
    const left = await client.send({ name: 'ListObjectVersionsCommand', input: { Bucket: BUCKET, Prefix: 'debug-it/' } });
    expect([...left.Versions, ...left.DeleteMarkers].map((e: { Key: string }) => e.Key)).toEqual(['debug-it/runs/r1.json.bak']);
    await expect(s.read('runs/r1.json')).resolves.toBeNull();
  });
});

describe('s3Store list', () => {
  test('follows continuation tokens over a fake client and strips the debug-it/ prefix', async () => {
    const { store, calls } = fakeClient([
      {
        Contents: [{ Key: 'debug-it/usage/2026-11/1000001.json' }, { Key: 'debug-it/usage/2026-11/1000002.json' }],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      },
      { Contents: [{ Key: 'debug-it/usage/2026-11/1000003.json' }], IsTruncated: false },
    ]);
    await expect(store.list('usage/2026-11/')).resolves.toEqual([
      'usage/2026-11/1000001.json',
      'usage/2026-11/1000002.json',
      'usage/2026-11/1000003.json',
    ]);
    expect(calls.map((c) => c.name)).toEqual(['ListObjectsV2Command', 'ListObjectsV2Command']);
    expect(calls[0]!.input).toEqual({ Bucket: BUCKET, Prefix: 'debug-it/usage/2026-11/' });
    expect(calls[1]!.input).toEqual({ Bucket: BUCKET, Prefix: 'debug-it/usage/2026-11/', ContinuationToken: 'page-2' });
  });

  test('an empty answer is an empty list', async () => {
    const { store } = fakeClient([{ IsTruncated: false }]);
    await expect(store.list('usage/2026-11/')).resolves.toEqual([]);
  });

  test('a truncated page without a token fails', async () => {
    const { store } = fakeClient([{ Contents: [], IsTruncated: true }]);
    await expectStoreError(store.list('usage/2026-11/'), 'failed');
  });

  test('an unreachable bucket is unreachable', async () => {
    const { store } = fakeClient([s3Error('TimeoutError')]);
    await expectStoreError(store.list('usage/2026-11/'), 'unreachable');
  });

  test.each(['', '/usage/', 'usage/../runs/', 'usage//x'])('prefix %j is refused before any call', async (prefix) => {
    const { store, calls } = fakeClient([]);
    await expectStoreError(store.list(prefix), 'failed');
    expect(calls).toHaveLength(0);
  });

  test('the memory backend pages over current records only', async () => {
    const client = createMemoryS3Client({ pageSize: 2 });
    const s = createS3Store({ bucket: BUCKET, client });
    for (const uid of ['1000003', '1000001', '1000002', '1000004']) {
      await s.create(`usage/2026-11/${uid}.json`, { entries: [] });
    }
    await s.create('usage/2026-10/1000001.json', { entries: [] });
    await s.create('runs/r1.json', { runId: 'r1' });
    await client.send({ name: 'DeleteObjectCommand', input: { Bucket: BUCKET, Key: 'debug-it/usage/2026-11/1000004.json' } });
    const send = jest.spyOn(client, 'send');
    await expect(s.list('usage/2026-11/')).resolves.toEqual([
      'usage/2026-11/1000001.json',
      'usage/2026-11/1000002.json',
      'usage/2026-11/1000003.json',
    ]);
    expect(send.mock.calls.filter(([c]) => c.name === 'ListObjectsV2Command')).toHaveLength(2);
    await expect(s.list('usage/')).resolves.toHaveLength(4);
  });
});

describe('getS3Store', () => {
  afterEach(() => resetS3Store());

  test('uses the memory backend when USE_MOCK_DATA is true and keeps one instance', async () => {
    const s = getS3Store({ USE_MOCK_DATA: 'true' });
    expect(getS3Store({ USE_MOCK_DATA: 'true' })).toBe(s);
    await s.create('settings.json', { monthlyCap: 5 });
    await expect(s.read('settings.json')).resolves.toMatchObject({ value: { monthlyCap: 5 } });
    await expect(s.checkReachable()).resolves.toBeUndefined();
  });

  test('refuses to start without a bucket outside mock mode', () => {
    expect(() => getS3Store({})).toThrow(S3StoreError);
  });
});

describe('s3Store review cases', () => {
  test('a 409 on create is a conflict, not exists', async () => {
    const { store, calls } = fakeClient([s3Error('ConditionalRequestConflict', 409)]);
    await expectStoreError(store.create('runs/r1.json', { runId: 'r1' }), 'conflict');
    expect(calls).toHaveLength(1);
  });

  test('NoSuchBucket on read is failed, not a missing record', async () => {
    const { store } = fakeClient([s3Error('NoSuchBucket', 404)]);
    await expectStoreError(store.read('settings.json'), 'failed');
  });

  test('an invalid JSON body on read is failed', async () => {
    const { store } = fakeClient([{ ETag: '"e1"', Body: { transformToString: async () => '{not json' } }]);
    await expectStoreError(store.read('settings.json'), 'failed');
  });

  test('an error with no status that is not a network error is failed', async () => {
    const { store } = fakeClient([new TypeError('x is not a function')]);
    await expectStoreError(store.read('settings.json'), 'failed');
  });

  test('an ECONNREFUSED code is unreachable', async () => {
    const { store } = fakeClient([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })]);
    await expectStoreError(store.read('settings.json'), 'unreachable');
  });

  test('a value JSON cannot hold is refused before any S3 call', async () => {
    const { store, client } = fakeClient([]);
    await expectStoreError(store.create('runs/r1.json', undefined), 'failed');
    expect(client.send).not.toHaveBeenCalled();
  });

  test('modify recreates a record deleted between the read and the If-Match write', async () => {
    const { store, calls } = fakeClient([
      getResponse({ count: 1 }, '"e1"'),
      s3Error('NoSuchKey', 404),
      s3Error('NoSuchKey', 404),
      { ETag: '"e2"' },
    ]);
    const fn = jest.fn((current: { count: number } | null) => ({ count: (current?.count ?? 0) + 1 }));
    await expect(store.modify('settings.json', fn)).resolves.toEqual({ count: 1 });
    expect(fn).toHaveBeenNthCalledWith(2, null);
    expect(calls[1]!.input.IfMatch).toBe('"e1"');
    expect(calls[3]!.input).toMatchObject({ IfNoneMatch: '*' });
    expect(calls[3]!.input.IfMatch).toBeUndefined();
  });

  test('deleteAllVersions fails when a truncated page gives no next markers', async () => {
    const key = 'debug-it/runs/r1.json';
    const { store, calls } = fakeClient([{ Versions: [{ Key: key, VersionId: 'v1' }], IsTruncated: true }]);
    await expectStoreError(store.deleteAllVersions('runs/r1.json'), 'failed');
    expect(calls.filter((c) => c.name === 'DeleteObjectCommand')).toHaveLength(0);
  });

  test('deleteAllVersions counts only versions it deleted', async () => {
    const key = 'debug-it/runs/r1.json';
    const { store } = fakeClient([
      { Versions: [{ Key: key, VersionId: 'v1' }, { Key: key, VersionId: 'v2' }], IsTruncated: false },
      {},
      s3Error('NoSuchVersion', 404),
    ]);
    await expect(store.deleteAllVersions('runs/r1.json')).resolves.toBe(1);
  });

  test('concurrent modifies on an empty key all land', async () => {
    const s = createS3Store({ bucket: BUCKET, client: createMemoryS3Client() });
    await Promise.all(
      ['r1', 'r2', 'r3', 'r4'].map((runId) =>
        s.modify<{ entries: string[] }>('usage/2026-11/1000002.json', (c) => ({ entries: [...(c?.entries ?? []), runId] })),
      ),
    );
    const result = await s.read<{ entries: string[] }>('usage/2026-11/1000002.json');
    expect(result!.value.entries.sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  test('getS3Store with a bucket builds real SDK commands through the AWS client', async () => {
    resetS3Store();
    try {
      const store = getS3Store({ JOB_STATE_S3_BUCKET: 'acme-bucket' });
      await expect(store.create('runs/r1.json', { runId: 'r1' })).resolves.toBe('"aws-1"');
      expect(mockSdk.regions).toEqual(['us-east-2']);
      expect(mockSdk.sent).toHaveLength(1);
      expect(mockSdk.sent[0]!.type).toBe('PutObjectCommand');
      expect(mockSdk.sent[0]!.input).toMatchObject({
        Bucket: 'acme-bucket',
        Key: 'debug-it/runs/r1.json',
        IfNoneMatch: '*',
      });
      await expectStoreError(store.read('runs/r1.json'), 'failed');
    } finally {
      resetS3Store();
    }
  });
});
