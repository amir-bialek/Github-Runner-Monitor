import { AxiosError, AxiosHeaders, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import api, {
  addAllowedRepository,
  addAllowedUser,
  deletePersonalKey,
  fetchDebugItRuns,
  fetchDebugItSettings,
  fetchDebugItUsage,
  fetchDebugRun,
  fetchDebugRunResult,
  fetchPersonalKey,
  fetchQueue,
  fetchSession,
  openDebugFixPullRequest,
  removeAllowedRepository,
  removeAllowedUser,
  resetAlertSettings,
  saveDebugRunFeedback,
  savePersonalKey,
  sendTestAlert,
  sessionApi,
  signInUrl,
  signOut,
  startDebugRun,
  updateAlertSettings,
} from './api';

// Invented values only; this is not a real token.
const TOKEN = 'test-csrf-value';

type Answer = { status: number; data?: unknown };
type Seen = { method: string; url: string; csrf: unknown; body: unknown };

let answers: Record<string, Answer>;
let seen: Seen[];

const stub: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const method = (config.method ?? 'get').toUpperCase();
  const url = config.url ?? '';
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
  seen.push({ method, url, csrf: AxiosHeaders.from(config.headers).get('X-CSRF-Token'), body });
  const answer = answers[`${method} ${url}`] ?? { status: 404, data: { error: 'Not found' } };
  const response = {
    data: answer.data ?? {},
    status: answer.status,
    statusText: String(answer.status),
    headers: {},
    config,
    request: {},
  };
  if (!config.validateStatus || config.validateStatus(answer.status)) return response;
  throw new AxiosError(`Request failed with status code ${answer.status}`, 'ERR_BAD_RESPONSE', config, {}, response);
};

const session200 = (loginScope?: string) => ({
  status: 200,
  data: {
    githubUserId: 1000001,
    login: 'dana',
    csrfToken: TOKEN,
    allowedUser: true,
    administrator: false,
    ...(loginScope ? { loginScope } : {}),
  },
});

const signInAs = async () => {
  answers['GET /debug-it/session'] = session200('debug-it-only');
  await fetchSession();
};

const csrfOf = (method: string, url: string) => seen.find((s) => s.method === method && s.url === url)?.csrf;

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let originalAdapters: unknown[];

beforeEach(() => {
  answers = {
    'PUT /settings/alerts': { status: 200, data: {} },
    'GET /jobs/queue': { status: 200, data: { items: [] } },
    'POST /debug-it/sign-out': { status: 204 },
  };
  seen = [];
  originalAdapters = [api.defaults.adapter, sessionApi.defaults.adapter];
  api.defaults.adapter = stub;
  sessionApi.defaults.adapter = stub;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  // Leave the module holding no token for the next test.
  answers['GET /debug-it/session'] = { status: 404 };
  await fetchSession();
  api.defaults.adapter = originalAdapters[0] as AxiosAdapter;
  sessionApi.defaults.adapter = originalAdapters[1] as AxiosAdapter;
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

const loggedText = () =>
  [...errorSpy.mock.calls, ...logSpy.mock.calls]
    .flat()
    .map((arg) => {
      try {
        return typeof arg === 'string' ? arg : JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join('\n');

describe('fetchSession status mapping', () => {
  test('404 is Debug it disabled and logs nothing', async () => {
    answers['GET /debug-it/session'] = { status: 404, data: { error: 'Not found' } };
    await expect(fetchSession()).resolves.toEqual({ state: 'disabled' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test.each(['debug-it-only', 'whole-dashboard'] as const)('401 with scope %s is signed out with that scope', async (loginScope) => {
    answers['GET /debug-it/session'] = { status: 401, data: { error: 'You are not signed in.', loginScope } };
    await expect(fetchSession()).resolves.toEqual({ state: 'signed-out', loginScope });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', { error: 'You are not signed in.' }],
    ['unknown', { error: 'You are not signed in.', loginScope: 'everything' }],
  ])('401 with a %s scope counts as debug-it-only', async (_name, data) => {
    answers['GET /debug-it/session'] = { status: 401, data };
    await expect(fetchSession()).resolves.toEqual({ state: 'signed-out', loginScope: 'debug-it-only' });
  });

  test('200 is signed in', async () => {
    answers['GET /debug-it/session'] = session200('whole-dashboard');
    await expect(fetchSession()).resolves.toEqual({
      state: 'signed-in',
      githubUserId: 1000001,
      login: 'dana',
      csrfToken: TOKEN,
      allowedUser: true,
      administrator: false,
      loginScope: 'whole-dashboard',
      credentialsMode: 'organization',
    });
  });

  test.each([
    ['personal', 'personal'],
    ['organization', 'organization'],
    ['missing', 'organization'],
    ['unknown', 'organization'],
  ] as const)('credentialsMode %s reads as %s', async (name, expected) => {
    const answer = session200();
    const data = answer.data as Record<string, unknown>;
    if (name !== 'missing') data.credentialsMode = name === 'unknown' ? 'shared' : name;
    answers['GET /debug-it/session'] = answer;
    await expect(fetchSession()).resolves.toMatchObject({ state: 'signed-in', credentialsMode: expected });
  });

  test('200 without a scope counts as debug-it-only', async () => {
    answers['GET /debug-it/session'] = session200();
    await expect(fetchSession()).resolves.toMatchObject({ state: 'signed-in', loginScope: 'debug-it-only' });
  });

  test('503 is a query error with its status', async () => {
    answers['GET /debug-it/session'] = { status: 503, data: { error: 'Debug it settings could not be read; please try again.' } };
    await expect(fetchSession()).rejects.toMatchObject({ name: 'ApiError', status: 503, source: 'backend' });
  });

  test('a 200 that is not a session answer is a query error', async () => {
    answers['GET /debug-it/session'] = { status: 200, data: '<!doctype html>' };
    await expect(fetchSession()).rejects.toMatchObject({ name: 'ApiError' });
  });

  test('the sign in URL is under the API base', () => {
    expect(signInUrl).toBe('/api/debug-it/sign-in');
  });
});

describe('CSRF header', () => {
  test('a state change while signed in carries X-CSRF-Token', async () => {
    await signInAs();
    await updateAlertSettings({ queueWait: { enabled: true } });
    expect(csrfOf('PUT', '/settings/alerts')).toBe(TOKEN);
  });

  test('the alert settings reset and test send carry X-CSRF-Token when signed in', async () => {
    await signInAs();
    answers['DELETE /settings/alerts'] = { status: 200, data: {} };
    answers['POST /settings/alerts/test'] = { status: 200, data: { webhookStatus: {} } };
    await resetAlertSettings();
    await sendTestAlert();
    expect(csrfOf('DELETE', '/settings/alerts')).toBe(TOKEN);
    expect(csrfOf('POST', '/settings/alerts/test')).toBe(TOKEN);
  });

  test('a state change while Debug it is disabled has no X-CSRF-Token', async () => {
    answers['GET /debug-it/session'] = { status: 404 };
    await fetchSession();
    await updateAlertSettings({ queueWait: { enabled: true } });
    expect(csrfOf('PUT', '/settings/alerts')).toBeUndefined();
  });

  test('a state change after the session turns signed out has no X-CSRF-Token', async () => {
    await signInAs();
    answers['GET /debug-it/session'] = { status: 401, data: { loginScope: 'debug-it-only' } };
    await fetchSession();
    await updateAlertSettings({ queueWait: { enabled: true } });
    expect(csrfOf('PUT', '/settings/alerts')).toBeUndefined();
  });

  test('a failed session read keeps the token', async () => {
    await signInAs();
    answers['GET /debug-it/session'] = { status: 503, data: { error: 'Debug it settings could not be read; please try again.' } };
    await expect(fetchSession()).rejects.toMatchObject({ status: 503 });
    await updateAlertSettings({ queueWait: { enabled: true } });
    expect(csrfOf('PUT', '/settings/alerts')).toBe(TOKEN);
  });

  test('a GET while signed in has no X-CSRF-Token', async () => {
    await signInAs();
    await fetchQueue();
    expect(csrfOf('GET', '/jobs/queue')).toBeUndefined();
  });

  test('the session read itself carries no X-CSRF-Token', async () => {
    await signInAs();
    await fetchSession();
    expect(seen.filter((s) => s.url === '/debug-it/session').every((s) => s.csrf === undefined)).toBe(true);
  });

  test('sign out sends the token, then clears it', async () => {
    await signInAs();
    await signOut();
    expect(csrfOf('POST', '/debug-it/sign-out')).toBe(TOKEN);

    await updateAlertSettings({ queueWait: { enabled: true } });
    expect(csrfOf('PUT', '/settings/alerts')).toBeUndefined();
  });

  test('a failed sign out keeps the token and does not log it', async () => {
    await signInAs();
    answers['POST /debug-it/sign-out'] = { status: 503, data: { error: 'down' } };
    await expect(signOut()).rejects.toMatchObject({ status: 503 });
    expect(errorSpy).toHaveBeenCalled();
    expect(loggedText()).not.toContain(TOKEN);

    answers['PUT /settings/alerts'] = { status: 200, data: {} };
    await updateAlertSettings({});
    expect(csrfOf('PUT', '/settings/alerts')).toBe(TOKEN);
  });

  test('a failed state change does not log the token', async () => {
    await signInAs();
    answers['PUT /settings/alerts'] = { status: 500, data: { error: 'boom' } };
    await expect(updateAlertSettings({})).rejects.toMatchObject({ status: 500 });
    expect(errorSpy).toHaveBeenCalled();
    expect(loggedText()).not.toContain(TOKEN);
  });
});

describe('Debug it settings client', () => {
  const VIEW = { allowedRepositories: ['acme/payments-api'], allowedUsers: [{ githubUserId: 1000002, login: 'lee' }] };

  beforeEach(() => {
    for (const key of [
      'GET /debug-it/settings',
      'POST /debug-it/settings/repositories',
      'DELETE /debug-it/settings/repositories/acme/payments-api',
      'POST /debug-it/settings/users',
      'DELETE /debug-it/settings/users/1000002',
    ]) {
      answers[key] = { status: 200, data: VIEW };
    }
  });

  test('each call uses its method, path and body and answers the view', async () => {
    await signInAs();
    await expect(fetchDebugItSettings()).resolves.toEqual(VIEW);
    await expect(addAllowedRepository('acme/payments-api')).resolves.toEqual(VIEW);
    await expect(removeAllowedRepository('acme/payments-api')).resolves.toEqual(VIEW);
    await expect(addAllowedUser('lee')).resolves.toEqual(VIEW);
    await expect(removeAllowedUser(1000002)).resolves.toEqual(VIEW);
    const calls = seen.filter((s) => s.url.startsWith('/debug-it/settings')).map(({ method, url, body }) => ({ method, url, body }));
    expect(calls).toEqual([
      { method: 'GET', url: '/debug-it/settings', body: undefined },
      { method: 'POST', url: '/debug-it/settings/repositories', body: { repository: 'acme/payments-api' } },
      { method: 'DELETE', url: '/debug-it/settings/repositories/acme/payments-api', body: undefined },
      { method: 'POST', url: '/debug-it/settings/users', body: { login: 'lee' } },
      { method: 'DELETE', url: '/debug-it/settings/users/1000002', body: undefined },
    ]);
  });

  test('the four changes carry X-CSRF-Token when signed in; the read does not', async () => {
    await signInAs();
    await fetchDebugItSettings();
    await addAllowedRepository('acme/payments-api');
    await removeAllowedRepository('acme/payments-api');
    await addAllowedUser('lee');
    await removeAllowedUser(1000002);
    expect(csrfOf('GET', '/debug-it/settings')).toBeUndefined();
    expect(csrfOf('POST', '/debug-it/settings/repositories')).toBe(TOKEN);
    expect(csrfOf('DELETE', '/debug-it/settings/repositories/acme/payments-api')).toBe(TOKEN);
    expect(csrfOf('POST', '/debug-it/settings/users')).toBe(TOKEN);
    expect(csrfOf('DELETE', '/debug-it/settings/users/1000002')).toBe(TOKEN);
  });
});

describe('Debug it usage client', () => {
  test('GET /debug-it/usage answers the view and carries no CSRF token', async () => {
    const VIEW = {
      month: '2026-11',
      credentialsMode: 'organization',
      monthlyCap: 5,
      users: [{ githubUserId: 1000002, login: 'lee', runs: 1, costUsd: 0.5, fixPullRequests: 0 }],
    };
    answers['GET /debug-it/usage'] = { status: 200, data: VIEW };
    await signInAs();
    await expect(fetchDebugItUsage()).resolves.toEqual(VIEW);
    const calls = seen.filter((s) => s.url === '/debug-it/usage').map(({ method, url, body }) => ({ method, url, body }));
    expect(calls).toEqual([{ method: 'GET', url: '/debug-it/usage', body: undefined }]);
    expect(csrfOf('GET', '/debug-it/usage')).toBeUndefined();
  });
});

describe('Debug it runs client', () => {
  const RUN_ID = '00000000-0000-4000-8000-000000000001';
  const RUN = {
    runId: RUN_ID,
    target: { kind: 'job', id: 900001 },
    state: 'waiting',
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
    elapsedMs: 0,
    repository: 'acme/payments-api',
    jobName: 'test',
    failureReason: null,
  };
  const OVERVIEW = { allowedRepositories: ['acme/payments-api'], runs: [RUN] };

  beforeEach(() => {
    answers['GET /debug-it/runs'] = { status: 200, data: OVERVIEW };
    answers['POST /debug-it/targets/job/900001/runs'] = { status: 201, data: RUN };
    answers['POST /debug-it/targets/run/810001/runs'] = { status: 200, data: { ...RUN, existing: true } };
    answers[`GET /debug-it/runs/${RUN_ID}`] = { status: 200, data: RUN };
  });

  test('each call uses its method and path; the start sends no body', async () => {
    await signInAs();
    await expect(fetchDebugItRuns()).resolves.toEqual(OVERVIEW);
    await expect(startDebugRun({ kind: 'job', id: 900001 })).resolves.toEqual(RUN);
    await expect(startDebugRun({ kind: 'run', id: 810001 })).resolves.toEqual({ ...RUN, existing: true });
    await expect(fetchDebugRun(RUN_ID)).resolves.toEqual(RUN);
    const calls = seen
      .filter((s) => s.url.startsWith('/debug-it/runs') || s.url.startsWith('/debug-it/targets'))
      .map(({ method, url, body }) => ({ method, url, body }));
    expect(calls).toEqual([
      { method: 'GET', url: '/debug-it/runs', body: undefined },
      { method: 'POST', url: '/debug-it/targets/job/900001/runs', body: undefined },
      { method: 'POST', url: '/debug-it/targets/run/810001/runs', body: undefined },
      { method: 'GET', url: `/debug-it/runs/${RUN_ID}`, body: undefined },
    ]);
  });

  test('kind, id and run ID are URL encoded', async () => {
    await signInAs();
    await startDebugRun({ kind: 'job/../x' as 'job', id: 1 }).catch(() => undefined);
    await fetchDebugRun('../settings?x=1').catch(() => undefined);
    const urls = seen.map((s) => s.url);
    expect(urls).toContain('/debug-it/targets/job%2F..%2Fx/1/runs');
    expect(urls).toContain('/debug-it/runs/..%2Fsettings%3Fx%3D1');
  });

  test('the start carries X-CSRF-Token when signed in; the reads do not', async () => {
    await signInAs();
    await fetchDebugItRuns();
    await startDebugRun({ kind: 'job', id: 900001 });
    await fetchDebugRun(RUN_ID);
    expect(csrfOf('GET', '/debug-it/runs')).toBeUndefined();
    expect(csrfOf('POST', '/debug-it/targets/job/900001/runs')).toBe(TOKEN);
    expect(csrfOf('GET', `/debug-it/runs/${RUN_ID}`)).toBeUndefined();
  });

  test('result and feedback (story 3.12): paths, body, CSRF only on the PUT, encoded run ID', async () => {
    const VIEW = { run: RUN, result: null, downloads: [], skippedRepositories: [], feedback: null, canGiveFeedback: false };
    const SAVED = { ...VIEW, feedback: { rating: 'useful', comment: 'Good', at: '2026-11-05T10:05:00.000Z' } };
    answers[`GET /debug-it/runs/${RUN_ID}/result`] = { status: 200, data: VIEW };
    answers[`PUT /debug-it/runs/${RUN_ID}/feedback`] = { status: 200, data: SAVED };
    await signInAs();
    await expect(fetchDebugRunResult(RUN_ID)).resolves.toEqual(VIEW);
    await expect(saveDebugRunFeedback(RUN_ID, { rating: 'useful', comment: 'Good' })).resolves.toEqual(SAVED);
    expect(seen.find((s) => s.method === 'PUT')?.body).toEqual({ rating: 'useful', comment: 'Good' });
    expect(csrfOf('GET', `/debug-it/runs/${RUN_ID}/result`)).toBeUndefined();
    expect(csrfOf('PUT', `/debug-it/runs/${RUN_ID}/feedback`)).toBe(TOKEN);
    await fetchDebugRunResult('../x').catch(() => undefined);
    await saveDebugRunFeedback('../x', { rating: 'useful' }).catch(() => undefined);
    const urls = seen.map((s) => s.url);
    expect(urls).toContain('/debug-it/runs/..%2Fx/result');
    expect(urls).toContain('/debug-it/runs/..%2Fx/feedback');
  });

  test('fix pull request (story 4.3): POST path, no body, CSRF when signed in, encoded segments', async () => {
    const PR = { repository: 'acme/payments-api', url: 'https://github.com/acme/payments-api/pull/17' };
    answers[`POST /debug-it/runs/${RUN_ID}/pull-requests/acme/payments-api`] = { status: 201, data: PR };
    await signInAs();
    await expect(openDebugFixPullRequest(RUN_ID, 'acme/payments-api')).resolves.toEqual(PR);
    const call = seen.find((s) => s.method === 'POST' && s.url.includes('/pull-requests/'));
    expect(call).toMatchObject({ url: `/debug-it/runs/${RUN_ID}/pull-requests/acme/payments-api`, body: undefined });
    expect(csrfOf('POST', `/debug-it/runs/${RUN_ID}/pull-requests/acme/payments-api`)).toBe(TOKEN);
    await openDebugFixPullRequest('../x', 'a?b/c#d/e').catch(() => undefined);
    expect(seen.map((s) => s.url)).toContain('/debug-it/runs/..%2Fx/pull-requests/a%3Fb/c%23d%2Fe');
  });

  test('a refused feedback save rejects with the backend sentence', async () => {
    answers[`PUT /debug-it/runs/${RUN_ID}/feedback`] = {
      status: 403,
      data: { error: 'Only the person who started this debug run can rate its result.' },
    };
    await signInAs();
    await expect(saveDebugRunFeedback(RUN_ID, { rating: 'useful' })).rejects.toThrow(
      'Only the person who started this debug run can rate its result.',
    );
    expect(loggedText()).not.toContain(TOKEN);
  });
});

describe('personal key client (story 5.2)', () => {
  // Invented value only; this is not a real key.
  const KEY = 'sk-ant-api03-INVENTED-TEST-KEY-0000WXYZ';
  const PATH = '/debug-it/personal-key';

  test('GET answers the status and carries no CSRF token', async () => {
    answers[`GET ${PATH}`] = { status: 200, data: { credentialsMode: 'personal', saved: true, last4: 'WXYZ' } };
    await signInAs();
    await expect(fetchPersonalKey()).resolves.toEqual({ credentialsMode: 'personal', saved: true, last4: 'WXYZ' });
    expect(csrfOf('GET', PATH)).toBeUndefined();
  });

  test('a status that is not saved shows no last 4 characters', async () => {
    answers[`GET ${PATH}`] = { status: 200, data: { credentialsMode: 'personal', saved: false, last4: 'oops' } };
    await expect(fetchPersonalKey()).resolves.toEqual({ credentialsMode: 'personal', saved: false, last4: null });
  });

  test('PUT sends { key } with X-CSRF-Token and answers the status', async () => {
    answers[`PUT ${PATH}`] = { status: 200, data: { credentialsMode: 'personal', saved: true, last4: 'WXYZ' } };
    await signInAs();
    await expect(savePersonalKey(KEY)).resolves.toEqual({ credentialsMode: 'personal', saved: true, last4: 'WXYZ' });
    const put = seen.find((s) => s.method === 'PUT' && s.url === PATH);
    expect(put?.body).toEqual({ key: KEY });
    expect(put?.csrf).toBe(TOKEN);
  });

  test('DELETE carries X-CSRF-Token, sends no body and answers the cancelled runs', async () => {
    answers[`DELETE ${PATH}`] = {
      status: 200,
      data: { credentialsMode: 'personal', saved: false, last4: null, cancelledRuns: 2 },
    };
    await signInAs();
    await expect(deletePersonalKey()).resolves.toEqual({
      credentialsMode: 'personal',
      saved: false,
      last4: null,
      cancelledRuns: 2,
    });
    const del = seen.find((s) => s.method === 'DELETE' && s.url === PATH);
    expect(del?.csrf).toBe(TOKEN);
    expect(del?.body).toBeUndefined();
  });

  test.each([400, 502, 503])('a refused save (%s) rejects with the sentence and logs neither key nor token', async (status) => {
    answers[`PUT ${PATH}`] = { status, data: { error: 'Anthropic did not accept this API key.' } };
    await signInAs();
    const error = await savePersonalKey(KEY).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ApiError', status, message: 'Anthropic did not accept this API key.' });
    expect(errorSpy).toHaveBeenCalled();
    const logged = loggedText();
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('INVENTED-TEST-KEY');
    expect(logged).not.toContain(TOKEN);
    // The error kept for the UI holds no copy of the key either.
    expect((error as { cause?: { config?: { data?: unknown } } }).cause?.config?.data).toBeUndefined();
  });

  test('a body sent to another path is not removed from its logged error', async () => {
    answers['PUT /settings/alerts'] = { status: 400, data: { error: 'Bad threshold.' } };
    await updateAlertSettings({ queueWait: { thresholdMinutes: 0 } }).catch(() => undefined);
    expect(loggedText()).toContain('thresholdMinutes');
  });
});
