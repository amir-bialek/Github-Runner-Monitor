import express from 'express';
import request from 'supertest';
import { registerDebugIt } from '../src/routes/debugIt';
import { WEBHOOK_PATH } from '../src/routes/githubWebhook';
import { DEBUG_IT_DEFAULTS, type LoginScope } from '../src/services/debugItConfig';
import { createSessionService } from '../src/services/session';
import { createSettingsService } from '../src/services/debugIt/settings';
import { createMemoryS3Client, createS3Store } from '../src/adapters/s3Store';
import { createMockGitHubApp } from '../src/adapters/githubApp';

const KEY = Buffer.alloc(32, 3);

// An app shaped like app.ts: webhook route, JSON, /health, then registerDebugIt,
// then 1.x-like routes.
function build(loginScope: LoginScope, enabled = true) {
  const session = createSessionService(KEY, { secure: false });
  const app = express();
  app.post(WEBHOOK_PATH, (req, res) => res.status(202).json({ received: true }));
  app.use(express.json());
  app.get('/health', (req, res) => res.json({ status: 'OK' }));
  registerDebugIt(
    app,
    { ...DEBUG_IT_DEFAULTS, enabled, loginScope, publicUrl: 'http://monitor.acme.example', githubAppClientId: 'Iv1.acme' },
    {
      session,
      githubApp: createMockGitHubApp(),
      env: {},
      settings: createSettingsService({
        store: createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() }),
        config: { administrators: ['1000001'], allowedRepositories: ['acme/payments-api'], allowedUsers: ['1000001'] },
      }),
    },
  );
  app.get('/runners', (req, res) => res.json([]));
  app.get('/settings/alerts', (req, res) => res.json({ settings: {} }));
  app.put('/settings/alerts', (req, res) => res.json({ settings: req.body }));
  app.get('/', (req, res) => res.json({ message: 'Backend is running' }));
  const value = session.seal({ uid: 1000001, login: 'dana' });
  return { app, cookie: `dbg_session=${value}`, csrf: session.csrfToken(value) };
}

describe('login scope whole-dashboard', () => {
  test.each(['/runners', '/', '/settings/alerts'])('signed out GET %s is 401', async (path) => {
    const { app } = build('whole-dashboard');
    const res = await request(app).get(path).expect(401);
    expect(res.body).toEqual({ error: 'You are not signed in.' });
  });

  test('signed out PUT /settings/alerts is 401', async () => {
    const { app } = build('whole-dashboard');
    await request(app).put('/settings/alerts').send({}).expect(401);
  });

  test('a garbage cookie is 401', async () => {
    const { app } = build('whole-dashboard');
    await request(app).get('/runners').set('Cookie', 'dbg_session=garbage').expect(401);
  });

  test.each(['/runners', '/', '/settings/alerts'])('signed in GET %s answers as 1.x', async (path) => {
    const { app, cookie } = build('whole-dashboard');
    await request(app).get(path).set('Cookie', cookie).expect(200);
  });

  test('GET /health is exempt', async () => {
    const { app } = build('whole-dashboard');
    await request(app).get('/health').expect(200);
  });

  test('HEAD /health is exempt', async () => {
    const { app } = build('whole-dashboard');
    await request(app).head('/health').expect(200);
  });

  test('the webhook is exempt', async () => {
    const { app } = build('whole-dashboard');
    await request(app).post(WEBHOOK_PATH).send({}).expect(202);
  });

  test('sign in and sign out are exempt', async () => {
    const { app } = build('whole-dashboard');
    await request(app).get('/debug-it/sign-in').expect(302);
    await request(app).post('/debug-it/sign-out').expect(204);
  });

  test('the callback is exempt (answers its own 400)', async () => {
    const { app } = build('whole-dashboard');
    await request(app).get('/debug-it/callback').expect(400);
  });

  test('an unknown path is 404 when signed in', async () => {
    const { app, cookie } = build('whole-dashboard');
    await request(app).get('/nope').set('Cookie', cookie).expect(404);
  });
});

describe('login scope debug-it-only', () => {
  test.each(['/runners', '/', '/settings/alerts', '/health'])('signed out GET %s answers as 1.x', async (path) => {
    const { app } = build('debug-it-only');
    await request(app).get(path).expect(200);
  });

  test('signed out PUT /settings/alerts is 401 (Story 1.8)', async () => {
    const { app } = build('debug-it-only');
    const res = await request(app).put('/settings/alerts').send({ a: 1 }).expect(401);
    expect(res.body).toEqual({ error: 'You are not signed in.' });
  });

  test('an administrator PUT /settings/alerts with CSRF answers as 1.x', async () => {
    const { app, cookie, csrf } = build('debug-it-only');
    const res = await request(app)
      .put('/settings/alerts')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ a: 1 })
      .expect(200);
    expect(res.body).toEqual({ settings: { a: 1 } });
  });
});

describe.each<LoginScope>(['debug-it-only', 'whole-dashboard'])('the /debug-it router with scope %s', (scope) => {
  test('an unknown path without a session is 401', async () => {
    const { app } = build(scope);
    const res = await request(app).get('/debug-it/nope').expect(401);
    expect(res.body).toEqual({ error: 'You are not signed in.' });
  });

  test('an unknown path with a session is 404', async () => {
    const { app, cookie } = build(scope);
    await request(app).get('/debug-it/nope').set('Cookie', cookie).expect(404);
  });

  test.each(['post', 'put', 'patch', 'delete'] as const)('%s without a CSRF token is 403 before the 404', async (method) => {
    const { app, cookie } = build(scope);
    const res = await request(app)[method]('/debug-it/nope').set('Cookie', cookie).expect(403);
    expect(res.body).toEqual({ error: 'The request is missing a valid CSRF token.' });
  });

  test('POST with a wrong CSRF token is 403', async () => {
    const { app, cookie } = build(scope);
    await request(app).post('/debug-it/nope').set('Cookie', cookie).set('X-CSRF-Token', 'wrong').expect(403);
  });

  test('POST with a valid CSRF token reaches the 404', async () => {
    const { app, cookie, csrf } = build(scope);
    await request(app).post('/debug-it/nope').set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(404);
  });

  test('GET /debug-it/session returns the access flags', async () => {
    const { app, cookie } = build(scope);
    const res = await request(app).get('/debug-it/session').set('Cookie', cookie).expect(200);
    expect(res.body).toMatchObject({ githubUserId: 1000001, allowedUser: true, administrator: true });
  });
});

describe('Debug it off', () => {
  test.each<LoginScope>(['debug-it-only', 'whole-dashboard'])('scope %s adds no gate and no router', async (scope) => {
    const { app } = build(scope, false);
    await request(app).get('/runners').expect(200);
    await request(app).get('/').expect(200);
    await request(app).get('/debug-it/session').expect(404);
    await request(app).get('/debug-it/nope').expect(404);
  });
});

describe('the real app.ts with whole-dashboard', () => {
  const NAMES = ['DEBUG_IT_ENABLED', 'DEBUG_IT_LOGIN_SCOPE', 'USE_MOCK_DATA', 'DEBUG_IT_PUBLIC_URL'] as const;
  const saved: Record<string, string | undefined> = {};
  let realApp: express.Express;

  beforeAll(() => {
    for (const name of NAMES) saved[name] = process.env[name];
    process.env.DEBUG_IT_ENABLED = 'true';
    process.env.DEBUG_IT_LOGIN_SCOPE = 'whole-dashboard';
    process.env.USE_MOCK_DATA = 'true';
    process.env.DEBUG_IT_PUBLIC_URL = 'http://monitor.acme.example';
    jest.isolateModules(() => {
      realApp = (require('../src/app') as { app: express.Express }).app;
    });
  });

  afterAll(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test('signed out GET /runners is 401', async () => {
    const res = await request(realApp).get('/runners').expect(401);
    expect(res.body).toEqual({ error: 'You are not signed in.' });
  });

  test('signed out PUT /settings/alerts is 401', async () => {
    await request(realApp).put('/settings/alerts').send({}).expect(401);
  });

  test('GET /health is 200', async () => {
    await request(realApp).get('/health').expect(200);
  });
});
