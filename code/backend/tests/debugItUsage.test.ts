import express from 'express';
import request from 'supertest';
import { registerDebugIt } from '../src/routes/debugIt';
import { DEBUG_IT_DEFAULTS, type DebugItConfig } from '../src/services/debugItConfig';
import { createSessionService } from '../src/services/session';
import { createMockGitHubApp, type GitHubApp } from '../src/adapters/githubApp';
import { createSettingsService } from '../src/services/debugIt/settings';
import { createMemoryS3Client, createS3Store, type S3Client, type S3Command } from '../src/adapters/s3Store';
import { CHECK_ERRORS } from '../src/routes/checkChain';
import type { IsolationStatus } from '../src/services/debugIt/isolation';
import { createRunService, RUN_ERRORS } from '../src/services/debugIt/runs';

const KEY = Buffer.alloc(32, 9);
const DANA = { uid: 1000001, login: 'dana' }; // administrator and allowed user
const LEE = { uid: 1000002, login: 'lee' }; // allowed user, not administrator
const REPO = 'acme/payments-api';
const NOVEMBER = new Date('2026-11-05T10:00:00.000Z');
const ON: IsolationStatus = { state: 'on', reason: null, checkedAt: '2026-11-05T09:00:00.000Z' };
const RUN_A = '00000000-0000-4000-8000-00000000000a';
const RUN_B = '00000000-0000-4000-8000-00000000000b';
const RUN_C = '00000000-0000-4000-8000-00000000000c';

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

const WRITES: ReadonlySet<string> = new Set(['PutObjectCommand', 'DeleteObjectCommand']);

function build(
  options: {
    config?: Partial<Pick<DebugItConfig, 'credentialsMode' | 'monthlyCap'>>;
    userLogin?: GitHubApp['userLogin'];
  } = {},
) {
  const memory = createMemoryS3Client();
  const sent: S3Command[] = [];
  let failLists = false;
  let failUsageReads = false;
  const client: S3Client = {
    async send(command: S3Command) {
      sent.push(command);
      if (failLists && command.name === 'ListObjectsV2Command') {
        throw Object.assign(new Error('TimeoutError'), { name: 'TimeoutError', $metadata: {} });
      }
      if (failUsageReads && command.name === 'GetObjectCommand' && String(command.input.Key).includes('usage/')) {
        throw Object.assign(new Error('TimeoutError'), { name: 'TimeoutError', $metadata: {} });
      }
      return memory.send(command);
    },
  };
  const store = createS3Store({ bucket: 'acme-bucket', client });
  const settings = createSettingsService({
    store,
    config: { administrators: ['1000001'], allowedRepositories: [REPO], allowedUsers: ['1000001', '1000002'] },
  });
  const mock = createMockGitHubApp();
  const logins: Record<number, string> = { 1000001: 'dana', 1000002: 'lee' };
  const github: GitHubApp = {
    ...mock,
    userLogin: jest.fn(options.userLogin ?? (async (id: number) => logins[id] ?? null)),
  };
  const isolation = { status: () => ON };
  const config = { ...DEBUG_IT_DEFAULTS, ...options.config };
  const runs = createRunService({ store, githubApp: github, config, isolation, organization: 'acme', now: () => NOVEMBER });
  const session = createSessionService(KEY, { secure: false });
  const app = express();
  app.use(express.json());
  registerDebugIt(
    app,
    { ...config, enabled: true, publicUrl: 'https://monitor.acme.example', githubAppClientId: 'Iv1.acme' },
    { session, githubApp: github, env: {}, settings, isolation, runs },
  );
  const as = (user = DANA) => {
    const cookie = `dbg_session=${session.seal(user)}`;
    return { get: (path: string) => request(app).get(path).set('Cookie', cookie) };
  };
  return {
    app,
    store,
    github,
    as,
    sent,
    failLists: () => {
      failLists = true;
    },
    failUsageReads: () => {
      failUsageReads = true;
    },
  };
}

function allLogs(): string {
  return [...log.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

function errorLines(): string[] {
  return error.mock.calls.map((a) => a.join(' ')).filter((line) => line.includes('[ERROR]'));
}

const entry = (runId: string, costUsd: number, fixPullRequests: unknown = 0) => ({ runId, costUsd, fixPullRequests });

describe('GET /debug-it/usage', () => {
  test('an administrator in organization mode sees one row per user of this month', async () => {
    const { as, store, sent } = build();
    await store.create('usage/2026-11/1000001.json', { entries: [entry(RUN_A, 0.4, 1), entry(RUN_B, 1.1, 0)] });
    await store.create('usage/2026-11/1000002.json', { entries: [entry(RUN_C, 0.25, 0)] });
    await store.create('usage/2026-10/1000002.json', { entries: [entry(RUN_C, 9, 3)] });
    await as().get('/debug-it/settings').expect(200); // the settings record exists before counting commands
    sent.length = 0;

    const res = await as().get('/debug-it/usage').expect(200);
    expect(res.body).toEqual({
      month: '2026-11',
      credentialsMode: 'organization',
      monthlyCap: 5,
      users: [
        { githubUserId: 1000001, login: 'dana', runs: 2, costUsd: 1.5, fixPullRequests: 1 },
        { githubUserId: 1000002, login: 'lee', runs: 1, costUsd: 0.25, fixPullRequests: 0 },
      ],
    });
    expect(sent.filter((c) => WRITES.has(c.name))).toEqual([]);
    // No run record is read (AD-3); only this month's usage objects.
    const keys = sent.filter((c) => c.name === 'GetObjectCommand').map((c) => String(c.input.Key));
    expect(keys.some((k) => k.includes('runs/'))).toBe(false);
    expect(keys.some((k) => k.includes('usage/2026-10/'))).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(RUN_A);
  });

  test('personal mode answers no monthly cap', async () => {
    const { as, store } = build({ config: { credentialsMode: 'personal' } });
    await store.create('usage/2026-11/1000002.json', { entries: [entry(RUN_A, 0, 0)] });
    const res = await as().get('/debug-it/usage').expect(200);
    expect(res.body.credentialsMode).toBe('personal');
    expect(res.body.monthlyCap).toBeNull();
    expect(res.body.users).toEqual([{ githubUserId: 1000002, login: 'lee', runs: 1, costUsd: 0, fixPullRequests: 0 }]);
  });

  test('no objects this month: no rows', async () => {
    const { as, store } = build();
    await store.create('usage/2026-10/1000001.json', { entries: [entry(RUN_A, 1, 0)] });
    const res = await as().get('/debug-it/usage').expect(200);
    expect(res.body).toEqual({ month: '2026-11', credentialsMode: 'organization', monthlyCap: 5, users: [] });
  });

  test('rows sort by cost, then runs, then ID; an empty entries list is kept', async () => {
    const { as, store } = build({ userLogin: async () => null });
    await store.create('usage/2026-11/1000005.json', { entries: [] });
    await store.create('usage/2026-11/1000004.json', {
      entries: [entry(RUN_A, 0.25, 0), entry(RUN_B, 0.25, 0), entry(RUN_C, 0.5, 0)],
    });
    await store.create('usage/2026-11/1000003.json', { entries: [entry(RUN_B, 0.5, 0), entry(RUN_C, 0.5, 0)] });
    await store.create('usage/2026-11/1000002.json', { entries: [entry(RUN_A, 0.5, 0), entry(RUN_B, 0.5, 0)] });
    const res = await as().get('/debug-it/usage').expect(200);
    expect(res.body.users.map((u: { githubUserId: number }) => u.githubUserId)).toEqual([1000004, 1000002, 1000003, 1000005]);
    expect(res.body.users[3]).toEqual({ githubUserId: 1000005, login: null, runs: 0, costUsd: 0, fixPullRequests: 0 });
  });

  test('non-finite or negative fix pull request counts count 0', async () => {
    const { as, store } = build();
    await store.create('usage/2026-11/1000001.json', {
      entries: [entry(RUN_A, 0.1, -2), entry(RUN_B, 0.1, 'three'), entry(RUN_C, 0.1, 2)],
    });
    const res = await as().get('/debug-it/usage').expect(200);
    expect(res.body.users[0].fixPullRequests).toBe(2);
  });

  test('a malformed object or bad key is skipped with one error line naming the key', async () => {
    const { as, store } = build();
    await store.create('usage/2026-11/1000001.json', { entries: 'secret-content-x' });
    await store.create('usage/2026-11/abc.json', { entries: [entry(RUN_A, 1, 0)] });
    await store.create('usage/2026-11/1000002.json', { entries: [entry(RUN_B, 0.3, 0)] });
    const res = await as().get('/debug-it/usage').expect(200);
    expect(res.body.users).toEqual([{ githubUserId: 1000002, login: 'lee', runs: 1, costUsd: 0.3, fixPullRequests: 0 }]);
    const lines = errorLines();
    expect(lines.filter((l) => l.includes('usage/2026-11/1000001.json'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('usage/2026-11/abc.json'))).toHaveLength(1);
    expect(allLogs()).not.toContain('secret-content-x');
    expect(allLogs()).not.toContain(RUN_A);
  });

  test('a failed login lookup answers the row with login null', async () => {
    const { as, store } = build({
      userLogin: async () => {
        throw new Error('GitHub down');
      },
    });
    await store.create('usage/2026-11/1000001.json', { entries: [entry(RUN_A, 1, 0)] });
    const res = await as().get('/debug-it/usage').expect(200);
    expect(res.body.users).toEqual([{ githubUserId: 1000001, login: null, runs: 1, costUsd: 1, fixPullRequests: 0 }]);
  });

  test('an allowed user who is not an administrator: 403', async () => {
    const { as } = build();
    const res = await as(LEE).get('/debug-it/usage').expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notAdministrator });
  });

  test('signed out: 401', async () => {
    const { app } = build();
    const res = await request(app).get('/debug-it/usage').expect(401);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notSignedIn });
  });

  test('S3 down on the list: 503 with the usage sentence', async () => {
    const { as, failLists } = build();
    await as().get('/debug-it/settings').expect(200); // the settings record is created first
    failLists();
    const res = await as().get('/debug-it/usage').expect(503);
    expect(res.body).toEqual({ error: RUN_ERRORS.s3Usage });
  });

  test('S3 down on a usage read after the list: 503 with the usage sentence', async () => {
    const { as, store, failUsageReads } = build();
    await store.create('usage/2026-11/1000001.json', { entries: [entry(RUN_A, 1, 0)], note: 'secret-content-y' });
    await as().get('/debug-it/settings').expect(200); // the settings record is created first
    failUsageReads();
    const res = await as().get('/debug-it/usage').expect(503);
    expect(res.body).toEqual({ error: RUN_ERRORS.s3Usage });
    expect(allLogs()).not.toContain('secret-content-y');
    expect(allLogs()).not.toContain(RUN_A);
  });
});
