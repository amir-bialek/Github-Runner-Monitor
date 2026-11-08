import express from 'express';
import request from 'supertest';
import { registerDebugIt } from '../src/routes/debugIt';
import { CHECK_ERRORS } from '../src/routes/checkChain';
import { DEBUG_IT_DEFAULTS, type LoginScope } from '../src/services/debugItConfig';
import { createSessionService } from '../src/services/session';
import { createSettingsService } from '../src/services/debugIt/settings';
import { createMemoryS3Client, createS3Store } from '../src/adapters/s3Store';
import { createMockGitHubApp } from '../src/adapters/githubApp';

const KEY = Buffer.alloc(32, 5);
const DANA = { uid: 1000001, login: 'dana' }; // administrator
const LEE = { uid: 1000002, login: 'lee' }; // allowed user, not administrator
const LOCKED = 'Alert settings are locked by the deployment (ALERT_SETTINGS_EDITABLE=false)';

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

// An app shaped like app.ts: JSON, registerDebugIt, then stub 1.x alert
// handlers that honor a locked flag and count how often they ran.
function build(loginScope: LoginScope, options: { enabled?: boolean; locked?: boolean } = {}) {
  const session = createSessionService(KEY, { secure: false });
  const ran = jest.fn();
  const app = express();
  app.use(express.json());
  registerDebugIt(
    app,
    {
      ...DEBUG_IT_DEFAULTS,
      enabled: options.enabled ?? true,
      loginScope,
      publicUrl: 'http://monitor.acme.example',
      githubAppClientId: 'Iv1.acme',
    },
    {
      session,
      githubApp: createMockGitHubApp(),
      env: {},
      settings: createSettingsService({
        store: createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() }),
        config: {
          administrators: ['1000001'],
          allowedRepositories: ['acme/payments-api'],
          allowedUsers: ['1000001', '1000002'],
        },
      }),
    },
  );
  const locked = (res: express.Response): boolean => {
    if (!options.locked) return false;
    res.status(403).json({ error: LOCKED });
    return true;
  };
  app.get('/settings/alerts', (req, res) => res.json({ settings: {}, editable: !options.locked }));
  app.put('/settings/alerts', (req, res) => {
    ran('put');
    if (locked(res)) return;
    if (req.body?.bad) {
      res.status(400).json({ error: 'bad value' });
      return;
    }
    res.json({ settings: req.body });
  });
  app.delete('/settings/alerts', (req, res) => {
    ran('delete');
    if (locked(res)) return;
    res.json({ source: 'deployment' });
  });
  app.post('/settings/alerts/test', (req, res) => {
    ran('test');
    if (locked(res)) return;
    res.status(502).json({ error: 'Test failed: unreachable' });
  });
  const as = (user: { uid: number; login: string }) => {
    const value = session.seal(user);
    return { cookie: `dbg_session=${value}`, csrf: session.csrfToken(value) };
  };
  return { app, ran, as };
}

type Method = 'put' | 'delete' | 'post';
const CHANGES: Array<[Method, string]> = [
  ['put', '/settings/alerts'],
  ['delete', '/settings/alerts'],
  ['post', '/settings/alerts/test'],
];

describe.each<LoginScope>(['debug-it-only', 'whole-dashboard'])('alert settings gate with scope %s', (scope) => {
  test.each(CHANGES)('signed out %s %s is 401 and the handler does not run', async (method, path) => {
    const { app, ran } = build(scope);
    const res = await request(app)[method](path).send({}).expect(401);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notSignedIn });
    expect(ran).not.toHaveBeenCalled();
  });

  test('a garbage session cookie is 401', async () => {
    const { app, ran } = build(scope);
    await request(app).put('/settings/alerts').set('Cookie', 'dbg_session=garbage').send({}).expect(401);
    expect(ran).not.toHaveBeenCalled();
  });

  test.each(CHANGES)('a non administrator with CSRF on %s %s is 403', async (method, path) => {
    const { app, ran, as } = build(scope);
    const lee = as(LEE);
    const res = await request(app)[method](path).set('Cookie', lee.cookie).set('X-CSRF-Token', lee.csrf).send({}).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notAdministrator });
    expect(ran).not.toHaveBeenCalled();
  });

  test.each(CHANGES)('an administrator without CSRF on %s %s is 403', async (method, path) => {
    const { app, ran, as } = build(scope);
    const res = await request(app)[method](path).set('Cookie', as(DANA).cookie).send({}).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.csrf });
    expect(ran).not.toHaveBeenCalled();
  });

  test('an administrator with a wrong CSRF token is 403', async () => {
    const { app, as } = build(scope);
    const res = await request(app)
      .put('/settings/alerts')
      .set('Cookie', as(DANA).cookie)
      .set('X-CSRF-Token', 'wrong')
      .send({})
      .expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.csrf });
  });

  test('an administrator with CSRF reaches the 1.x handlers', async () => {
    const { app, as } = build(scope);
    const dana = as(DANA);
    const put = await request(app)
      .put('/settings/alerts')
      .set('Cookie', dana.cookie)
      .set('X-CSRF-Token', dana.csrf)
      .send({ queueWait: { thresholdMinutes: 3 } })
      .expect(200);
    expect(put.body).toEqual({ settings: { queueWait: { thresholdMinutes: 3 } } });
    await request(app).put('/settings/alerts').set('Cookie', dana.cookie).set('X-CSRF-Token', dana.csrf).send({ bad: true }).expect(400);
    await request(app).delete('/settings/alerts').set('Cookie', dana.cookie).set('X-CSRF-Token', dana.csrf).expect(200);
    await request(app).post('/settings/alerts/test').set('Cookie', dana.cookie).set('X-CSRF-Token', dana.csrf).expect(502);
  });

  test('locked settings stay 403 for an administrator', async () => {
    const { app, ran, as } = build(scope, { locked: true });
    const dana = as(DANA);
    const res = await request(app)
      .put('/settings/alerts')
      .set('Cookie', dana.cookie)
      .set('X-CSRF-Token', dana.csrf)
      .send({})
      .expect(403);
    expect(res.body).toEqual({ error: LOCKED });
    expect(ran).toHaveBeenCalledWith('put');
  });

  test.each<[Method, string]>([
    ['put', '/SETTINGS/ALERTS/'],
    ['put', '/settings/alerts/'],
    ['post', '/settings/alerts/test/'],
    ['post', '/Settings/Alerts/Test'],
    ['delete', '/settings/ALERTS'],
  ])('path variant %s %s without a session is 401', async (method, path) => {
    const { app, ran } = build(scope);
    await request(app)[method](path).send({}).expect(401);
    expect(ran).not.toHaveBeenCalled();
  });

  test('a future sub path is gated too', async () => {
    const { app } = build(scope);
    await request(app).post('/settings/alerts/anything').send({}).expect(401);
  });

  test('logs hold no CSRF token or session cookie', async () => {
    const { app, as } = build(scope);
    const dana = as(DANA);
    const lee = as(LEE);
    await request(app).put('/settings/alerts').set('Cookie', dana.cookie).set('X-CSRF-Token', dana.csrf).send({}).expect(200);
    await request(app).put('/settings/alerts').set('Cookie', lee.cookie).set('X-CSRF-Token', lee.csrf).send({}).expect(403);
    const logged = JSON.stringify([log.mock.calls, error.mock.calls]);
    for (const secret of [dana.csrf, lee.csrf, dana.cookie.split('=')[1], lee.cookie.split('=')[1]]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('alert settings reads', () => {
  test('signed out GET /settings/alerts is 200 with debug-it-only', async () => {
    const { app } = build('debug-it-only');
    await request(app).get('/settings/alerts').expect(200);
  });

  test('signed out HEAD and OPTIONS pass the gate with debug-it-only', async () => {
    const { app } = build('debug-it-only');
    await request(app).head('/settings/alerts').expect(200);
    await request(app).options('/settings/alerts').expect(200);
  });

  test('a signed in non administrator can read with whole-dashboard', async () => {
    const { app, as } = build('whole-dashboard');
    await request(app).get('/settings/alerts').set('Cookie', as(LEE).cookie).expect(200);
  });

  test('signed out GET stays 401 with whole-dashboard (dashboard gate)', async () => {
    const { app } = build('whole-dashboard');
    await request(app).get('/settings/alerts').expect(401);
  });
});

describe('Debug it off', () => {
  test.each<LoginScope>(['debug-it-only', 'whole-dashboard'])('scope %s adds no alert settings gate', async (scope) => {
    const { app, ran } = build(scope, { enabled: false });
    await request(app).put('/settings/alerts').send({}).expect(200);
    await request(app).delete('/settings/alerts').expect(200);
    await request(app).post('/settings/alerts/test').expect(502);
    expect(ran).toHaveBeenCalledTimes(3);
  });
});

// The real app.ts, loaded in isolation with the given environment.
function loadRealApp(env: Record<string, string | undefined>): express.Express {
  const saved: Record<string, string | undefined> = {};
  for (const name of Object.keys(env)) {
    saved[name] = process.env[name];
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  let realApp!: express.Express;
  try {
    jest.isolateModules(() => {
      realApp = (require('../src/app') as { app: express.Express }).app;
    });
  } finally {
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
  return realApp;
}

describe('the real app.ts with debug-it-only', () => {
  const HEX_KEY = '05'.repeat(32);
  let realApp: express.Express;

  beforeAll(() => {
    realApp = loadRealApp({
      DEBUG_IT_ENABLED: 'true',
      DEBUG_IT_LOGIN_SCOPE: 'debug-it-only',
      USE_MOCK_DATA: 'true',
      DEBUG_IT_PUBLIC_URL: 'http://monitor.acme.example',
      DEBUG_IT_SESSION_ENCRYPTION_KEY: HEX_KEY,
      DEBUG_IT_ADMINISTRATORS: '1000001',
      DEBUG_IT_ALLOWED_USERS: '1000001,1000002',
      ALERT_SETTINGS_EDITABLE: undefined,
    });
  });

  test.each(CHANGES)('signed out %s %s is 401', async (method, path) => {
    const res = await request(realApp)[method](path).send({}).expect(401);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notSignedIn });
  });

  test('signed out GET /settings/alerts is 200', async () => {
    await request(realApp).get('/settings/alerts').expect(200);
  });

  test('an administrator change is audited with the actor and no token', async () => {
    const session = createSessionService(Buffer.from(HEX_KEY, 'hex'), { secure: false });
    const value = session.seal(DANA);
    const csrf = session.csrfToken(value);
    log.mockClear();
    await request(realApp)
      .put('/settings/alerts')
      .set('Cookie', `dbg_session=${value}`)
      .set('X-CSRF-Token', csrf)
      .send({ queueWait: { thresholdMinutes: 3 } })
      .expect(200);
    await request(realApp).delete('/settings/alerts').set('Cookie', `dbg_session=${value}`).set('X-CSRF-Token', csrf).expect(200);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('[AUDIT] Alert settings changed from the UI by GitHub user 1000001 (dana)');
    expect(lines).toContain('[AUDIT] Alert settings reset to the deployment values by GitHub user 1000001 (dana)');
    const logged = JSON.stringify([log.mock.calls, error.mock.calls]);
    expect(logged).not.toContain(csrf);
    expect(logged).not.toContain(value);
  });
});

describe('the real app.ts with Debug it off', () => {
  test('audit lines are the 1.x text', async () => {
    const realApp = loadRealApp({ DEBUG_IT_ENABLED: undefined, USE_MOCK_DATA: 'true', ALERT_SETTINGS_EDITABLE: undefined });
    log.mockClear();
    await request(realApp).put('/settings/alerts').send({ queueWait: { thresholdMinutes: 3 } }).expect(200);
    await request(realApp).delete('/settings/alerts').expect(200);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('[AUDIT] Alert settings changed from the UI');
    expect(lines).toContain('[AUDIT] Alert settings reset to the deployment values');
  });
});
