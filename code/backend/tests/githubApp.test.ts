const mockSdk = {
  options: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Record<string, unknown>>,
};

// Stands in for the SDK module; the test never loads the real one.
jest.mock('@octokit/auth-app', () => ({
  __esModule: true,
  createAppAuth: (options: Record<string, unknown>) => {
    mockSdk.options.push(options);
    return async (authOptions: Record<string, unknown>) => {
      mockSdk.calls.push(authOptions);
      return { type: 'app', token: 'sdk-app-jwt' };
    };
  },
}));

import {
  CONTEXT_FILE_MAX_BYTES,
  CONTEXT_FILE_PATH,
  createGitHubApp,
  createMockGitHubApp,
  FIX_FILE_MAX_BYTES,
  cutTail,
  getGitHubApp,
  GitHubAppError,
  MOCK_CONTEXT_FILE,
  MOCK_JOB_LOG,
  MOCK_TARBALL_SHA,
  MOCK_WORKFLOW_FILE,
  resetGitHubApp,
  WORKFLOW_FILE_MAX_BYTES,
  type AppAuth,
  type FetchLike,
  type FixPullRequestInput,
} from '../src/adapters/githubApp';

import { applySection } from '../src/services/debugIt/patchApply';

const ORG = 'acme';

// Every token the fake auth issues; no adapter result may contain one.
const TOKENS = {
  app: 'fake-app-jwt-111',
  user: 'fake-user-token-222',
  installation: 'fake-installation-token-333',
};

function fakeAuth() {
  const calls: Array<Record<string, unknown>> = [];
  const auth: AppAuth = jest.fn(async (options: Record<string, unknown>) => {
    calls.push(options);
    if (options.type === 'app') return { type: 'app', token: TOKENS.app };
    if (options.type === 'oauth-user') return { type: 'token', token: TOKENS.user };
    if (options.type === 'installation') {
      return { type: 'token', token: TOKENS.installation, permissions: options.permissions };
    }
    throw new Error('unexpected auth type');
  });
  return { auth, calls };
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>) {
  const requests: Array<{ url: string; authorization: string | undefined; init?: RequestInit | undefined }> = [];
  const fetch: FetchLike = jest.fn(async (url: string, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    requests.push({ url, authorization, init });
    const path = url.replace('https://api.github.com', '');
    const route = routes[path];
    if (!route) throw new Error(`unexpected request ${path}`);
    return route(url, init);
  });
  return { fetch, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const INSTALLATION = {
  id: 4242,
  permissions: { actions: 'read', contents: 'write', members: 'read', metadata: 'read', pull_requests: 'write' },
};

function build(routes: Record<string, Route>) {
  const a = fakeAuth();
  const f = fakeFetch(routes);
  const app = createGitHubApp({
    appId: '123456',
    privateKey: 'fake-private-key',
    clientId: 'Iv1.acme',
    clientSecret: 'fake-client-secret',
    organization: ORG,
    auth: a.auth,
    fetch: f.fetch,
  });
  return { app, ...a, ...f };
}

function expectNoToken(value: unknown) {
  const text = JSON.stringify(value);
  for (const token of Object.values(TOKENS)) expect(text).not.toContain(token);
}

describe('exchangeCode', () => {
  test('returns the user ID and login and uses the user token once', async () => {
    const { app, calls, requests } = build({ '/user': () => json({ id: 1000001, login: 'dana' }) });
    const result = await app.exchangeCode('fake-code', 'https://monitor.acme.example/api/debug-it/callback');
    expect(result).toEqual({ githubUserId: 1000001, login: 'dana' });
    expectNoToken(result);
    expect(calls).toEqual([
      { type: 'oauth-user', code: 'fake-code', redirectUrl: 'https://monitor.acme.example/api/debug-it/callback' },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorization).toBe(`token ${TOKENS.user}`);
  });

  test('a failing exchange throws a GitHubAppError with no code or token', async () => {
    const { app, auth } = build({});
    (auth as jest.Mock).mockRejectedValueOnce(new Error('bad_verification_code fake-code'));
    const error = await app.exchangeCode('fake-code', 'x').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expect(error.message).not.toContain('fake-code');
  });

  test('a failing /user throws', async () => {
    const { app } = build({ '/user': () => json({ message: 'Bad credentials' }, 401) });
    await expect(app.exchangeCode('fake-code', 'x')).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('a user without an ID throws', async () => {
    const { app } = build({ '/user': () => json({ login: 'dana' }) });
    await expect(app.exchangeCode('fake-code', 'x')).rejects.toBeInstanceOf(GitHubAppError);
  });
});

describe('checkMembership', () => {
  function routes(status: number): Record<string, Route> {
    return {
      '/orgs/acme/installation': () => json(INSTALLATION),
      '/orgs/acme/members/dana': () => new Response(null, { status }),
    };
  }

  test('204 is a member, with a token narrowed to members read', async () => {
    const { app, calls, requests } = build(routes(204));
    const result = await app.checkMembership('dana');
    expect(result).toBe(true);
    expectNoToken(result);
    expect(calls).toEqual([
      { type: 'app' },
      { type: 'installation', installationId: 4242, permissions: { members: 'read' } },
    ]);
    expect(requests[0]!.authorization).toBe(`Bearer ${TOKENS.app}`);
    expect(requests[1]!.authorization).toBe(`token ${TOKENS.installation}`);
    expect(requests[1]!.init?.redirect).toBe('manual');
    for (const r of requests) expect(r.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([404, 302])('%i is not a member', async (status) => {
    const { app } = build(routes(status));
    expect(await app.checkMembership('dana')).toBe(false);
  });

  test('other answers throw', async () => {
    const { app } = build(routes(500));
    await expect(app.checkMembership('dana')).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('caches the installation ID and requests a token per call', async () => {
    const { app, calls, requests } = build(routes(204));
    await app.checkMembership('dana');
    await app.checkMembership('dana');
    expect(requests.filter((r) => r.url.endsWith('/orgs/acme/installation'))).toHaveLength(1);
    expect(calls.filter((c) => c.type === 'installation')).toHaveLength(2);
  });

  test('a missing installation throws', async () => {
    const { app } = build({ '/orgs/acme/installation': () => json({ message: 'Not Found' }, 404) });
    await expect(app.checkMembership('dana')).rejects.toBeInstanceOf(GitHubAppError);
  });
});

describe('checkInstallation', () => {
  test('returns the permissions with the App token only, never an installation token', async () => {
    const { app, calls, requests } = build({ '/orgs/acme/installation': () => json(INSTALLATION) });
    const result = await app.checkInstallation();
    expect(result).toEqual({ installationId: 4242, permissions: INSTALLATION.permissions, forbidden: [] });
    expectNoToken(result);
    expect(calls).toEqual([{ type: 'app' }]);
    expect(requests).toHaveLength(1);
  });

  test('lists workflows and administration as forbidden', async () => {
    const { app } = build({
      '/orgs/acme/installation': () =>
        json({ id: 4242, permissions: { ...INSTALLATION.permissions, workflows: 'write', administration: 'read', organization_administration: 'write' } }),
    });
    expect((await app.checkInstallation()).forbidden).toEqual(['workflows', 'administration', 'organization_administration']);
  });

  test('a suspended installation throws', async () => {
    const { app } = build({
      '/orgs/acme/installation': () => json({ ...INSTALLATION, suspended_at: '2026-11-05T09:00:00Z' }),
    });
    await expect(app.checkInstallation()).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('a missing installation throws', async () => {
    const { app } = build({ '/orgs/acme/installation': () => json({ message: 'Not Found' }, 404) });
    await expect(app.checkInstallation()).rejects.toBeInstanceOf(GitHubAppError);
  });
});

describe('checkPermission', () => {
  const DANA = { githubUserId: 1000001, login: 'dana' };
  const PATH = '/repos/acme/payments-api/collaborators/dana/permission';

  function buildWithClock(answer: () => Response) {
    let clock = Date.UTC(2026, 10, 5, 9, 0, 0);
    const a = fakeAuth();
    const f = fakeFetch({ '/orgs/acme/installation': () => json(INSTALLATION), [PATH]: answer });
    const app = createGitHubApp({
      appId: '123456',
      privateKey: 'fake-private-key',
      clientId: 'Iv1.acme',
      clientSecret: 'fake-client-secret',
      organization: ORG,
      auth: a.auth,
      fetch: f.fetch,
      now: () => clock,
    });
    const permissionCalls = () => f.requests.filter((r) => r.url.endsWith('/permission')).length;
    return { app, ...a, ...f, permissionCalls, advance: (ms: number) => (clock += ms) };
  }

  function answer(role_name: string | undefined, permission: string | undefined, id = 1000001) {
    return () => json({ role_name, permission, user: { id, login: 'dana' } });
  }

  test.each([
    ['admin', 'admin', 'write'],
    ['maintain', 'write', 'write'],
    ['write', 'write', 'write'],
    ['triage', 'read', 'read'],
    ['read', 'read', 'read'],
    ['custom-role', 'admin', 'write'],
    ['custom-role', 'write', 'write'],
    ['custom-role', 'read', 'read'],
    ['custom-role', 'none', 'none'],
    [undefined, undefined, 'none'],
  ])('role %s with permission %s is %s', async (role, permission, expected) => {
    const { app } = buildWithClock(answer(role, permission));
    expect(await app.checkPermission(DANA, 'acme/payments-api')).toBe(expected);
  });

  test('uses a token narrowed to the one repository and metadata read, and returns no token', async () => {
    const { app, calls, requests } = buildWithClock(answer('write', 'write'));
    const result = await app.checkPermission(DANA, 'acme/payments-api');
    expectNoToken(result);
    expect(calls.filter((c) => c.type === 'installation')).toEqual([
      { type: 'installation', installationId: 4242, repositoryNames: ['payments-api'], permissions: { metadata: 'read' } },
    ]);
    const permissionRequest = requests.find((r) => r.url.endsWith('/permission'))!;
    expect(permissionRequest.authorization).toBe(`token ${TOKENS.installation}`);
    expect(permissionRequest.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('404 is none', async () => {
    const { app } = buildWithClock(() => json({ message: 'Not Found' }, 404));
    expect(await app.checkPermission(DANA, 'acme/payments-api')).toBe('none');
  });

  test('an answer about another user ID is none', async () => {
    const { app } = buildWithClock(answer('admin', 'admin', 1000002));
    expect(await app.checkPermission(DANA, 'acme/payments-api')).toBe('none');
  });

  test('a cached answer is reused within 5 minutes, case-insensitively', async () => {
    const { app, permissionCalls, advance } = buildWithClock(answer('write', 'write'));
    await app.checkPermission(DANA, 'acme/payments-api');
    advance(5 * 60 * 1000 - 1);
    expect(await app.checkPermission(DANA, 'ACME/Payments-API')).toBe('write');
    expect(permissionCalls()).toBe(1);
  });

  test('a clock moved behind a cached entry asks GitHub again', async () => {
    const { app, permissionCalls, advance } = buildWithClock(answer('write', 'write'));
    await app.checkPermission(DANA, 'acme/payments-api');
    advance(-60 * 60 * 1000);
    await app.checkPermission(DANA, 'acme/payments-api');
    expect(permissionCalls()).toBe(2);
  });

  test('the cache is per user ID', async () => {
    const { app, permissionCalls } = buildWithClock(answer('write', 'write'));
    await app.checkPermission(DANA, 'acme/payments-api');
    await app.checkPermission({ githubUserId: 1000002, login: 'dana' }, 'acme/payments-api');
    expect(permissionCalls()).toBe(2);
  });

  test('after 5 minutes GitHub is asked again', async () => {
    const { app, permissionCalls, advance } = buildWithClock(answer('write', 'write'));
    await app.checkPermission(DANA, 'acme/payments-api');
    advance(5 * 60 * 1000);
    await app.checkPermission(DANA, 'acme/payments-api');
    expect(permissionCalls()).toBe(2);
  });

  test('fresh skips and refreshes the cache', async () => {
    let role = 'write';
    const { app, permissionCalls } = buildWithClock(() => json({ role_name: role, permission: role, user: { id: 1000001 } }));
    await app.checkPermission(DANA, 'acme/payments-api');
    role = 'read';
    expect(await app.checkPermission(DANA, 'acme/payments-api', { fresh: true })).toBe('read');
    expect(await app.checkPermission(DANA, 'acme/payments-api')).toBe('read');
    expect(permissionCalls()).toBe(2);
  });

  test('errors surface as GitHubAppError and are never cached', async () => {
    let status = 500;
    const { app, permissionCalls } = buildWithClock(() =>
      status === 500 ? json({ message: 'boom' }, 500) : json({ role_name: 'write', user: { id: 1000001 } }),
    );
    const error = await app.checkPermission(DANA, 'acme/payments-api').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
    status = 200;
    expect(await app.checkPermission(DANA, 'acme/payments-api')).toBe('write');
    expect(permissionCalls()).toBe(2);
  });

  test('a network failure surfaces as GitHubAppError', async () => {
    const { app } = buildWithClock(() => {
      throw new Error(`socket hang up ${TOKENS.installation}`);
    });
    const error = await app.checkPermission(DANA, 'acme/payments-api').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expect(error.message).not.toContain(TOKENS.installation);
  });

  test('a repository the App is not installed on is none and is cached', async () => {
    const { app, auth, requests } = buildWithClock(answer('write', 'write'));
    const fallback = (auth as jest.Mock).getMockImplementation()!;
    (auth as jest.Mock).mockImplementation(async (options: Record<string, unknown>) => {
      if (options.type === 'installation') {
        throw Object.assign(new Error('There is at least one repository that is not accessible'), { status: 422 });
      }
      return fallback(options);
    });
    expect(await app.checkPermission(DANA, 'acme/payments-api')).toBe('none');
    expect(await app.checkPermission(DANA, 'acme/payments-api')).toBe('none');
    expect(requests.filter((r) => r.url.endsWith('/permission'))).toHaveLength(0);
    expect((auth as jest.Mock).mock.calls.filter(([o]) => o.type === 'installation')).toHaveLength(1);
  });

  test('a failing token request surfaces as GitHubAppError and is never cached', async () => {
    const { app, auth, permissionCalls } = buildWithClock(answer('write', 'write'));
    const fallback = (auth as jest.Mock).getMockImplementation()!;
    let fail = true;
    (auth as jest.Mock).mockImplementation(async (options: Record<string, unknown>) => {
      if (options.type === 'installation' && fail) throw Object.assign(new Error('boom'), { status: 500 });
      return fallback(options);
    });
    await expect(app.checkPermission(DANA, 'acme/payments-api')).rejects.toBeInstanceOf(GitHubAppError);
    fail = false;
    expect(await app.checkPermission(DANA, 'acme/payments-api')).toBe('write');
    expect(permissionCalls()).toBe(1);
  });

  test('a repository outside the organization is none with no GitHub call', async () => {
    const { app, calls, requests } = buildWithClock(answer('write', 'write'));
    expect(await app.checkPermission(DANA, 'other-org/payments-api')).toBe('none');
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test('a malformed repository name is none with no GitHub call', async () => {
    const { app, requests } = buildWithClock(answer('write', 'write'));
    expect(await app.checkPermission(DANA, 'payments-api')).toBe('none');
    expect(requests).toHaveLength(0);
  });

  test('the mock App says write', async () => {
    expect(await createMockGitHubApp().checkPermission(DANA, 'acme/payments-api')).toBe('write');
  });
});

describe('findUser', () => {
  function routes(answer: Route): Record<string, Route> {
    return { '/orgs/acme/installation': () => json(INSTALLATION), '/users/lee': answer };
  }

  test('returns the ID and login with a members read token, and no token', async () => {
    const { app, calls, requests } = build(routes(() => json({ id: 1000002, login: 'lee', type: 'User' })));
    const result = await app.findUser('lee');
    expect(result).toEqual({ githubUserId: 1000002, login: 'lee' });
    expectNoToken(result);
    expect(calls).toEqual([
      { type: 'app' },
      { type: 'installation', installationId: 4242, permissions: { members: 'read' } },
    ]);
    expect(requests[1]!.authorization).toBe(`token ${TOKENS.installation}`);
    expect(requests[1]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('404 is null', async () => {
    const { app } = build(routes(() => json({ message: 'Not Found' }, 404)));
    expect(await app.findUser('lee')).toBeNull();
  });

  test('other answers throw a GitHubAppError with no token', async () => {
    const { app } = build(routes(() => json({ message: 'boom' }, 500)));
    const error = await app.findUser('lee').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
  });

  test('a network failure throws a GitHubAppError with no token', async () => {
    const { app } = build(
      routes(() => {
        throw new Error(`socket hang up ${TOKENS.installation}`);
      }),
    );
    const error = await app.findUser('lee').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expect(error.message).not.toContain(TOKENS.installation);
  });

  test('the mock App knows only the invented users', async () => {
    const mock = createMockGitHubApp();
    expect(await mock.findUser('dana')).toEqual({ githubUserId: 1000001, login: 'dana' });
    expect(await mock.findUser('lee')).toEqual({ githubUserId: 1000002, login: 'lee' });
    expect(await mock.findUser('sam')).toEqual({ githubUserId: 1000003, login: 'sam' });
    expect(await mock.findUser('eli')).toBeNull();
    expect(await mock.userLogin(1000002)).toBe('lee');
    expect(await mock.userLogin(1000009)).toBeNull();
  });
});

describe('userLogin', () => {
  function buildWithClock(answer: () => Response) {
    let clock = Date.UTC(2026, 10, 5, 9, 0, 0);
    const a = fakeAuth();
    const f = fakeFetch({ '/orgs/acme/installation': () => json(INSTALLATION), '/user/1000002': answer });
    const app = createGitHubApp({
      appId: '123456',
      privateKey: 'fake-private-key',
      clientId: 'Iv1.acme',
      clientSecret: 'fake-client-secret',
      organization: ORG,
      auth: a.auth,
      fetch: f.fetch,
      now: () => clock,
    });
    const lookups = () => f.requests.filter((r) => r.url.endsWith('/user/1000002')).length;
    return { app, ...a, ...f, lookups, advance: (ms: number) => (clock += ms) };
  }

  test('returns the login with a members read token, and no token', async () => {
    const { app, calls, requests } = buildWithClock(() => json({ id: 1000002, login: 'lee' }));
    const result = await app.userLogin(1000002);
    expect(result).toBe('lee');
    expectNoToken(result);
    expect(calls.filter((c) => c.type === 'installation')).toEqual([
      { type: 'installation', installationId: 4242, permissions: { members: 'read' } },
    ]);
    expect(requests.find((r) => r.url.endsWith('/user/1000002'))!.authorization).toBe(`token ${TOKENS.installation}`);
  });

  test('404 is null', async () => {
    const { app } = buildWithClock(() => json({ message: 'Not Found' }, 404));
    expect(await app.userLogin(1000002)).toBeNull();
  });

  test('an answer about another ID is null', async () => {
    const { app } = buildWithClock(() => json({ id: 1000003, login: 'sam' }));
    expect(await app.userLogin(1000002)).toBeNull();
  });

  test('is cached 5 minutes per ID, then GitHub is asked again', async () => {
    const { app, lookups, advance } = buildWithClock(() => json({ id: 1000002, login: 'lee' }));
    await app.userLogin(1000002);
    advance(5 * 60 * 1000 - 1);
    expect(await app.userLogin(1000002)).toBe('lee');
    expect(lookups()).toBe(1);
    advance(1);
    await app.userLogin(1000002);
    expect(lookups()).toBe(2);
  });

  test('a clock moved behind a cached entry asks GitHub again', async () => {
    const { app, lookups, advance } = buildWithClock(() => json({ id: 1000002, login: 'lee' }));
    await app.userLogin(1000002);
    advance(-60 * 60 * 1000);
    await app.userLogin(1000002);
    expect(lookups()).toBe(2);
  });

  test('errors throw and are never cached', async () => {
    let status = 500;
    const { app, lookups } = buildWithClock(() =>
      status === 500 ? json({ message: 'boom' }, 500) : json({ id: 1000002, login: 'lee' }),
    );
    const error = await app.userLogin(1000002).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
    status = 200;
    expect(await app.userLogin(1000002)).toBe('lee');
    expect(lookups()).toBe(2);
  });

  test('an invalid ID is null with no GitHub call', async () => {
    const { app, requests } = buildWithClock(() => json({ id: 1000002, login: 'lee' }));
    expect(await app.userLogin(0)).toBeNull();
    expect(await app.userLogin(1.5)).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

describe('readContextFile', () => {
  const PATH = '/repos/acme/payments-api/contents/.github/claude-debug-context.md';
  const TEXT = '## About this repo\n\npayments-api takes card payments. Ünïcode ✓\n';

  function file(text: string, extra: Record<string, unknown> = {}) {
    const content = Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
    return json({ type: 'file', path: CONTEXT_FILE_PATH, size: Buffer.byteLength(text), encoding: 'base64', content, ...extra });
  }

  function routes(answer: Route): Record<string, Route> {
    return { '/orgs/acme/installation': () => json(INSTALLATION), [PATH]: answer };
  }

  function failInstallationToken(auth: AppAuth, status: number) {
    const fallback = (auth as jest.Mock).getMockImplementation()!;
    (auth as jest.Mock).mockImplementation(async (options: Record<string, unknown>) => {
      if (options.type === 'installation') {
        throw Object.assign(new Error(`token request failed ${TOKENS.installation}`), { status });
      }
      return fallback(options);
    });
  }

  test('returns the decoded text with a token narrowed to contents read on one repository', async () => {
    const { app, calls, requests } = build(routes(() => file(TEXT)));
    const result = await app.readContextFile('acme/payments-api');
    expect(result).toEqual({ status: 'found', text: TEXT });
    expectNoToken(result);
    expect(calls.filter((c) => c.type === 'installation')).toEqual([
      { type: 'installation', installationId: 4242, repositoryNames: ['payments-api'], permissions: { contents: 'read' } },
    ]);
    const request = requests.find((r) => r.url.includes('/contents/'))!;
    expect(request.url).toBe(`https://api.github.com${PATH}`);
    expect(request.url).not.toContain('ref');
    expect(request.url).not.toContain('?');
    expect(request.authorization).toBe(`token ${TOKENS.installation}`);
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('a file of exactly 64 KiB is read', async () => {
    const text = 'a'.repeat(CONTEXT_FILE_MAX_BYTES);
    const { app } = build(routes(() => file(text)));
    expect(await app.readContextFile('acme/payments-api')).toEqual({ status: 'found', text });
  });

  test('404 is missing', async () => {
    const { app } = build(routes(() => json({ message: 'Not Found' }, 404)));
    expect(await app.readContextFile('acme/payments-api')).toEqual({ status: 'missing' });
  });

  test('a repository the App is not installed on (422 token) is missing, with no contents call', async () => {
    const { app, auth, requests } = build(routes(() => file(TEXT)));
    failInstallationToken(auth, 422);
    expect(await app.readContextFile('acme/payments-api')).toEqual({ status: 'missing' });
    expect(requests.filter((r) => r.url.includes('/contents/'))).toHaveLength(0);
  });

  test('another token failure throws a GitHubAppError with no token', async () => {
    const { app, auth } = build(routes(() => file(TEXT)));
    failInstallationToken(auth, 500);
    const error = await app.readContextFile('acme/payments-api').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
  });

  test.each([
    ['a directory listing', () => json([{ type: 'file', name: 'x.md' }])],
    ['a directory', () => json({ type: 'dir', size: 0 })],
    ['a symlink', () => json({ type: 'symlink', size: 10, target: '../README.md' })],
    ['a submodule', () => json({ type: 'submodule', size: 0 })],
  ])('%s is missing', async (_name, answer) => {
    const { app } = build(routes(answer));
    expect(await app.readContextFile('acme/payments-api')).toEqual({ status: 'missing' });
  });

  test('a file over 64 KiB is too-large', async () => {
    const { app } = build(routes(() => json({ type: 'file', size: 70000, encoding: 'none', content: '' })));
    expect(await app.readContextFile('acme/payments-api')).toEqual({ status: 'too-large' });
  });

  test('content larger than the size GitHub stated is still too-large', async () => {
    const { app } = build(routes(() => file('a'.repeat(CONTEXT_FILE_MAX_BYTES + 1), { size: 10 })));
    expect(await app.readContextFile('acme/payments-api')).toEqual({ status: 'too-large' });
  });

  test.each([undefined, '10'])('a file answer with size %j throws a GitHubAppError', async (size) => {
    const { app } = build(routes(() => json({ type: 'file', size, encoding: 'base64', content: '' })));
    await expect(app.readContextFile('acme/payments-api')).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('a file answer without content throws a GitHubAppError', async () => {
    const { app } = build(routes(() => json({ type: 'file', size: 10 })));
    await expect(app.readContextFile('acme/payments-api')).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('GitHub 500 throws a GitHubAppError with no token', async () => {
    const { app } = build(routes(() => json({ message: `boom ${TOKENS.installation}` }, 500)));
    const error = await app.readContextFile('acme/payments-api').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
  });

  test('a network failure throws a GitHubAppError with no token', async () => {
    const { app } = build(
      routes(() => {
        throw new Error(`socket hang up ${TOKENS.installation}`);
      }),
    );
    const error = await app.readContextFile('acme/payments-api').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
  });

  test('the organization is matched case-insensitively', async () => {
    const { app, requests } = build({
      '/orgs/acme/installation': () => json(INSTALLATION),
      '/repos/ACME/payments-api/contents/.github/claude-debug-context.md': () => file(TEXT),
    });
    expect(await app.readContextFile('ACME/payments-api')).toEqual({ status: 'found', text: TEXT });
    expect(requests).toHaveLength(2);
  });

  test.each(['other/x', 'payments-api', 'acme/payments-api/extra', '/payments-api', 'acme/', 'acme/..', 'acme/.'])(
    '%j throws a GitHubAppError before any token is requested',
    async (repository) => {
      const { app, calls, requests } = build(routes(() => file(TEXT)));
      await expect(app.readContextFile(repository)).rejects.toBeInstanceOf(GitHubAppError);
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);
    },
  );

  test('the mock App returns the example text with no GitHub call', async () => {
    const result = await createMockGitHubApp().readContextFile('acme/payments-api');
    expect(result).toEqual({ status: 'found', text: MOCK_CONTEXT_FILE });
    expect(MOCK_CONTEXT_FILE).toContain('## Extra repositories');
  });
});

describe('readWorkflowRun', () => {
  const PATH = '/repos/acme/payments-api/actions/runs/810001';
  const RUN = {
    id: 810001,
    head_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    head_branch: 'feature/refunds',
    head_repository: { full_name: 'acme/payments-api' },
    path: '.github/workflows/ci.yml',
  };

  function routes(answer: Route): Record<string, Route> {
    return { '/orgs/acme/installation': () => json(INSTALLATION), [PATH]: answer };
  }

  test('returns the head fields with a token narrowed to actions read on one repository', async () => {
    const { app, calls, requests } = build(routes(() => json(RUN)));
    const result = await app.readWorkflowRun('acme/payments-api', 810001);
    expect(result).toEqual({
      id: 810001,
      headRepository: 'acme/payments-api',
      headSha: RUN.head_sha,
      headBranch: 'feature/refunds',
      path: '.github/workflows/ci.yml',
    });
    expectNoToken(result);
    expect(calls.filter((c) => c.type === 'installation')).toEqual([
      { type: 'installation', installationId: 4242, repositoryNames: ['payments-api'], permissions: { actions: 'read' } },
    ]);
    const request = requests.find((r) => r.url.includes('/actions/runs/'))!;
    expect(request.url).toBe(`https://api.github.com${PATH}`);
    expect(request.authorization).toBe(`token ${TOKENS.installation}`);
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('a fork run names the fork as head repository', async () => {
    const { app } = build(routes(() => json({ ...RUN, head_repository: { full_name: 'someone/payments-api' } })));
    expect((await app.readWorkflowRun('acme/payments-api', 810001)).headRepository).toBe('someone/payments-api');
  });

  test('missing head fields are null', async () => {
    const { app } = build(routes(() => json({ id: 810001, head_repository: null })));
    expect(await app.readWorkflowRun('acme/payments-api', 810001)).toEqual({
      id: 810001,
      headRepository: null,
      headSha: null,
      headBranch: null,
      path: null,
    });
  });

  test('404 throws a GitHubAppError', async () => {
    const { app } = build(routes(() => json({ message: 'Not Found' }, 404)));
    await expect(app.readWorkflowRun('acme/payments-api', 810001)).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('GitHub 500 throws a GitHubAppError with no token', async () => {
    const { app } = build(routes(() => json({ message: `boom ${TOKENS.installation}` }, 500)));
    const error = await app.readWorkflowRun('acme/payments-api', 810001).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
  });

  test('an answer about another run throws a GitHubAppError', async () => {
    const { app } = build(routes(() => json({ ...RUN, id: 810002 })));
    await expect(app.readWorkflowRun('acme/payments-api', 810001)).rejects.toBeInstanceOf(GitHubAppError);
  });

  test.each(['other/payments-api', 'payments-api', 'acme/payments-api/extra', 'acme/..'])(
    '%j throws a GitHubAppError before any token is requested',
    async (repository) => {
      const { app, calls, requests } = build(routes(() => json(RUN)));
      await expect(app.readWorkflowRun(repository, 810001)).rejects.toBeInstanceOf(GitHubAppError);
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);
    },
  );

  test.each([0, -1, 1.5, Number.NaN])('run ID %p throws before any token is requested', async (runId) => {
    const { app, calls } = build(routes(() => json(RUN)));
    await expect(app.readWorkflowRun('acme/payments-api', runId)).rejects.toBeInstanceOf(GitHubAppError);
    expect(calls).toHaveLength(0);
  });

  test('the mock App names the repository itself as head repository', async () => {
    expect(await createMockGitHubApp().readWorkflowRun('acme/payments-api', 810001)).toEqual({
      id: 810001,
      headRepository: 'acme/payments-api',
      headSha: null,
      headBranch: null,
      path: MOCK_WORKFLOW_FILE.path,
    });
  });
});

function streamOf(...parts: Array<string | Buffer>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new Uint8Array(Buffer.from(part)));
      controller.close();
    },
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

const LOG_HOST = 'https://results-receiver.actions.githubusercontent.com/log?sig=fake-signature-444';
const CODELOAD = `https://codeload.github.com/acme/payments-api/legacy.tar.gz/abc?token=fake-codeload-token-555`;

describe('readWorkflowRun with the workflow file', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const RUN_PATH = '/repos/acme/payments-api/actions/runs/810001';
  const FILE_PATH = `/repos/acme/payments-api/contents/.github/workflows/ci.yml?ref=${SHA}`;
  const RUN = { id: 810001, head_sha: SHA, head_branch: 'main', head_repository: { full_name: 'acme/payments-api' }, path: '.github/workflows/ci.yml' };
  const FILE_TEXT = 'name: CI\non: [push]\n';

  function file(text = FILE_TEXT, extra: Record<string, unknown> = {}) {
    return json({ type: 'file', size: Buffer.byteLength(text), encoding: 'base64', content: Buffer.from(text).toString('base64'), ...extra });
  }

  function routes(run: unknown, answer: Route = () => file()): Record<string, Route> {
    return { '/orgs/acme/installation': () => json(INSTALLATION), [RUN_PATH]: () => json(run), [FILE_PATH]: answer };
  }

  test('reads the file at the run commit with a second token narrowed to contents read', async () => {
    const { app, calls, requests } = build(routes(RUN));
    const result = await app.readWorkflowRun('acme/payments-api', 810001, { workflowFile: true });
    expect(result.workflowFile).toEqual({ path: '.github/workflows/ci.yml', text: FILE_TEXT });
    expect(result.errorMessage).toBeNull();
    expectNoToken(result);
    expect(calls.filter((c) => c.type === 'installation')).toEqual([
      { type: 'installation', installationId: 4242, repositoryNames: ['payments-api'], permissions: { actions: 'read' } },
      { type: 'installation', installationId: 4242, repositoryNames: ['payments-api'], permissions: { contents: 'read' } },
    ]);
    expect(requests.map((r) => r.url)).toContain(`https://api.github.com${FILE_PATH}`);
  });

  test('without the option no file is read and the answer is unchanged', async () => {
    const { app, requests } = build(routes(RUN));
    const result = await app.readWorkflowRun('acme/payments-api', 810001);
    expect(result).not.toHaveProperty('workflowFile');
    expect(requests.some((r) => r.url.includes('/contents/'))).toBe(false);
  });

  test.each([
    ['a path outside .github/workflows', { path: 'scripts/ci.yml' }],
    ['a path with ..', { path: '.github/workflows/../../secrets.yml' }],
    ['a path with a query', { path: '.github/workflows/ci.yml?ref=main' }],
    ['no path', { path: null }],
    ['a short sha', { head_sha: 'a1b2c3' }],
    ['no sha', { head_sha: null }],
  ])('%s: null without a request', async (_name, change) => {
    const { app, requests, calls } = build(routes({ ...RUN, ...change }));
    const result = await app.readWorkflowRun('acme/payments-api', 810001, { workflowFile: true });
    expect(result.workflowFile).toBeNull();
    expect(requests.some((r) => r.url.includes('/contents/'))).toBe(false);
    expect(calls.filter((c) => c.type === 'installation')).toHaveLength(1);
  });

  test('404 is null', async () => {
    const { app } = build(routes(RUN, () => json({ message: 'Not Found' }, 404)));
    expect((await app.readWorkflowRun('acme/payments-api', 810001, { workflowFile: true })).workflowFile).toBeNull();
  });

  test('a file over 1 MiB is null', async () => {
    const { app } = build(routes(RUN, () => file('x', { size: WORKFLOW_FILE_MAX_BYTES + 1 })));
    expect((await app.readWorkflowRun('acme/payments-api', 810001, { workflowFile: true })).workflowFile).toBeNull();
  });

  test('GitHub 500 on the file throws a GitHubAppError with no token', async () => {
    const { app } = build(routes(RUN, () => json({ message: `boom ${TOKENS.installation}` }, 500)));
    const error = await app.readWorkflowRun('acme/payments-api', 810001, { workflowFile: true }).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
  });

  test('the mock App serves the invented workflow file', async () => {
    const result = await createMockGitHubApp().readWorkflowRun('acme/payments-api', 810001, { workflowFile: true });
    expect(result.workflowFile).toEqual(MOCK_WORKFLOW_FILE);
    expect(result.errorMessage).toBeNull();
  });
});

describe('readLog', () => {
  const PATH = '/repos/acme/payments-api/actions/jobs/900001/logs';

  test('follows the redirect without Authorization, with a token narrowed to actions read', async () => {
    const { app, calls, requests } = build({
      '/orgs/acme/installation': () => json(INSTALLATION),
      [PATH]: () => redirect(LOG_HOST),
      [LOG_HOST]: () => new Response(streamOf('line one\n', 'line two\n')),
    });
    const result = await app.readLog('acme/payments-api', 900001, 1024);
    expect(result).toEqual({ text: Buffer.from('line one\nline two\n'), truncated: false });
    expect(calls.filter((c) => c.type === 'installation')).toEqual([
      { type: 'installation', installationId: 4242, repositoryNames: ['payments-api'], permissions: { actions: 'read' } },
    ]);
    const api = requests.find((r) => r.url.endsWith('/logs'))!;
    expect(api.authorization).toBe(`token ${TOKENS.installation}`);
    expect(api.init?.redirect).toBe('manual');
    const host = requests.find((r) => r.url === LOG_HOST)!;
    expect(host.authorization).toBeUndefined();
    expect(JSON.stringify(host.init?.headers)).not.toContain(TOKENS.installation);
    expect(result.text.toString()).not.toContain('fake-signature');
  });

  test('a 200 answer is read directly', async () => {
    const { app } = build({ '/orgs/acme/installation': () => json(INSTALLATION), [PATH]: () => new Response(streamOf('ok\n')) });
    expect(await app.readLog('acme/payments-api', 900001, 1024)).toEqual({ text: Buffer.from('ok\n'), truncated: false });
  });

  test('a long log keeps its tail, starting at a line', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(4, '0')}\n`);
    const { app } = build({
      '/orgs/acme/installation': () => json(INSTALLATION),
      [PATH]: () => redirect(LOG_HOST),
      [LOG_HOST]: () => new Response(streamOf(...lines)),
    });
    const result = await app.readLog('acme/payments-api', 900001, 100);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
    const text = result.text.toString();
    expect(text.startsWith('line ')).toBe(true);
    expect(text.endsWith('line 1999\n')).toBe(true);
  });

  test('a cut log without any newline keeps the raw tail', async () => {
    const { app } = build({ '/orgs/acme/installation': () => json(INSTALLATION), [PATH]: () => new Response(streamOf('x'.repeat(50))) });
    expect(await app.readLog('acme/payments-api', 900001, 10)).toEqual({ text: Buffer.from('x'.repeat(10)), truncated: true });
  });

  test('a cut landing exactly on a line start keeps that line', () => {
    expect(cutTail(Buffer.from('aaa\nbbb\nccc\n'), 8)).toEqual({ text: Buffer.from('bbb\nccc\n'), truncated: true });
  });

  test('a streamed cut landing exactly on a line start keeps that line', async () => {
    const { app } = build({
      '/orgs/acme/installation': () => json(INSTALLATION),
      [PATH]: () => new Response(streamOf('aaa\n', 'bbb\n', 'ccc\n')),
    });
    expect(await app.readLog('acme/payments-api', 900001, 8)).toEqual({ text: Buffer.from('bbb\nccc\n'), truncated: true });
  });

  test('a tail whose only newline is its last byte is kept, not emptied', () => {
    expect(cutTail(Buffer.from('xxxxxxxx\n'), 5)).toEqual({ text: Buffer.from('xxxx\n'), truncated: true });
  });

  test('a cut inside a line drops the partial first line', () => {
    expect(cutTail(Buffer.from('aaa\nbbb\nccc\n'), 6)).toEqual({ text: Buffer.from('ccc\n'), truncated: true });
  });

  test.each([404, 410])('%i throws a GitHubAppError', async (status) => {
    const { app } = build({ '/orgs/acme/installation': () => json(INSTALLATION), [PATH]: () => json({}, status) });
    await expect(app.readLog('acme/payments-api', 900001, 1024)).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('a redirect to http is refused', async () => {
    const { app, requests } = build({ '/orgs/acme/installation': () => json(INSTALLATION), [PATH]: () => redirect('http://logs.example/x') });
    await expect(app.readLog('acme/payments-api', 900001, 1024)).rejects.toBeInstanceOf(GitHubAppError);
    expect(requests.some((r) => r.url.startsWith('http://'))).toBe(false);
  });

  test('a failed log host answer throws a GitHubAppError without its address', async () => {
    const { app } = build({
      '/orgs/acme/installation': () => json(INSTALLATION),
      [PATH]: () => redirect(LOG_HOST),
      [LOG_HOST]: () => new Response('denied', { status: 403 }),
    });
    const error = await app.readLog('acme/payments-api', 900001, 1024).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expect(error.message).not.toContain('fake-signature');
  });

  test.each(['other/payments-api', 'payments-api', 'acme/..'])('%j is refused before any token', async (repository) => {
    const { app, calls, requests } = build({});
    await expect(app.readLog(repository, 900001, 1024)).rejects.toBeInstanceOf(GitHubAppError);
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test.each([[0, 1024], [900001, 0], [1.5, 1024]])('job %p and limit %p are refused before any token', async (jobId, limit) => {
    const { app, calls } = build({});
    await expect(app.readLog('acme/payments-api', jobId, limit)).rejects.toBeInstanceOf(GitHubAppError);
    expect(calls).toHaveLength(0);
  });

  test('the mock App serves the invented log', async () => {
    expect(await createMockGitHubApp().readLog('acme/payments-api', 900001, 1024)).toEqual({
      text: Buffer.from(MOCK_JOB_LOG),
      truncated: false,
    });
  });
});

describe('downloadTarball', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const DEFAULT_SHA = 'b'.repeat(40);

  async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  function routes(commit: Route, tarball: Route = () => redirect(CODELOAD)): Record<string, Route> {
    return {
      '/orgs/acme/installation': () => json(INSTALLATION),
      [`/repos/acme/payments-api/commits/${SHA}`]: commit,
      '/repos/acme/payments-api/commits/HEAD': commit,
      [`/repos/acme/payments-api/tarball/${SHA}`]: tarball,
      [`/repos/acme/payments-api/tarball/${DEFAULT_SHA}`]: tarball,
      [CODELOAD]: () => new Response(streamOf('gzip-bytes-1', 'gzip-bytes-2')),
    };
  }

  test('resolves the sha, follows the redirect without Authorization and streams the body', async () => {
    const { app, calls, requests } = build(routes(() => new Response(SHA)));
    const result = await app.downloadTarball('acme/payments-api', SHA);
    expect(result.commitSha).toBe(SHA);
    expect(Object.keys(result).sort()).toEqual(['body', 'commitSha']);
    expect((await readAll(result.body)).toString()).toBe('gzip-bytes-1gzip-bytes-2');
    expect(calls.filter((c) => c.type === 'installation')).toEqual([
      {
        type: 'installation',
        installationId: 4242,
        repositoryNames: ['payments-api'],
        permissions: { contents: 'read', metadata: 'read' },
      },
    ]);
    const commit = requests.find((r) => r.url.includes('/commits/'))!;
    expect((commit.init?.headers as Record<string, string>).Accept).toBe('application/vnd.github.sha');
    const api = requests.find((r) => r.url.includes('/tarball/'))!;
    expect(api.init?.redirect).toBe('manual');
    expect(api.authorization).toBe(`token ${TOKENS.installation}`);
    const codeload = requests.find((r) => r.url === CODELOAD)!;
    expect(codeload.authorization).toBeUndefined();
    expect(JSON.stringify(codeload.init?.headers)).not.toContain(TOKENS.installation);
  });

  test('a null ref resolves the default branch', async () => {
    const { app, requests } = build(routes(() => new Response(`${DEFAULT_SHA}\n`)));
    const result = await app.downloadTarball('acme/payments-api', null);
    expect(result.commitSha).toBe(DEFAULT_SHA);
    expect(requests.some((r) => r.url.endsWith('/commits/HEAD'))).toBe(true);
    result.body.destroy();
  });

  test('a sha that resolves to another commit is refused', async () => {
    const { app, requests } = build(routes(() => new Response(DEFAULT_SHA)));
    await expect(app.downloadTarball('acme/payments-api', SHA)).rejects.toBeInstanceOf(GitHubAppError);
    expect(requests.some((r) => r.url.includes('/tarball/'))).toBe(false);
  });

  test('an answer that is not a full sha is refused', async () => {
    const { app } = build(routes(() => new Response('not-a-sha')));
    await expect(app.downloadTarball('acme/payments-api', null)).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('commit 404 throws a GitHubAppError', async () => {
    const { app } = build(routes(() => json({ message: 'Not Found' }, 404)));
    await expect(app.downloadTarball('acme/payments-api', SHA)).rejects.toBeInstanceOf(GitHubAppError);
  });

  test('tarball 500 throws a GitHubAppError with no token', async () => {
    const { app } = build(routes(() => new Response(SHA), () => json({ message: `boom ${TOKENS.installation}` }, 500)));
    const error = await app.downloadTarball('acme/payments-api', SHA).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expectNoToken(error.message);
    expect(error.message).not.toContain('codeload');
  });

  test('a redirect that is not https is refused', async () => {
    const { app } = build(routes(() => new Response(SHA), () => redirect('http://codeload.example/x')));
    await expect(app.downloadTarball('acme/payments-api', SHA)).rejects.toBeInstanceOf(GitHubAppError);
  });

  test.each(['other/payments-api', 'payments-api', 'acme/payments-api/x'])('%j is refused before any token', async (repository) => {
    const { app, calls, requests } = build({});
    await expect(app.downloadTarball(repository, SHA)).rejects.toBeInstanceOf(GitHubAppError);
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test.each(['../x', 'main?x=1', 'a//b'])('ref %j is refused before any token', async (ref) => {
    const { app, calls } = build({});
    await expect(app.downloadTarball('acme/payments-api', ref)).rejects.toBeInstanceOf(GitHubAppError);
    expect(calls).toHaveLength(0);
  });

  test('the mock App serves a tiny gzip tarball with a fixed sha', async () => {
    const { gunzipSync } = await import('zlib');
    const result = await createMockGitHubApp().downloadTarball('acme/payments-api', null);
    expect(result.commitSha).toBe(MOCK_TARBALL_SHA);
    const tar = gunzipSync(await readAll(result.body));
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(257, 262).toString('latin1')).toBe('ustar');
  });
});

describe('getGitHubApp', () => {
  afterEach(() => resetGitHubApp());

  test('mock mode signs in the invented member with no GitHub call', async () => {
    const app = getGitHubApp({ USE_MOCK_DATA: 'true' });
    expect(await app.exchangeCode('x', 'y')).toEqual({ githubUserId: 1000001, login: 'dana' });
    expect(await app.checkMembership('dana')).toBe(true);
    expect((await app.checkInstallation()).forbidden).toEqual([]);
  });

  test('throws when the App is not configured', () => {
    expect(() => getGitHubApp({})).toThrow(GitHubAppError);
  });

  test('loads the SDK lazily from the environment', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ id: 1000001, login: 'dana' }));
    try {
      const app = getGitHubApp({
        DEBUG_IT_GITHUB_APP_ID: '123456',
        DEBUG_IT_GITHUB_APP_CLIENT_ID: 'Iv1.acme',
        DEBUG_IT_GITHUB_APP_PRIVATE_KEY: 'line1\\nline2',
        DEBUG_IT_GITHUB_APP_CLIENT_SECRET: 'fake-client-secret',
        GITHUB_ORGANIZATION: ORG,
      });
      expect(mockSdk.options).toHaveLength(0);
      expect(await app.exchangeCode('fake-code', 'x')).toEqual({ githubUserId: 1000001, login: 'dana' });
      expect(mockSdk.options).toEqual([
        { appId: '123456', clientId: 'Iv1.acme', privateKey: 'line1\nline2', clientSecret: 'fake-client-secret' },
      ]);
      expect(mockSdk.calls).toEqual([{ type: 'oauth-user', code: 'fake-code', redirectUrl: 'x' }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('checkRuleset (story 4.2)', () => {
  const BASE = '/repos/acme/payments-api';

  function routes(rules: unknown[], rulesets: Record<number, unknown> = {}): Record<string, Route> {
    const r: Record<string, Route> = {
      '/orgs/acme/installation': () => json(INSTALLATION),
      [BASE]: () => json({ default_branch: 'main' }),
      [`${BASE}/rules/branches/main?per_page=100`]: () => json(rules),
    };
    for (const [id, body] of Object.entries(rulesets)) r[`${BASE}/rulesets/${id}?includes_parents=true`] = () => json(body);
    return r;
  }

  const ACTIVE_NEVER = { id: 7, enforcement: 'active', current_user_can_bypass: 'never' };
  const REVIEW = { type: 'pull_request', ruleset_id: 7, parameters: { required_approving_review_count: 1 } };

  test('no rule on the default branch: not protected', async () => {
    const { app, calls } = build(routes([]));
    expect(await app.checkRuleset('acme/payments-api')).toEqual({ protected: false });
    expect(calls.find((c) => c.type === 'installation')).toEqual({
      type: 'installation',
      installationId: 4242,
      repositoryNames: ['payments-api'],
      permissions: { metadata: 'read' },
    });
  });

  test('an active ruleset requiring a review that the App can never bypass: protected', async () => {
    const { app } = build(routes([REVIEW], { 7: ACTIVE_NEVER }));
    expect(await app.checkRuleset('acme/payments-api')).toEqual({ protected: true });
  });

  test('an update rule counts too', async () => {
    const { app } = build(routes([{ type: 'update', ruleset_id: 7 }], { 7: ACTIVE_NEVER }));
    expect(await app.checkRuleset('acme/payments-api')).toEqual({ protected: true });
  });

  test('evaluate mode does not count', async () => {
    const { app } = build(routes([REVIEW], { 7: { ...ACTIVE_NEVER, enforcement: 'evaluate' } }));
    expect(await app.checkRuleset('acme/payments-api')).toEqual({ protected: false });
  });

  test('a ruleset the App may bypass does not count', async () => {
    const { app } = build(routes([REVIEW], { 7: { ...ACTIVE_NEVER, current_user_can_bypass: 'always' } }));
    expect(await app.checkRuleset('acme/payments-api')).toEqual({ protected: false });
  });

  test('a pull request rule with no required approval and other rules are not read', async () => {
    const { app, requests } = build(
      routes([
        { type: 'pull_request', ruleset_id: 8, parameters: { required_approving_review_count: 0 } },
        { type: 'deletion', ruleset_id: 9 },
      ]),
    );
    expect(await app.checkRuleset('acme/payments-api')).toEqual({ protected: false });
    expect(requests.some((r) => r.url.includes('/rulesets/'))).toBe(false);
  });

  test('a GitHub failure throws a GitHubAppError without the token', async () => {
    const { app } = build({ ...routes([]), [`${BASE}/rules/branches/main?per_page=100`]: () => json({}, 500) });
    const failure = await app.checkRuleset('acme/payments-api').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GitHubAppError);
    expectNoToken((failure as Error).message);
  });

  test('a repository outside the organization is refused before any token', async () => {
    const { app, calls } = build({});
    await expect(app.checkRuleset('other/payments-api')).rejects.toBeInstanceOf(GitHubAppError);
    expect(calls).toHaveLength(0);
  });

  test('the mock App answers protected', async () => {
    expect(await createMockGitHubApp().checkRuleset('acme/payments-api')).toEqual({ protected: true });
  });
});

describe('openFixPullRequest (story 4.2)', () => {
  const BASE = '/repos/acme/payments-api';
  const COMMIT = 'c'.repeat(40);
  const ROOT = '1'.repeat(40);
  const SRC = '2'.repeat(40);
  const DB_BLOB = '3'.repeat(40);
  const NEW_TREE = '4'.repeat(40);
  const NEW_COMMIT = '5'.repeat(40);
  const NEW_BLOB = '6'.repeat(40);
  const BRANCH = 'debug-it/00000000-0000-4000-8000-000000000042/payments-api';
  const PR_URL = 'https://github.com/acme/payments-api/pull/17';
  const DB_TEXT = 'const a = 1;\nconst b = 2;\n';
  const SECTION = '--- a/payments-api/src/db.ts\n+++ b/payments-api/src/db.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n';

  function input(overrides: Partial<FixPullRequestInput> = {}): FixPullRequestInput {
    return {
      repository: 'acme/payments-api',
      commitSha: COMMIT,
      base: 'feature/refunds',
      branch: BRANCH,
      title: 'Debug it fix: test',
      body: 'body',
      sections: [{ oldPath: 'src/db.ts', newPath: 'src/db.ts', text: SECTION }],
      apply: applySection,
      ...overrides,
    };
  }

  function blob(text: string | Buffer, size?: number) {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    return json({ sha: DB_BLOB, size: size ?? bytes.length, encoding: 'base64', content: bytes.toString('base64') });
  }

  function routes(
    options: { srcEntries?: unknown[]; rootEntries?: unknown[]; blobAnswer?: () => Response; branch?: 200 | 404; open?: unknown[] } = {},
  ): Record<string, Route> {
    const branch = options.branch ?? 404;
    return {
      '/orgs/acme/installation': () => json(INSTALLATION),
      [`${BASE}/git/ref/heads/${BRANCH}`]: () => json(branch === 200 ? { ref: `refs/heads/${BRANCH}` } : { message: 'Not Found' }, branch),
      [`${BASE}/pulls?state=open&head=${encodeURIComponent(`acme:${BRANCH}`)}&per_page=1`]: () => json(options.open ?? []),
      [`${BASE}/git/commits/${COMMIT}`]: () => json({ sha: COMMIT, tree: { sha: ROOT } }),
      [`${BASE}/git/trees/${ROOT}`]: () =>
        json({ sha: ROOT, truncated: false, tree: options.rootEntries ?? [{ path: 'src', mode: '040000', type: 'tree', sha: SRC }] }),
      [`${BASE}/git/trees/${SRC}`]: () =>
        json({ sha: SRC, truncated: false, tree: options.srcEntries ?? [{ path: 'db.ts', mode: '100755', type: 'blob', sha: DB_BLOB }] }),
      [`${BASE}/git/blobs/${DB_BLOB}`]: options.blobAnswer ?? (() => blob(DB_TEXT)),
      [`${BASE}/git/blobs`]: () => json({ sha: NEW_BLOB }, 201),
      [`${BASE}/git/trees`]: () => json({ sha: NEW_TREE }, 201),
      [`${BASE}/git/commits`]: () => json({ sha: NEW_COMMIT }, 201),
      [`${BASE}/git/refs`]: () => json({ ref: `refs/heads/${BRANCH}` }, 201),
      [`${BASE}/git/refs/heads/${BRANCH}`]: () => json({ ref: `refs/heads/${BRANCH}` }),
      [`${BASE}/pulls`]: () => json({ html_url: PR_URL, number: 17 }, 201),
      [BASE]: () => json({ default_branch: 'main' }),
    };
  }

  const writes = (requests: Array<{ url: string; init?: RequestInit | undefined }>) =>
    requests
      .filter((r) => r.init?.method !== undefined && r.init.method !== 'GET')
      .map((r) => ({
        method: r.init!.method,
        path: r.url.replace('https://api.github.com', ''),
        body: JSON.parse(String(r.init!.body)) as Record<string, unknown>,
      }));

  test('reads at the commit, writes blob, tree, commit, a debug-it/ ref and a draft pull request', async () => {
    const { app, calls, requests } = build(routes());
    const outcome = await app.openFixPullRequest(input());
    expect(outcome).toEqual({ status: 'opened', url: PR_URL, number: 17, existing: false });
    expectNoToken(outcome);

    const tokens = calls.filter((c) => c.type === 'installation');
    expect(tokens).toEqual([
      {
        type: 'installation',
        installationId: 4242,
        repositoryNames: ['payments-api'],
        permissions: { contents: 'write', pull_requests: 'write' },
      },
    ]);

    const w = writes(requests);
    expect(w.map((x) => `${x.method} ${x.path}`)).toEqual([
      `POST ${BASE}/git/blobs`,
      `POST ${BASE}/git/trees`,
      `POST ${BASE}/git/commits`,
      `POST ${BASE}/git/refs`,
      `POST ${BASE}/pulls`,
    ]);
    expect(Buffer.from(String(w[0]!.body.content), 'base64').toString('utf8')).toBe('const a = 1;\nconst b = 3;\n');
    // The changed file keeps its mode.
    expect(w[1]!.body).toEqual({ base_tree: ROOT, tree: [{ path: 'src/db.ts', mode: '100755', type: 'blob', sha: NEW_BLOB }] });
    expect(w[2]!.body).toEqual({ message: 'Debug it fix: test', tree: NEW_TREE, parents: [COMMIT] });
    expect(w[3]!.body).toEqual({ ref: `refs/heads/${BRANCH}`, sha: NEW_COMMIT });
    expect(w[4]!.body).toEqual({ title: 'Debug it fix: test', body: 'body', head: BRANCH, base: 'feature/refunds', draft: true });
    // No merge, no write outside debug-it/.
    expect(requests.some((r) => /merge/.test(r.url))).toBe(false);
  });

  test('a null base opens against the default branch', async () => {
    const { app, requests } = build(routes());
    await app.openFixPullRequest(input({ base: null }));
    const w = writes(requests);
    expect(w[w.length - 1]!.body.base).toBe('main');
  });

  test('a new file is 100644, a delete or rename source is sha null', async () => {
    const { app, requests } = build(routes());
    await app.openFixPullRequest(
      input({
        sections: [
          {
            oldPath: null,
            newPath: 'src/new.ts',
            text: 'diff --git a/payments-api/src/new.ts b/payments-api/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/payments-api/src/new.ts\n@@ -0,0 +1 @@\n+x\n',
          },
          {
            oldPath: 'src/db.ts',
            newPath: 'src/moved.ts',
            text: 'diff --git a/payments-api/src/db.ts b/payments-api/src/moved.ts\nsimilarity index 100%\nrename from payments-api/src/db.ts\nrename to payments-api/src/moved.ts\n',
          },
        ],
      }),
    );
    const tree = writes(requests).find((w) => w.path === `${BASE}/git/trees`)!.body.tree;
    expect(tree).toEqual([
      { path: 'src/new.ts', mode: '100644', type: 'blob', sha: NEW_BLOB },
      { path: 'src/db.ts', mode: '100755', type: 'blob', sha: null },
      { path: 'src/moved.ts', mode: '100755', type: 'blob', sha: NEW_BLOB },
    ]);
  });

  test('a copy keeps its source: no sha null entry for it', async () => {
    const { app, requests } = build(routes());
    await app.openFixPullRequest(
      input({
        sections: [
          {
            oldPath: 'src/db.ts',
            newPath: 'src/copy.ts',
            text: 'diff --git a/payments-api/src/db.ts b/payments-api/src/copy.ts\nsimilarity index 100%\ncopy from payments-api/src/db.ts\ncopy to payments-api/src/copy.ts\n',
            copy: true,
          },
        ],
      }),
    );
    expect(writes(requests).find((w) => w.path === `${BASE}/git/trees`)!.body.tree).toEqual([
      { path: 'src/copy.ts', mode: '100755', type: 'blob', sha: NEW_BLOB },
    ]);
  });

  test('a branch created meanwhile (POST /git/refs 422) is force-moved instead', async () => {
    const { app, requests } = build({ ...routes(), [`${BASE}/git/refs`]: () => json({ message: 'Reference already exists' }, 422) });
    expect(await app.openFixPullRequest(input())).toMatchObject({ status: 'opened', existing: false });
    const w = writes(requests);
    expect(w.map((x) => `${x.method} ${x.path}`)).toContain(`POST ${BASE}/git/refs`);
    expect(w.find((x) => x.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: `${BASE}/git/refs/heads/${BRANCH}`,
      body: { sha: NEW_COMMIT, force: true },
    });
  });

  test('POST /pulls 422 with an open pull request found answers it as existing', async () => {
    // The branch is new, so the only lookup is the one after the 422.
    const { app } = build({
      ...routes(),
      [`${BASE}/pulls`]: () => json({ message: 'A pull request already exists' }, 422),
      [`${BASE}/pulls?state=open&head=${encodeURIComponent(`acme:${BRANCH}`)}&per_page=1`]: () =>
        json([{ html_url: PR_URL, number: 17 }]),
    });
    expect(await app.openFixPullRequest(input())).toEqual({ status: 'opened', url: PR_URL, number: 17, existing: true });
  });

  test('a deleted file is sha null', async () => {
    const { app, requests } = build(routes());
    await app.openFixPullRequest(
      input({
        sections: [
          {
            oldPath: 'src/db.ts',
            newPath: null,
            text: 'diff --git a/payments-api/src/db.ts b/payments-api/src/db.ts\ndeleted file mode 100644\n--- a/payments-api/src/db.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-const a = 1;\n-const b = 2;\n',
          },
        ],
      }),
    );
    const w = writes(requests);
    expect(w.some((x) => x.path === `${BASE}/git/blobs`)).toBe(false);
    expect(w.find((x) => x.path === `${BASE}/git/trees`)!.body.tree).toEqual([
      { path: 'src/db.ts', mode: '100755', type: 'blob', sha: null },
    ]);
  });

  test.each([
    ['a symbolic link', [{ path: 'db.ts', mode: '120000', type: 'blob', sha: DB_BLOB }], undefined],
    ['a submodule', [{ path: 'db.ts', mode: '160000', type: 'commit', sha: DB_BLOB }], undefined],
    ['a folder', [{ path: 'db.ts', mode: '040000', type: 'tree', sha: DB_BLOB }], undefined],
  ])('%s at the path is refused as not a file, with no write', async (_name, srcEntries) => {
    const { app, requests } = build(routes({ srcEntries }));
    expect(await app.openFixPullRequest(input())).toEqual({ status: 'refused', reason: 'not-a-file' });
    expect(writes(requests)).toEqual([]);
  });

  test('a symbolic link on the way to the file is refused', async () => {
    const { app, requests } = build(routes({ rootEntries: [{ path: 'src', mode: '120000', type: 'blob', sha: SRC }] }));
    expect(await app.openFixPullRequest(input())).toEqual({ status: 'refused', reason: 'not-a-file' });
    expect(writes(requests)).toEqual([]);
  });

  test('a file over 1 MiB or not UTF-8 is refused', async () => {
    let r = build(routes({ blobAnswer: () => blob('x', FIX_FILE_MAX_BYTES + 1) }));
    expect(await r.app.openFixPullRequest(input())).toEqual({ status: 'refused', reason: 'not-a-file' });
    r = build(routes({ blobAnswer: () => blob(Buffer.from([0xff, 0xfe, 0x00, 0x80])) }));
    expect(await r.app.openFixPullRequest(input())).toEqual({ status: 'refused', reason: 'not-a-file' });
    expect(writes(r.requests)).toEqual([]);
  });

  test('stale context is refused as does-not-apply, with no write', async () => {
    const { app, requests } = build(routes({ blobAnswer: () => blob('const a = 1;\nconst b = 9;\n') }));
    expect(await app.openFixPullRequest(input())).toEqual({ status: 'refused', reason: 'does-not-apply' });
    expect(writes(requests)).toEqual([]);
  });

  test('a new file that already exists does not apply', async () => {
    const { app } = build(routes());
    const outcome = await app.openFixPullRequest(
      input({
        sections: [
          { oldPath: null, newPath: 'src/db.ts', text: 'new file mode 100644\n--- /dev/null\n+++ b/payments-api/src/db.ts\n@@ -0,0 +1 @@\n+x\n' },
        ],
      }),
    );
    expect(outcome).toEqual({ status: 'refused', reason: 'does-not-apply' });
  });

  test('an existing branch with an open pull request answers it, with no write', async () => {
    const { app, requests } = build(routes({ branch: 200, open: [{ html_url: PR_URL, number: 17 }] }));
    expect(await app.openFixPullRequest(input())).toEqual({ status: 'opened', url: PR_URL, number: 17, existing: true });
    expect(writes(requests)).toEqual([]);
  });

  test('an existing branch without a pull request is force-moved to the new commit', async () => {
    const { app, requests } = build(routes({ branch: 200 }));
    expect(await app.openFixPullRequest(input())).toMatchObject({ status: 'opened', existing: false });
    const move = writes(requests).find((w) => w.method === 'PATCH')!;
    expect(move).toEqual({ method: 'PATCH', path: `${BASE}/git/refs/heads/${BRANCH}`, body: { sha: NEW_COMMIT, force: true } });
    expect(writes(requests).some((w) => w.path === `${BASE}/git/refs`)).toBe(false);
  });

  test.each(['main', 'debug-it/../main', 'refs/heads/debug-it/x', 'debug-it/'])(
    'branch %j outside debug-it/ is refused before any token',
    async (branch) => {
      const { app, calls } = build({});
      await expect(app.openFixPullRequest(input({ branch }))).rejects.toBeInstanceOf(GitHubAppError);
      expect(calls).toHaveLength(0);
    },
  );

  test('a commit that is not a full SHA is refused before any token', async () => {
    const { app, calls } = build({});
    await expect(app.openFixPullRequest(input({ commitSha: 'main' }))).rejects.toBeInstanceOf(GitHubAppError);
    expect(calls).toHaveLength(0);
  });

  test('a GitHub failure throws a GitHubAppError without the token', async () => {
    const { app } = build({ ...routes(), [`${BASE}/pulls`]: () => json({ message: 'boom' }, 500) });
    const failure = await app.openFixPullRequest(input()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GitHubAppError);
    expectNoToken((failure as Error).message);
  });

  test('the mock App answers an invented address with no network call', async () => {
    expect(await createMockGitHubApp().openFixPullRequest(input())).toEqual({
      status: 'opened',
      url: 'https://github.com/acme/payments-api/pull/1',
      number: 1,
      existing: false,
    });
  });
});
