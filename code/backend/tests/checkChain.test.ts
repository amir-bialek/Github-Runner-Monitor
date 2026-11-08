import express from 'express';
import request from 'supertest';
import { createCheckChain, type GuardOptions } from '../src/routes/checkChain';
import { createSessionService } from '../src/services/session';
import { createSettingsService, type SettingsService } from '../src/services/debugIt/settings';
import { createMemoryS3Client, createS3Store } from '../src/adapters/s3Store';
import { createMockGitHubApp, GitHubAppError, type GitHubApp, type RepositoryPermission } from '../src/adapters/githubApp';

const KEY = Buffer.alloc(32, 9);
const DANA = { uid: 1000001, login: 'dana' };
const ELI = { uid: 1000002, login: 'eli' };

const error = console.error as jest.Mock;

function fakeGitHubApp(level: RepositoryPermission | Error = 'write'): GitHubApp & { checkPermission: jest.Mock } {
  return {
    ...createMockGitHubApp(),
    checkPermission: jest.fn(async () => {
      if (level instanceof Error) throw level;
      return level;
    }),
  };
}

// The SR13 table runs on a test router: no Debug it business route exists yet.
function build(
  options: {
    guard?: GuardOptions;
    level?: RepositoryPermission | Error;
    administrators?: string[];
    allowedUsers?: string[];
    allowedRepositories?: string[];
    settings?: SettingsService;
  } = {},
) {
  const session = createSessionService(KEY, { secure: false });
  const settings =
    options.settings ??
    createSettingsService({
      store: createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() }),
      config: {
        administrators: options.administrators ?? ['1000001'],
        allowedRepositories: options.allowedRepositories ?? ['acme/payments-api', 'acme/web'],
        allowedUsers: options.allowedUsers ?? ['1000001'],
      },
    });
  const load = jest.spyOn(settings, 'load');
  const github = fakeGitHubApp(options.level);
  const chain = createCheckChain({ session, settings, githubApp: github });
  const handler = jest.fn((req: express.Request, res: express.Response) => {
    res.json({ ok: true, user: res.locals.debugIt });
  });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use(chain.sessionStep);
  router.use(chain.csrfStep);
  const guard = options.guard ?? { access: 'allowed' };
  router.get('/things/:owner/:repo', ...chain.guard(guard), handler);
  router.post('/things/:owner/:repo', ...chain.guard(guard), handler);
  router.all('/any/:owner/:repo', ...chain.guard(guard), handler);
  app.use('/debug-it', router);
  const cookie = (user = DANA) => {
    const value = session.seal(user);
    return { header: `dbg_session=${value}`, csrf: session.csrfToken(value), value };
  };
  return { app, settings, load, github, handler, cookie };
}

const readRepo: GuardOptions = {
  access: 'allowed',
  repositories: { resolve: (req) => [`${req.params.owner}/${req.params.repo}`], permission: 'read' },
};
const writeRepo: GuardOptions = {
  access: 'allowed',
  repositories: { resolve: (req) => [`${req.params.owner}/${req.params.repo}`], permission: 'write', fresh: true },
};

beforeEach(() => error.mockClear());

describe('session step', () => {
  test('no session is 401 and never reaches CSRF, settings or GitHub', async () => {
    const { app, load, github, handler } = build({ guard: readRepo });
    const res = await request(app).post('/debug-it/things/acme/payments-api').expect(401);
    expect(res.body).toEqual({ error: 'You are not signed in.' });
    expect(load).not.toHaveBeenCalled();
    expect(github.checkPermission).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test('a garbage cookie is 401', async () => {
    const { app } = build();
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', 'dbg_session=garbage').expect(401);
  });

  test('a valid session reaches the route with res.locals.debugIt', async () => {
    const { app, cookie } = build();
    const res = await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(200);
    expect(res.body).toEqual({ ok: true, user: { uid: 1000001, login: 'dana' } });
  });
});

describe('CSRF step', () => {
  test.each([
    ['missing', undefined],
    ['wrong', 'not-the-token'],
  ])('%s token on a state change is 403 before settings', async (_name, token) => {
    const { app, cookie, load, handler } = build();
    let req = request(app).post('/debug-it/things/acme/payments-api').set('Cookie', cookie().header);
    if (token) req = req.set('X-CSRF-Token', token);
    const res = await req.expect(403);
    expect(res.body).toEqual({ error: 'The request is missing a valid CSRF token.' });
    expect(load).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test('a token for another session is 403', async () => {
    const { app, cookie } = build();
    await request(app)
      .post('/debug-it/things/acme/payments-api')
      .set('Cookie', cookie().header)
      .set('X-CSRF-Token', cookie().csrf)
      .expect(403);
  });

  test('a valid token passes', async () => {
    const { app, cookie } = build();
    const c = cookie();
    await request(app).post('/debug-it/things/acme/payments-api').set('Cookie', c.header).set('X-CSRF-Token', c.csrf).expect(200);
  });

  test.each(['propfind', 'search', 'purge'])('%s on a router.all route without a token is 403', async (method) => {
    const { app, cookie, handler } = build();
    const res = await (request(app) as unknown as Record<string, (url: string) => request.Test>)[method]!(
      '/debug-it/any/acme/payments-api',
    )
      .set('Cookie', cookie().header)
      .expect(403);
    expect(res.body).toEqual({ error: 'The request is missing a valid CSRF token.' });
    expect(handler).not.toHaveBeenCalled();
  });

  test.each(['head', 'options'] as const)('%s on a router.all route needs no token', async (method) => {
    const { app, cookie, handler } = build();
    await request(app)[method]('/debug-it/any/acme/payments-api').set('Cookie', cookie().header).expect(200);
    expect(handler).toHaveBeenCalled();
  });

  test('GET needs no token', async () => {
    const { app, cookie } = build();
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(200);
  });
});

describe('access step', () => {
  test('a user not in allowedUsers is 403 and GitHub is never asked', async () => {
    const { app, cookie, github, handler } = build({ guard: readRepo });
    const res = await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie(ELI).header).expect(403);
    expect(res.body).toEqual({ error: 'You are not an allowed Debug it user.' });
    expect(github.checkPermission).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test('an administrator who is not listed is not an allowed user', async () => {
    const { app, cookie } = build({ allowedUsers: ['1000002'] });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie(DANA).header).expect(403);
  });

  test('a non administrator is 403 on an administrator route, without a settings read', async () => {
    const { app, cookie, load } = build({ guard: { access: 'administrator' }, allowedUsers: ['1000002'] });
    const res = await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie(ELI).header).expect(403);
    expect(res.body).toEqual({ error: 'Only Debug it administrators can do this.' });
    expect(load).not.toHaveBeenCalled();
  });

  test('an administrator passes an administrator route even when not an allowed user', async () => {
    const { app, cookie } = build({ guard: { access: 'administrator' }, allowedUsers: [] });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie(DANA).header).expect(200);
  });

  test('a renamed user holding an administrator old login is matched by ID only', async () => {
    const { app, cookie } = build({ guard: { access: 'administrator' } });
    await request(app)
      .get('/debug-it/things/acme/payments-api')
      .set('Cookie', cookie({ uid: 1000002, login: 'dana' }).header)
      .expect(403);
  });

  test('unreadable settings are 503', async () => {
    const settings = createSettingsService({
      store: {
        read: (async () => {
          throw new Error('S3 down');
        }) as never,
        create: (async () => '') as never,
        modify: (async () => null) as never,
      },
      config: { administrators: [], allowedRepositories: [], allowedUsers: [] },
    });
    const { app, cookie, github, handler } = build({ settings, guard: readRepo });
    const res = await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(503);
    expect(res.body).toEqual({ error: 'Debug it settings could not be read; please try again.' });
    expect(github.checkPermission).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('repository step', () => {
  test('a repository not allowed is 403 with no GitHub call', async () => {
    const { app, cookie, github } = build({ guard: readRepo });
    const res = await request(app).get('/debug-it/things/acme/secret').set('Cookie', cookie().header).expect(403);
    expect(res.body).toEqual({ error: 'This repository is not allowed for Debug it.' });
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('one repository not allowed among several refuses before any GitHub call', async () => {
    const guard: GuardOptions = {
      access: 'allowed',
      repositories: { resolve: () => ['acme/payments-api', 'acme/secret'], permission: 'read' },
    };
    const { app, cookie, github } = build({ guard });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(403);
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('repositories match case-insensitively', async () => {
    const { app, cookie } = build({ guard: readRepo });
    await request(app).get('/debug-it/things/ACME/Payments-API').set('Cookie', cookie().header).expect(200);
  });

  test('read access passes a read route, using the cache', async () => {
    const { app, cookie, github } = build({ guard: readRepo, level: 'read' });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(200);
    expect(github.checkPermission).toHaveBeenCalledWith({ githubUserId: 1000001, login: 'dana' }, 'acme/payments-api', {
      fresh: false,
    });
  });

  test.each<RepositoryPermission>(['read', 'none'])('%s on a write route is 403', async (level) => {
    const { app, cookie, handler } = build({ guard: writeRepo, level });
    const res = await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(403);
    expect(res.body).toEqual({ error: 'You do not have the needed access to this repository.' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('an unknown level from GitHub refuses', async () => {
    const { app, cookie, handler } = build({ guard: readRepo, level: 'toString' as RepositoryPermission });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(403);
    expect(handler).not.toHaveBeenCalled();
  });

  test('an unknown needed permission refuses', async () => {
    const guard = {
      access: 'allowed',
      repositories: { resolve: () => ['acme/payments-api'], permission: 'admin' },
    } as unknown as GuardOptions;
    const { app, cookie, handler } = build({ guard, level: 'write' });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(403);
    expect(handler).not.toHaveBeenCalled();
  });

  test('none on a read route is 403', async () => {
    const { app, cookie } = build({ guard: readRepo, level: 'none' });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(403);
  });

  test('write passes a fresh write route', async () => {
    const { app, cookie, github } = build({ guard: writeRepo, level: 'write' });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(200);
    expect(github.checkPermission).toHaveBeenCalledWith(expect.anything(), 'acme/payments-api', { fresh: true });
  });

  test('every repository is checked', async () => {
    const guard: GuardOptions = {
      access: 'allowed',
      repositories: { resolve: async () => ['acme/payments-api', 'acme/web'], permission: 'read' },
    };
    const { app, cookie, github } = build({ guard });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(200);
    expect(github.checkPermission).toHaveBeenCalledTimes(2);
  });

  test('a resolver giving no repository fails closed', async () => {
    const guard: GuardOptions = { access: 'allowed', repositories: { resolve: () => [], permission: 'read' } };
    const { app, cookie } = build({ guard });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(403);
  });

  test('a GitHub failure is 502 with no cookie in the logs', async () => {
    const { app, cookie, handler } = build({ guard: readRepo, level: new GitHubAppError('GitHub did not answer.') });
    const c = cookie();
    const res = await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', c.header).expect(502);
    expect(res.body).toEqual({ error: 'GitHub could not check your repository access; please try again.' });
    expect(handler).not.toHaveBeenCalled();
    expect(error.mock.calls.map((a) => a.join(' ')).join('\n')).not.toContain(c.value);
  });

  test('settings are read once per request', async () => {
    const { app, cookie, load } = build({ guard: readRepo });
    await request(app).get('/debug-it/things/acme/payments-api').set('Cookie', cookie().header).expect(200);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('guard', () => {
  test('returns the access step then the repository step', () => {
    const chain = createCheckChain({
      session: createSessionService(KEY, { secure: false }),
      settings: createSettingsService({
        store: createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() }),
        config: { administrators: [], allowedRepositories: [], allowedUsers: [] },
      }),
      githubApp: fakeGitHubApp(),
    });
    const steps = chain.guard({ access: 'allowed' });
    expect(steps).toHaveLength(2);
    expect(() => chain.guard({ access: 'everyone' as never })).toThrow();
  });
});
