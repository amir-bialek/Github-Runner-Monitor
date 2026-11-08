import express from 'express';
import request from 'supertest';
import { registerDebugIt } from '../src/routes/debugIt';
import { DEBUG_IT_DEFAULTS, type LoginScope } from '../src/services/debugItConfig';
import { createSessionService, SESSION_TTL_SECONDS } from '../src/services/session';
import { GitHubAppError, type GitHubApp } from '../src/adapters/githubApp';
import { createSettingsService, type SettingsService } from '../src/services/debugIt/settings';
import { createMemoryS3Client, createS3Store } from '../src/adapters/s3Store';

const PUBLIC_URL = 'https://monitor.acme.example';
const CALLBACK = `${PUBLIC_URL}/api/debug-it/callback`;
const KEY = Buffer.alloc(32, 5);
const CODE = 'fake-oauth-code-777';

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

let now = Date.UTC(2026, 10, 5, 9, 0, 0);

function fakeGitHubApp(overrides: Partial<GitHubApp> = {}) {
  return {
    exchangeCode: jest.fn(async () => ({ githubUserId: 1000001, login: 'dana' })),
    checkMembership: jest.fn(async () => true),
    checkInstallation: jest.fn(async () => ({ installationId: 1, permissions: {}, forbidden: [] })),
    checkPermission: jest.fn(async () => 'read' as const),
    findUser: jest.fn(async () => null),
    userLogin: jest.fn(async () => null),
    readContextFile: jest.fn(async () => ({ status: 'missing' as const })),
    readWorkflowRun: jest.fn(async (repository: string, runId: number) => ({
      id: runId,
      headRepository: repository,
      headSha: null,
      headBranch: null,
      path: null,
    })),
    readLog: jest.fn(async () => {
      throw new GitHubAppError('not used');
    }),
    downloadTarball: jest.fn(async () => {
      throw new GitHubAppError('not used');
    }),
    checkRuleset: jest.fn(async () => {
      throw new GitHubAppError('not used');
    }),
    openFixPullRequest: jest.fn(async () => {
      throw new GitHubAppError('not used');
    }),
    ...overrides,
  };
}

function fakeSettings(options: { administrators?: string[]; allowedUsers?: string[] } = {}): SettingsService {
  return createSettingsService({
    store: createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() }),
    config: { administrators: options.administrators ?? [], allowedRepositories: [], allowedUsers: options.allowedUsers ?? [] },
  });
}

function build(
  options: {
    github?: ReturnType<typeof fakeGitHubApp>;
    env?: Record<string, string>;
    publicUrl?: string;
    settings?: SettingsService;
    loginScope?: LoginScope;
  } = {},
) {
  const github = options.github ?? fakeGitHubApp();
  const publicUrl = options.publicUrl ?? PUBLIC_URL;
  const session = createSessionService(KEY, { secure: publicUrl.startsWith('https'), now: () => now });
  const app = express();
  app.use(express.json());
  registerDebugIt(
    app,
    { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl, githubAppClientId: 'Iv1.acme', loginScope: options.loginScope ?? 'debug-it-only' },
    { session, githubApp: github, env: options.env ?? {}, settings: options.settings ?? fakeSettings() },
  );
  return { app, github, session };
}

function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
}

function cookie(res: request.Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

function cookieValue(res: request.Response, name: string): string {
  return cookie(res, name)!.split(';')[0]!.slice(name.length + 1);
}

function allLogs(): string {
  return [...log.mock.calls, ...error.mock.calls, ...(console.warn as jest.Mock).mock.calls]
    .map((args) => args.join(' '))
    .join('\n');
}

beforeEach(() => {
  log.mockClear();
  error.mockClear();
  now = Date.UTC(2026, 10, 5, 9, 0, 0);
});

async function startSignIn(app: express.Express) {
  const res = await request(app).get('/debug-it/sign-in').expect(302);
  const location = new URL(res.headers.location as string);
  return { res, state: location.searchParams.get('state')!, location };
}

async function signedIn(app: express.Express) {
  const { state } = await startSignIn(app);
  const res = await request(app)
    .get(`/debug-it/callback?code=${CODE}&state=${state}`)
    .set('Cookie', `dbg_oauth_state=${state}`)
    .expect(302);
  return { value: cookieValue(res, 'dbg_session'), state, res };
}

describe('GET /debug-it/sign-in', () => {
  test('redirects to GitHub with the client ID, callback and a fresh state cookie', async () => {
    const { app } = build();
    const { res, state, location } = await startSignIn(app);
    expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('Iv1.acme');
    expect(location.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie(res, 'dbg_oauth_state')).toBe(
      `dbg_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=600`,
    );
    const second = await startSignIn(app);
    expect(second.state).not.toBe(state);
  });

  test('strips a trailing slash from the public URL', async () => {
    const { app } = build({ publicUrl: 'https://monitor.acme.example/' });
    const { location } = await startSignIn(app);
    expect(location.searchParams.get('redirect_uri')).toBe('https://monitor.acme.example/api/debug-it/callback');
  });

  test('without an injected session, an https public URL gives Secure cookies', async () => {
    const app = express();
    registerDebugIt(app, { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'HTTPS://monitor.acme.example' }, { env: { USE_MOCK_DATA: 'true' } });
    const res = await request(app).get('/debug-it/sign-in').expect(302);
    expect(cookie(res, 'dbg_session')).toContain('; Secure');
  });

  test('no Secure flag when the public URL is http', async () => {
    const { app } = build({ publicUrl: 'http://localhost:3000' });
    const { res } = await startSignIn(app);
    expect(cookie(res, 'dbg_oauth_state')).not.toContain('Secure');
  });
});

describe('GET /debug-it/callback', () => {
  test('a member gets a session and is sent to the dashboard', async () => {
    const { app, github, session } = build();
    const { res, value, state } = await signedIn(app);
    expect(res.headers.location).toBe(`${PUBLIC_URL}/`);
    expect(cookie(res, 'dbg_session')).toBe(
      `dbg_session=${value}; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=${SESSION_TTL_SECONDS}`,
    );
    expect(cookie(res, 'dbg_oauth_state')).toContain('Max-Age=0');
    expect(session.open(value)).toEqual({ uid: 1000001, login: 'dana', exp: now / 1000 + SESSION_TTL_SECONDS });
    expect(github.exchangeCode).toHaveBeenCalledWith(CODE, CALLBACK);
    expect(github.checkMembership).toHaveBeenCalledWith('dana');

    const audit = log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT]') && l.includes('sign in'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('1000001');
    expect(audit[0]).toContain('dana');
    const logs = allLogs();
    for (const secret of [CODE, state, value]) expect(logs).not.toContain(secret);
  });

  test.each([
    ['no state cookie', (s: string) => ({ query: `code=${CODE}&state=${s}`, cookie: '' })],
    ['no state query', (s: string) => ({ query: `code=${CODE}`, cookie: `dbg_oauth_state=${s}` })],
    ['state mismatch', (s: string) => ({ query: `code=${CODE}&state=${'0'.repeat(64)}`, cookie: `dbg_oauth_state=${s}` })],
    ['state of another length', (s: string) => ({ query: `code=${CODE}&state=abc`, cookie: `dbg_oauth_state=${s}` })],
  ])('%s is 400 with no GitHub call', async (_name, make) => {
    const { app, github } = build();
    const { state } = await startSignIn(app);
    const { query, cookie: cookieHeader } = make(state);
    let req = request(app).get(`/debug-it/callback?${query}`);
    if (cookieHeader) req = req.set('Cookie', cookieHeader);
    const res = await req.expect(400);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(cookie(res, 'dbg_session')).toBeUndefined();
    expect(cookie(res, 'dbg_oauth_state')).toContain('Max-Age=0');
    expect(github.exchangeCode).not.toHaveBeenCalled();
    expect(github.checkMembership).not.toHaveBeenCalled();
  });

  test.each([
    ['no code', ''],
    ['GitHub error', `code=${CODE}&error=access_denied&`],
    ['GitHub error without code', 'error=access_denied&'],
  ])('%s is 400', async (_name, prefix) => {
    const { app, github } = build();
    const { state } = await startSignIn(app);
    const res = await request(app)
      .get(`/debug-it/callback?${prefix}state=${state}`)
      .set('Cookie', `dbg_oauth_state=${state}`)
      .expect(400);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(cookie(res, 'dbg_session')).toBeUndefined();
    expect(cookie(res, 'dbg_oauth_state')).toContain('Max-Age=0');
    expect(github.exchangeCode).not.toHaveBeenCalled();
  });

  test('a non member is 403 with no session', async () => {
    const github = fakeGitHubApp({ checkMembership: jest.fn(async () => false) });
    const { app } = build({ github });
    const { state } = await startSignIn(app);
    const res = await request(app)
      .get(`/debug-it/callback?code=${CODE}&state=${state}`)
      .set('Cookie', `dbg_oauth_state=${state}`)
      .expect(403);
    expect(res.body).toEqual({ error: 'Only members of the organization this monitor watches can sign in.' });
    expect(cookie(res, 'dbg_session')).toBeUndefined();
    expect(cookie(res, 'dbg_oauth_state')).toContain('Max-Age=0');
  });

  test.each([
    ['exchange', { exchangeCode: jest.fn(async () => { throw new Error(`bad code ${CODE} token fake-token-1`); }) }],
    ['membership', { checkMembership: jest.fn(async () => { throw new Error(`boom ${CODE} fake-token-1`); }) }],
  ])('%s failing is 502 with no session and no code in the answer or logs', async (_name, overrides) => {
    const { app } = build({ github: fakeGitHubApp(overrides as Partial<GitHubApp>) });
    const { state } = await startSignIn(app);
    const res = await request(app)
      .get(`/debug-it/callback?code=${CODE}&state=${state}`)
      .set('Cookie', `dbg_oauth_state=${state}`)
      .expect(502);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain(CODE);
    expect(JSON.stringify(res.body)).not.toContain('fake-token-1');
    expect(cookie(res, 'dbg_session')).toBeUndefined();
    expect(cookie(res, 'dbg_oauth_state')).toContain('Max-Age=0');
    const logs = allLogs();
    expect(logs).not.toContain(CODE);
    expect(logs).not.toContain('fake-token-1');
    expect(logs).not.toContain(state);
  });

  test('a GitHubAppError is logged with its safe message and no code', async () => {
    const github = fakeGitHubApp({
      checkMembership: jest.fn(async () => {
        throw new GitHubAppError('The Debug it GitHub App is not installed on the organization (GitHub answered 404).');
      }),
    });
    const { app } = build({ github });
    const { state } = await startSignIn(app);
    await request(app)
      .get(`/debug-it/callback?code=${CODE}&state=${state}`)
      .set('Cookie', `dbg_oauth_state=${state}`)
      .expect(502);
    const lines = error.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[ERROR]'));
    expect(lines).toEqual([
      '[ERROR] Debug it sign in failed: The Debug it GitHub App is not installed on the organization (GitHub answered 404).',
    ]);
    expect(lines[0]).not.toContain(CODE);
  });
});

describe('GET /debug-it/session', () => {
  test('a valid session returns the user, a CSRF token and no access by default', async () => {
    const { app, session } = build();
    const { value } = await signedIn(app);
    const res = await request(app).get('/debug-it/session').set('Cookie', `dbg_session=${value}`).expect(200);
    expect(res.body).toEqual({
      githubUserId: 1000001,
      login: 'dana',
      csrfToken: session.csrfToken(value),
      allowedUser: false,
      administrator: false,
      loginScope: 'debug-it-only',
      credentialsMode: 'organization',
    });
  });

  test('an allowed administrator gets both flags', async () => {
    const { app, session } = build({ settings: fakeSettings({ administrators: ['1000001'], allowedUsers: ['1000001'] }) });
    const { value } = await signedIn(app);
    const res = await request(app).get('/debug-it/session').set('Cookie', `dbg_session=${value}`).expect(200);
    expect(res.body).toEqual({
      githubUserId: 1000001,
      login: 'dana',
      csrfToken: session.csrfToken(value),
      allowedUser: true,
      administrator: true,
      loginScope: 'debug-it-only',
      credentialsMode: 'organization',
    });
  });

  test('an administrator who is not listed as allowed is not an allowed user', async () => {
    const { app } = build({ settings: fakeSettings({ administrators: ['1000001'], allowedUsers: ['1000002'] }) });
    const { value } = await signedIn(app);
    const res = await request(app).get('/debug-it/session').set('Cookie', `dbg_session=${value}`).expect(200);
    expect(res.body).toMatchObject({ allowedUser: false, administrator: true });
  });

  test('unreadable settings are 503 with no cookie in the logs', async () => {
    const settings = fakeSettings();
    settings.access = jest.fn(async () => {
      throw new Error('S3 down');
    });
    const { app } = build({ settings });
    const { value } = await signedIn(app);
    const res = await request(app).get('/debug-it/session').set('Cookie', `dbg_session=${value}`).expect(503);
    expect(res.body).toEqual({ error: 'Debug it settings could not be read; please try again.' });
    expect(allLogs()).not.toContain(value);
  });

  test.each([
    ['missing', () => ''],
    ['garbage', () => 'dbg_session=garbage'],
    ['another key', () => `dbg_session=${createSessionService(Buffer.alloc(32, 6), { secure: true }).seal({ uid: 1000001, login: 'dana' })}`],
  ])('%s is 401', async (_name, header) => {
    const { app } = build();
    let req = request(app).get('/debug-it/session');
    const h = header();
    if (h) req = req.set('Cookie', h);
    const res = await req.expect(401);
    expect(res.body).toEqual({ error: 'You are not signed in.', loginScope: 'debug-it-only' });
  });

  test.each(['debug-it-only', 'whole-dashboard'] as const)('the 401 and 200 bodies carry login scope %s', async (loginScope) => {
    const { app } = build({ loginScope });
    const out = await request(app).get('/debug-it/session').expect(401);
    expect(out.body).toEqual({ error: 'You are not signed in.', loginScope });
    const { value } = await signedIn(app);
    const res = await request(app).get('/debug-it/session').set('Cookie', `dbg_session=${value}`).expect(200);
    expect(res.body).toMatchObject({ login: 'dana', loginScope });
  });

  test('altered is 401', async () => {
    const { app } = build();
    const { value } = await signedIn(app);
    const raw = Buffer.from(value, 'base64url');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    await request(app).get('/debug-it/session').set('Cookie', `dbg_session=${raw.toString('base64url')}`).expect(401);
  });

  test('expired after 8 hours is 401', async () => {
    const { app } = build();
    const { value } = await signedIn(app);
    now += SESSION_TTL_SECONDS * 1000;
    await request(app).get('/debug-it/session').set('Cookie', `dbg_session=${value}`).expect(401);
  });
});

describe('POST /debug-it/sign-out', () => {
  test('with a valid CSRF token clears the cookie and logs once', async () => {
    const { app, session } = build();
    const { value } = await signedIn(app);
    log.mockClear();
    const res = await request(app)
      .post('/debug-it/sign-out')
      .set('Cookie', `dbg_session=${value}`)
      .set('X-CSRF-Token', session.csrfToken(value))
      .expect(204);
    expect(cookie(res, 'dbg_session')).toBe('dbg_session=; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=0');
    const audit = log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT]'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatch(/sign out.*1000001.*dana/);
    expect(allLogs()).not.toContain(value);
  });

  test.each([
    ['missing', undefined],
    ['wrong', 'not-the-token'],
  ])('%s CSRF token is 403 and keeps the cookie', async (_name, token) => {
    const { app } = build();
    const { value } = await signedIn(app);
    let req = request(app).post('/debug-it/sign-out').set('Cookie', `dbg_session=${value}`);
    if (token) req = req.set('X-CSRF-Token', token);
    const res = await req.expect(403);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(cookie(res, 'dbg_session')).toBeUndefined();
  });

  test('a CSRF token for another session is 403', async () => {
    const { app, session } = build();
    const first = await signedIn(app);
    const second = await signedIn(app);
    await request(app)
      .post('/debug-it/sign-out')
      .set('Cookie', `dbg_session=${first.value}`)
      .set('X-CSRF-Token', session.csrfToken(second.value))
      .expect(403);
  });

  test('no session is 204 and clears the cookie', async () => {
    const { app } = build();
    log.mockClear();
    const res = await request(app).post('/debug-it/sign-out').set('Cookie', 'dbg_session=garbage').expect(204);
    expect(cookie(res, 'dbg_session')).toContain('Max-Age=0');
    expect(log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT]'))).toHaveLength(0);
  });
});

describe('mock mode', () => {
  test('sign in creates a session for dana with no GitHub call', async () => {
    const { app, github, session } = build({ env: { USE_MOCK_DATA: 'true' } });
    const res = await request(app).get('/debug-it/sign-in').expect(302);
    expect(res.headers.location).toBe(`${PUBLIC_URL}/`);
    expect(session.open(cookieValue(res, 'dbg_session'))).toMatchObject({ uid: 1000001, login: 'dana' });
    expect(github.exchangeCode).not.toHaveBeenCalled();
    expect(github.checkMembership).not.toHaveBeenCalled();
    expect(log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT]') && l.includes('dana'))).toHaveLength(1);
  });

  test('builds its own random key and mock App from the environment', async () => {
    const app = express();
    registerDebugIt(app, { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'http://localhost:3000' }, { env: { USE_MOCK_DATA: 'true' } });
    const res = await request(app).get('/debug-it/sign-in').expect(302);
    const value = cookieValue(res, 'dbg_session');
    const session = await request(app).get('/debug-it/session').set('Cookie', `dbg_session=${value}`).expect(200);
    expect(session.body).toMatchObject({ githubUserId: 1000001, login: 'dana', allowedUser: true, administrator: true });
    expect(cookie(res, 'dbg_session')).not.toContain('Secure');
  });
});

describe('startup', () => {
  test('a bad session key fails startup when Debug it is on', () => {
    expect(() =>
      registerDebugIt(express(), { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: PUBLIC_URL }, {
        env: { DEBUG_IT_SESSION_ENCRYPTION_KEY: 'too-short' },
      }),
    ).toThrow(/DEBUG_IT_SESSION_ENCRYPTION_KEY/);
  });

  test('a bad session key is ignored when Debug it is off', () => {
    expect(registerDebugIt(express(), DEBUG_IT_DEFAULTS, { env: { DEBUG_IT_SESSION_ENCRYPTION_KEY: 'too-short' } })).toBe(false);
  });
});

describe('Debug it off', () => {
  test.each(['/debug-it/sign-in', '/debug-it/session', '/debug-it/callback'])('GET %s is 404', async (path) => {
    const app = express();
    registerDebugIt(app, DEBUG_IT_DEFAULTS, { session: createSessionService(KEY, { secure: false }), githubApp: fakeGitHubApp() });
    await request(app).get(path).expect(404);
  });
});
