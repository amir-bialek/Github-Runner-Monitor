import express from 'express';
import request from 'supertest';
import { registerDebugIt } from '../src/routes/debugIt';
import { DEBUG_IT_DEFAULTS } from '../src/services/debugItConfig';
import { createSessionService } from '../src/services/session';
import { createMockGitHubApp, GitHubAppError, type GitHubApp } from '../src/adapters/githubApp';
import { createSettingsService, type SettingsService } from '../src/services/debugIt/settings';
import { createMemoryS3Client, createS3Store, type S3Client, type S3Command } from '../src/adapters/s3Store';
import { SETTINGS_ERRORS } from '../src/routes/debugItSettings';
import { CHECK_ERRORS } from '../src/routes/checkChain';
import {
  getIsolationGate,
  ISOLATION_REASONS,
  resetIsolationGate,
  type IsolationStatus,
} from '../src/services/debugIt/isolation';
import { resetGitHubApp } from '../src/adapters/githubApp';
import { resetIsolationCheckRunner } from '../src/adapters/kubernetes';

const KEY = Buffer.alloc(32, 7);
const DANA = { uid: 1000001, login: 'dana' }; // administrator
const LEE = { uid: 1000002, login: 'lee' }; // allowed user, not administrator
const RECORD = 'debug-it/settings.json';

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

function fakeGitHubApp(overrides: Partial<GitHubApp> = {}) {
  const mock = createMockGitHubApp();
  return {
    ...mock,
    findUser: jest.fn(mock.findUser),
    userLogin: jest.fn(mock.userLogin),
    checkMembership: jest.fn(async () => true),
    ...overrides,
  };
}

const CHECKING: IsolationStatus = { state: 'checking', reason: ISOLATION_REASONS.checking, checkedAt: null };

function build(
  options: {
    client?: S3Client;
    github?: ReturnType<typeof fakeGitHubApp>;
    allowedUsers?: string[];
    isolation?: IsolationStatus;
  } = {},
) {
  const client = options.client ?? createMemoryS3Client();
  const store = createS3Store({ bucket: 'acme-bucket', client });
  const settings: SettingsService = createSettingsService({
    store,
    config: {
      administrators: ['1000001'],
      allowedRepositories: ['acme/payments-api'],
      allowedUsers: options.allowedUsers ?? ['1000001'],
    },
  });
  const github = options.github ?? fakeGitHubApp();
  const session = createSessionService(KEY, { secure: false });
  const app = express();
  app.use(express.json());
  registerDebugIt(
    app,
    { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'https://monitor.acme.example', githubAppClientId: 'Iv1.acme' },
    { session, githubApp: github, env: {}, settings, isolation: { status: () => options.isolation ?? CHECKING } },
  );
  const cookie = (user = DANA) => {
    const value = session.seal(user);
    return { header: `dbg_session=${value}`, csrf: session.csrfToken(value) };
  };
  const as = (user = DANA) => {
    const c = cookie(user);
    return {
      get: (path: string) => request(app).get(path).set('Cookie', c.header),
      post: (path: string, body: unknown) =>
        request(app).post(path).set('Cookie', c.header).set('X-CSRF-Token', c.csrf).send(body as object),
      del: (path: string) => request(app).delete(path).set('Cookie', c.header).set('X-CSRF-Token', c.csrf),
      csrf: c.csrf,
    };
  };
  return { app, store, settings, github, as, cookie };
}

function audits(): string[] {
  return log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT] Debug it settings:'));
}

function allLogs(): string {
  return [...log.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

beforeEach(() => {
  log.mockClear();
  error.mockClear();
});

describe('list', () => {
  test('an administrator sees both lists with logins', async () => {
    const { as } = build({ allowedUsers: ['1000001', '1000002'] });
    const res = await as().get('/debug-it/settings').expect(200);
    expect(res.body).toEqual({
      allowedRepositories: ['acme/payments-api'],
      allowedUsers: [
        { githubUserId: 1000001, login: 'dana' },
        { githubUserId: 1000002, login: 'lee' },
      ],
      isolation: CHECKING,
    });
    expect(audits()).toHaveLength(0);
  });

  test.each<[string, IsolationStatus]>([
    ['on', { state: 'on', reason: null, checkedAt: '2026-11-05T10:00:00.000Z' }],
    ['off', { state: 'off', reason: ISOLATION_REASONS.timeout, checkedAt: '2026-11-05T10:02:00.000Z' }],
  ])('the answer carries the isolation status (%s)', async (_name, isolation) => {
    const { as } = build({ isolation });
    const res = await as().get('/debug-it/settings').expect(200);
    expect(res.body.isolation).toEqual(isolation);
  });

  test('without an injected isolation the process gate answers', async () => {
    resetIsolationGate();
    resetGitHubApp();
    resetIsolationCheckRunner();
    try {
      const env = { USE_MOCK_DATA: 'true' };
      const client = createMemoryS3Client();
      const settings = createSettingsService({
        store: createS3Store({ bucket: 'acme-bucket', client }),
        config: { administrators: ['1000001'], allowedRepositories: ['acme/payments-api'], allowedUsers: ['1000001'] },
      });
      const session = createSessionService(KEY, { secure: false });
      const app = express();
      app.use(express.json());
      registerDebugIt(
        app,
        { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'https://monitor.acme.example', githubAppClientId: 'Iv1.acme' },
        { session, githubApp: fakeGitHubApp(), env, settings },
      );
      await getIsolationGate(env).run();
      const value = session.seal(DANA);
      const res = await request(app).get('/debug-it/settings').set('Cookie', `dbg_session=${value}`).expect(200);
      expect(res.body.isolation.state).toBe('on');
    } finally {
      resetIsolationGate();
      resetGitHubApp();
      resetIsolationCheckRunner();
    }
  });

  test('every change answers the isolation status too', async () => {
    const isolation: IsolationStatus = { state: 'off', reason: ISOLATION_REASONS.failed, checkedAt: '2026-11-05T10:02:00.000Z' };
    const { as } = build({ isolation });
    const res = await as().post('/debug-it/settings/repositories', { repository: 'acme/web' }).expect(200);
    expect(res.body.isolation).toEqual(isolation);
  });

  test('a failed or unknown login lookup shows null and the page still answers', async () => {
    const github = fakeGitHubApp({
      userLogin: jest.fn(async (id: number) => {
        if (id === 1000001) throw new GitHubAppError('GitHub did not answer the user login lookup request.');
        return null;
      }),
    });
    const { as } = build({ github, allowedUsers: ['1000001', '1000009'] });
    const res = await as().get('/debug-it/settings').expect(200);
    expect(res.body.allowedUsers).toEqual([
      { githubUserId: 1000001, login: null },
      { githubUserId: 1000009, login: null },
    ]);
  });
});

describe('repositories', () => {
  test('add stores the repository as typed and the next check allows it without a restart', async () => {
    const { as, settings, store } = build();
    expect(settings.isRepositoryAllowed(await settings.load(), 'acme/billing')).toBe(false);
    const res = await as().post('/debug-it/settings/repositories', { repository: '  Acme/Billing  ' }).expect(200);
    expect(res.body.allowedRepositories).toEqual(['acme/payments-api', 'Acme/Billing']);
    expect((await store.read<{ allowedRepositories: string[] }>('settings.json'))!.value.allowedRepositories).toEqual([
      'acme/payments-api',
      'Acme/Billing',
    ]);
    expect(settings.isRepositoryAllowed(await settings.load(), 'acme/billing')).toBe(true);
    expect(audits()).toEqual(['[AUDIT] Debug it settings: administrator 1000001 (dana) added repository Acme/Billing']);
  });

  test('a duplicate, compared case-insensitively, writes nothing and answers 200', async () => {
    const { as, store } = build();
    await as().get('/debug-it/settings').expect(200);
    const before = (await store.read('settings.json'))!.etag;
    const res = await as().post('/debug-it/settings/repositories', { repository: 'ACME/payments-api' }).expect(200);
    expect(res.body.allowedRepositories).toEqual(['acme/payments-api']);
    expect((await store.read('settings.json'))!.etag).toBe(before);
    expect(audits()).toHaveLength(0);
  });

  test.each([
    ['no slash', 'payments-api'],
    ['three parts', 'acme/payments/api'],
    ['empty owner', '/payments-api'],
    ['owner too long', `${'a'.repeat(40)}/x`],
    ['bad owner character', 'ac_me/x'],
    ['name too long', `acme/${'a'.repeat(101)}`],
    ['dot', 'acme/.'],
    ['dot dot', 'acme/..'],
    ['space inside', 'acme/pay ments'],
    ['not a string', 7],
    ['missing', undefined],
  ])('a bad repository (%s) is 400', async (_name, repository) => {
    const { as } = build();
    const res = await as().post('/debug-it/settings/repositories', { repository }).expect(400);
    expect(res.body).toEqual({ error: SETTINGS_ERRORS.badRepository });
  });

  test('remove takes it out and the next check refuses it', async () => {
    const { as, settings } = build();
    const res = await as().del('/debug-it/settings/repositories/acme/payments-api').expect(200);
    expect(res.body.allowedRepositories).toEqual([]);
    expect(settings.isRepositoryAllowed(await settings.load(), 'acme/payments-api')).toBe(false);
    expect(audits()).toEqual(['[AUDIT] Debug it settings: administrator 1000001 (dana) removed repository acme/payments-api']);
  });

  test('remove matches case-insensitively', async () => {
    const { as, settings } = build();
    const res = await as().del('/debug-it/settings/repositories/ACME/Payments-API').expect(200);
    expect(res.body.allowedRepositories).toEqual([]);
    expect(settings.isRepositoryAllowed(await settings.load(), 'acme/payments-api')).toBe(false);
  });

  test('removing an absent repository writes nothing and answers 200', async () => {
    const { as, store } = build();
    await as().get('/debug-it/settings').expect(200);
    const before = (await store.read('settings.json'))!.etag;
    await as().del('/debug-it/settings/repositories/acme/other').expect(200);
    expect((await store.read('settings.json'))!.etag).toBe(before);
    expect(audits()).toHaveLength(0);
  });

  test('remove with a bad name is 400', async () => {
    const { as } = build();
    await as().del('/debug-it/settings/repositories/acme/..').expect((res) => expect([400, 404]).toContain(res.status));
    await as().del('/debug-it/settings/repositories/ac_me/web').expect(400);
  });
});

describe('users', () => {
  test('add resolves the login and stores only the user ID', async () => {
    const { as, store, settings, github } = build();
    const res = await as().post('/debug-it/settings/users', { login: ' lee ' }).expect(200);
    expect(github.findUser).toHaveBeenCalledWith('lee');
    expect(github.checkMembership).toHaveBeenCalledWith('lee');
    expect(res.body.allowedUsers).toEqual([
      { githubUserId: 1000001, login: 'dana' },
      { githubUserId: 1000002, login: 'lee' },
    ]);
    expect((await store.read('settings.json'))!.value).toEqual({
      allowedRepositories: ['acme/payments-api'],
      allowedUsers: [{ githubUserId: 1000001 }, { githubUserId: 1000002 }],
    });
    expect(JSON.stringify((await store.read('settings.json'))!.value)).not.toContain('lee');
    expect(await settings.access(1000002)).toEqual({ allowedUser: true, administrator: false });
    expect(audits()).toEqual(['[AUDIT] Debug it settings: administrator 1000001 (dana) added user 1000002']);
  });

  test('adding a user already listed writes nothing', async () => {
    const { as } = build();
    await as().post('/debug-it/settings/users', { login: 'dana' }).expect(200);
    expect(audits()).toHaveLength(0);
  });

  test.each([['-lee'], ['lee-'], ['le--e'], ['a'.repeat(40)], ['lee@acme'], [''], [7]])(
    'a bad login (%p) is 400 with no GitHub call',
    async (login) => {
      const { as, github } = build();
      const res = await as().post('/debug-it/settings/users', { login }).expect(400);
      expect(res.body).toEqual({ error: SETTINGS_ERRORS.badLogin });
      expect(github.findUser).not.toHaveBeenCalled();
    },
  );

  test('an unknown login is 400', async () => {
    const { as } = build();
    const res = await as().post('/debug-it/settings/users', { login: 'eli' }).expect(400);
    expect(res.body).toEqual({ error: SETTINGS_ERRORS.unknownUser });
  });

  test('a user outside the organization is 400', async () => {
    const github = fakeGitHubApp({ checkMembership: jest.fn(async () => false) });
    const { as } = build({ github });
    const res = await as().post('/debug-it/settings/users', { login: 'sam' }).expect(400);
    expect(res.body).toEqual({ error: SETTINGS_ERRORS.notMember });
    expect(audits()).toHaveLength(0);
  });

  test('a GitHub failure is 502', async () => {
    const github = fakeGitHubApp({
      findUser: jest.fn(async () => {
        throw new GitHubAppError('GitHub did not answer the user lookup request.');
      }),
    });
    const { as } = build({ github });
    const res = await as().post('/debug-it/settings/users', { login: 'lee' }).expect(502);
    expect(res.body).toEqual({ error: SETTINGS_ERRORS.githubFailed });
  });

  test('remove takes the user out', async () => {
    const { as, settings } = build({ allowedUsers: ['1000001', '1000002'] });
    const res = await as().del('/debug-it/settings/users/1000002').expect(200);
    expect(res.body.allowedUsers).toEqual([{ githubUserId: 1000001, login: 'dana' }]);
    expect(await settings.access(1000002)).toEqual({ allowedUser: false, administrator: false });
    expect(audits()).toEqual(['[AUDIT] Debug it settings: administrator 1000001 (dana) removed user 1000002']);
  });

  test('removing an absent user writes nothing', async () => {
    const { as } = build();
    await as().del('/debug-it/settings/users/1000003').expect(200);
    expect(audits()).toHaveLength(0);
  });

  test.each(['abc', '0', '-1', '1.5', '99999999999999999999'])('remove with ID %s is 400', async (id) => {
    const { as } = build();
    const res = await as().del(`/debug-it/settings/users/${id}`).expect(400);
    expect(res.body).toEqual({ error: SETTINGS_ERRORS.badUserId });
  });
});

describe('races and failures', () => {
  // Writes another administrator's change just before the first conditional write.
  function racingClient(other = 'acme/web'): S3Client {
    const inner = createMemoryS3Client();
    let raced = false;
    return {
      async send(command: S3Command) {
        if (command.name === 'PutObjectCommand' && command.input.IfMatch !== undefined && !raced) {
          raced = true;
          const current = await inner.send({ name: 'GetObjectCommand', input: { Key: RECORD } });
          const value = JSON.parse(await current.Body.transformToString());
          value.allowedRepositories.push(other);
          await inner.send({ name: 'PutObjectCommand', input: { Key: RECORD, Body: JSON.stringify(value) } });
        }
        return inner.send(command);
      },
    };
  }

  test('a save racing another save keeps both changes', async () => {
    const { as, store } = build({ client: racingClient() });
    const res = await as().post('/debug-it/settings/repositories', { repository: 'acme/billing' }).expect(200);
    expect(res.body.allowedRepositories).toEqual(['acme/payments-api', 'acme/web', 'acme/billing']);
    expect((await store.read<{ allowedRepositories: string[] }>('settings.json'))!.value.allowedRepositories).toEqual([
      'acme/payments-api',
      'acme/web',
      'acme/billing',
    ]);
  });

  test('a race where another administrator saved the same entry first writes nothing more', async () => {
    const { as, store } = build({ client: racingClient('acme/billing') });
    const res = await as().post('/debug-it/settings/repositories', { repository: 'acme/billing' }).expect(200);
    expect(res.body.allowedRepositories).toEqual(['acme/payments-api', 'acme/billing']);
    expect((await store.read<{ allowedRepositories: string[] }>('settings.json'))!.value.allowedRepositories).toEqual([
      'acme/payments-api',
      'acme/billing',
    ]);
    expect(audits()).toHaveLength(0);
  });

  test('exhausted retries are 409', async () => {
    const inner = createMemoryS3Client();
    const client: S3Client = {
      async send(command: S3Command) {
        if (command.name === 'PutObjectCommand' && command.input.IfMatch !== undefined) {
          throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
        }
        return inner.send(command);
      },
    };
    const { as } = build({ client });
    const res = await as().post('/debug-it/settings/repositories', { repository: 'acme/billing' }).expect(409);
    expect(res.body).toEqual({ error: SETTINGS_ERRORS.conflict });
    expect(audits()).toHaveLength(0);
  });

  test('S3 down is 503 on every call', async () => {
    const client: S3Client = {
      async send() {
        throw Object.assign(new Error('down'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
      },
    };
    const { as } = build({ client });
    for (const res of [
      await as().get('/debug-it/settings'),
      await as().post('/debug-it/settings/repositories', { repository: 'acme/billing' }),
      await as().del('/debug-it/settings/repositories/acme/payments-api'),
      await as().post('/debug-it/settings/users', { login: 'lee' }),
      await as().del('/debug-it/settings/users/1000002'),
    ]) {
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: CHECK_ERRORS.settingsUnreadable });
    }
  });
});

describe('check chain', () => {
  const calls: Array<[string, string]> = [
    ['get', '/debug-it/settings'],
    ['post', '/debug-it/settings/repositories'],
    ['delete', '/debug-it/settings/repositories/acme/payments-api'],
    ['post', '/debug-it/settings/users'],
    ['delete', '/debug-it/settings/users/1000002'],
  ];

  test.each(calls)('%s %s without a session is 401', async (method, path) => {
    const { app } = build();
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(res.status).toBe(401);
  });

  test.each(calls)('%s %s as a non administrator is 403', async (method, path) => {
    const { app, cookie } = build({ allowedUsers: ['1000001', '1000002'] });
    const c = cookie(LEE);
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path)
      .set('Cookie', c.header)
      .set('X-CSRF-Token', c.csrf)
      .send({ repository: 'acme/billing', login: 'sam' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notAdministrator });
  });

  test.each(calls.filter(([m]) => m !== 'get'))('%s %s without CSRF is 403 and changes nothing', async (method, path) => {
    const { app, cookie, store } = build();
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path)
      .set('Cookie', cookie().header)
      .send({ repository: 'acme/billing', login: 'lee' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.csrf });
    expect(await store.read('settings.json')).toBeNull();
  });

  test('logs hold no CSRF token or session', async () => {
    const { as } = build();
    const admin = as();
    await admin.post('/debug-it/settings/repositories', { repository: 'acme/billing' }).expect(200);
    await admin.post('/debug-it/settings/users', { login: 'lee' }).expect(200);
    await admin.del('/debug-it/settings/users/1000002').expect(200);
    const text = allLogs();
    expect(text).not.toContain(admin.csrf);
    expect(text).not.toContain('dbg_session');
    expect(audits()).toHaveLength(3);
  });
});
