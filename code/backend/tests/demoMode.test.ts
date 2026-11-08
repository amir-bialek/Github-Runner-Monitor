// Story 3.14: Debug it demo mode. With USE_MOCK_DATA=true the settings seed
// lists the mock repositories, targets resolve from the mock data, and the
// demo lifecycle moves each run to a fixed invented result with no Job, no
// Anthropic call and no GitHub call.
import express from 'express';
import request from 'supertest';

// Fail fast if anything reaches the cluster.
jest.mock('../src/adapters/kubernetes', () => {
  const actual = jest.requireActual('../src/adapters/kubernetes');
  const fail = () => {
    throw new Error('No Kubernetes call is allowed in demo mode.');
  };
  return {
    ...actual,
    getKubernetesAdapter: jest.fn(fail),
    createKubernetesAdapter: jest.fn(fail),
    // The mock-mode runner touches no cluster; any other runner fails fast.
    getIsolationCheckRunner: jest.fn((env?: Record<string, string | undefined>) =>
      env?.USE_MOCK_DATA === 'true' ? actual.getIsolationCheckRunner(env) : fail(),
    ),
  };
});

import * as kubernetes from '../src/adapters/kubernetes';
import { registerDebugIt } from '../src/routes/debugIt';
import { DEBUG_IT_DEFAULTS } from '../src/services/debugItConfig';
import { createSessionService } from '../src/services/session';
import { createMockGitHubApp, MOCK_TARBALL_SHA, resetGitHubApp, type GitHubApp } from '../src/adapters/githubApp';
import { createSettingsService, resetSettingsService } from '../src/services/debugIt/settings';
import {
  createMemoryS3Client,
  createS3Store,
  getS3Store,
  resetS3Store,
  S3StoreError,
  type S3Store,
} from '../src/adapters/s3Store';
import { getIsolationGate, resetIsolationGate, type IsolationStatus } from '../src/services/debugIt/isolation';
import {
  createRunService,
  getRunService,
  resetRunService,
  RUN_ERRORS,
  usageMonth,
  type RunRecord,
} from '../src/services/debugIt/runs';
import {
  createDemoRunLifecycle,
  DEMO_COST_USD,
  DEMO_ERRORS,
  demoResult,
  getDemoRunLifecycle,
  resetDemoRunLifecycle,
} from '../src/services/debugIt/demoLifecycle';
import { validateResult } from '../src/services/debugIt/resultSchema';
import { MOCK_REPOSITORIES, mockDebugTarget, mockFailedRuns, mockJobs } from '../src/services/mockData';
import { clearJobStore } from '../src/services/jobStore';
import { getHistory } from '../src/services/jobsService';

const KEY = Buffer.alloc(32, 4);
const DANA = { uid: 1000001, login: 'dana' };
const ON: IsolationStatus = { state: 'on', reason: null, checkedAt: '2026-11-06T09:00:00.000Z' };
const FAILED_JOB = 900012;
const FAILED_RUN = mockFailedRuns[0]!.id;
const MOCK_ENV = { USE_MOCK_DATA: 'true' };

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

function spiedGitHub() {
  const mock = createMockGitHubApp();
  const spied = {} as Record<string, jest.Mock>;
  for (const [name, fn] of Object.entries(mock)) {
    spied[name] = jest.fn((...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args));
  }
  return spied as unknown as GitHubApp & Record<keyof GitHubApp, jest.Mock>;
}

function totalCalls(github: object): number {
  return (Object.values(github) as jest.Mock[]).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function build(options: { sleep?: (ms: number) => Promise<void>; store?: S3Store; mockSettings?: boolean } = {}) {
  const store = options.store ?? createS3Store({ bucket: 'mock-bucket', client: createMemoryS3Client() });
  const settings = createSettingsService({
    store,
    config: { administrators: [], allowedRepositories: [], allowedUsers: [] },
    mock: options.mockSettings ?? true,
  });
  const github = spiedGitHub();
  let counter = 0;
  const runs = createRunService({
    store,
    githubApp: github,
    config: DEBUG_IT_DEFAULTS,
    isolation: { status: () => ON },
    organization: 'acme',
    settings,
    newRunId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    mockTargets: mockDebugTarget,
  });
  const demo = createDemoRunLifecycle({ store, runs, stepMs: 0, ...(options.sleep ? { sleep: options.sleep } : {}) });
  const session = createSessionService(KEY, { secure: false });
  const app = express();
  app.use(express.json());
  registerDebugIt(
    app,
    { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'http://localhost:8080' },
    { session, githubApp: github, env: MOCK_ENV, settings, isolation: { status: () => ON }, runs },
  );
  const value = session.seal(DANA);
  const cookie = `dbg_session=${value}`;
  const csrf = session.csrfToken(value);
  const as = {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string, body: unknown = {}) =>
      request(app).post(path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body as object),
  };
  return { app, store, settings, runs, demo, github, as };
}

async function record(store: S3Store, runId: string): Promise<RunRecord | null> {
  return (await store.read<RunRecord>(`runs/${runId}.json`))?.value ?? null;
}

async function waitForState(store: S3Store, runId: string, state: string): Promise<RunRecord> {
  for (let i = 0; i < 500; i += 1) {
    const current = await record(store, runId);
    if (current?.state === state) return current;
    await new Promise((done) => setTimeout(done, 1));
  }
  throw new Error(`run ${runId} never reached ${state}`);
}

function allLogs(): string {
  return [...log.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

const RESULT_TEXT = ['PostgreSQL', 'postgres:16', 'ECONNREFUSED', '.github/workflows/ci.yml'];

beforeEach(() => {
  clearJobStore();
  log.mockClear();
  error.mockClear();
});

afterEach(() => {
  resetRunService();
  resetDemoRunLifecycle();
});

describe('demoResult', () => {
  test('is a valid schema v1 result with a patch on the workflow file of the folder', () => {
    const result = demoResult('payments-api');
    const outcome = validateResult(JSON.stringify(result));
    expect(outcome.ok).toBe(true);
    expect(result).toMatchObject({
      causeLocation: { kind: 'this-repository' },
      failureReason: 'none',
      costUsd: 0.42,
    });
    expect(result.patch).toContain('--- a/payments-api/.github/workflows/ci.yml');
    expect(result.patch).toContain('+++ b/payments-api/.github/workflows/ci.yml');
  });
});

describe('mock settings seed', () => {
  test('the button shows: GET /debug-it/runs lists the mock repositories', async () => {
    const { as } = build();
    const res = await as.get('/debug-it/runs').expect(200);
    expect(res.body.allowedRepositories).toEqual([
      'acme/web-app',
      'acme/platform',
      'acme/infra-tools',
      'acme/billing-service',
      'acme/deploy-tools',
      'acme/payments-api',
    ]);
    expect(res.body.allowedRepositories).toEqual([...MOCK_REPOSITORIES]);
  });

  test('the seed lists the invented allowed users', async () => {
    const { settings } = build();
    expect((await settings.load()).allowedUsers).toEqual([{ githubUserId: 1000001 }, { githubUserId: 1000002 }]);
  });

  test('Helm lists win over the mock seed', async () => {
    const settings = createSettingsService({
      store: createS3Store({ bucket: 'b', client: createMemoryS3Client() }),
      config: { administrators: [], allowedRepositories: ['acme/only'], allowedUsers: [] },
      mock: true,
    });
    expect((await settings.load()).allowedRepositories).toEqual(['acme/only']);
  });

  test('real mode seeds nothing from the mock data', async () => {
    const settings = createSettingsService({
      store: createS3Store({ bucket: 'b', client: createMemoryS3Client() }),
      config: { administrators: [], allowedRepositories: [], allowedUsers: [] },
    });
    expect(await settings.load()).toEqual({ allowedRepositories: [], allowedUsers: [] });
  });
});

describe('mock targets', () => {
  test('a failed mock job resolves from the mock data', () => {
    const job = mockJobs.find((j) => j.id === FAILED_JOB)!;
    expect(mockDebugTarget('job', FAILED_JOB)).toEqual({
      kind: 'job',
      id: FAILED_JOB,
      repository: 'acme/infra-tools',
      jobName: job.name,
      headSha: job.head_sha,
      branch: expect.any(String),
      workflowRunId: job.run_id,
    });
  });

  test('the failed mock run without jobs resolves, and shows in mock Recent history', async () => {
    expect(mockDebugTarget('run', FAILED_RUN)).toEqual({
      kind: 'run',
      id: FAILED_RUN,
      repository: 'acme/payments-api',
      jobName: 'Deploy',
      headSha: mockFailedRuns[0]!.headSha,
      branch: 'main',
      workflowRunId: FAILED_RUN,
    });
    const previous = process.env.USE_MOCK_DATA;
    process.env.USE_MOCK_DATA = 'true';
    try {
      const history = await getHistory('', '', []);
      const row = history.find((h) => h.target?.kind === 'run');
      expect(row).toMatchObject({ id: FAILED_RUN, repository: 'acme/payments-api', result: 'failure', target: { kind: 'run', id: FAILED_RUN } });
      const times = history.map((h) => new Date(h.completedAt ?? h.createdAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    } finally {
      process.env.USE_MOCK_DATA = previous;
    }
  });

  test.each([
    ['a successful job', 'job', 900010],
    ['a cancelled job', 'job', 900014],
    ['an unknown job', 'job', 1],
    ['a job ID as a run', 'run', FAILED_JOB],
    ['a bad kind', 'workflow', FAILED_JOB],
  ])('%s does not resolve', (_name, kind, id) => {
    expect(mockDebugTarget(kind as 'job', id)).toBeNull();
  });

  test('the process run service consults the mock data only in mock mode', () => {
    resetRunService();
    expect(getRunService(MOCK_ENV).findTarget('job', String(FAILED_JOB))).toMatchObject({ repository: 'acme/infra-tools' });
    resetRunService();
    expect(getRunService({}).findTarget('job', String(FAILED_JOB))).toBeNull();
    expect(getRunService({}).findTarget('run', String(FAILED_RUN))).toBeNull();
  });
});

describe('demo flow', () => {
  test('click a failed job: 201 waiting, then cloning, analyzing, finished with the fixed result', async () => {
    const { as, store, demo, github } = build();
    demo.start();
    const res = await as.post(`/debug-it/targets/job/${FAILED_JOB}/runs`).expect(201);
    expect(res.body).toMatchObject({ state: 'waiting', repository: 'acme/infra-tools', target: { kind: 'job', id: FAILED_JOB } });
    const callsAfterStart = totalCalls(github);

    const finished = await waitForState(store, res.body.runId, 'finished');
    expect(finished.downloads).toEqual([{ repository: 'acme/infra-tools', commitSha: MOCK_TARBALL_SHA, folder: 'infra-tools' }]);
    expect(typeof finished.deadlineAt).toBe('string');
    expect(finished.resultCodeHash).toBeNull();
    expect(finished.result).toEqual(demoResult('infra-tools'));
    // The flow itself made no GitHub call and touched no cluster.
    expect(totalCalls(github)).toBe(callsAfterStart);
    expect(kubernetes.getKubernetesAdapter).not.toHaveBeenCalled();
    expect(kubernetes.getIsolationCheckRunner).not.toHaveBeenCalled();

    const audit = log.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes(res.body.runId));
    expect(audit.filter((l) => l.startsWith('[AUDIT] Debug it demo run'))).toEqual([
      `[AUDIT] Debug it demo run ${res.body.runId} waiting -> cloning`,
      `[AUDIT] Debug it demo run ${res.body.runId} cloning -> analyzing`,
      `[AUDIT] Debug it demo run ${res.body.runId} analyzing -> finished`,
    ]);
    for (const text of RESULT_TEXT) expect(allLogs()).not.toContain(text);

    const run = await as.get(`/debug-it/runs/${res.body.runId}`).expect(200);
    expect(run.body.state).toBe('finished');
    const result = await as.get(`/debug-it/runs/${res.body.runId}/result`).expect(200);
    expect(result.body.result.patch).toContain('a/infra-tools/.github/workflows/ci.yml');
    expect(result.body.result.costUsd).toBe(DEMO_COST_USD);
    expect(result.body.canGiveFeedback).toBe(true);

    const list = await as.get('/debug-it/runs').expect(200);
    expect(list.body.runs).toEqual([expect.objectContaining({ runId: res.body.runId, state: 'finished' })]);
  });

  test('click the failed run without jobs: the same flow for acme/payments-api', async () => {
    const { as, store, demo } = build();
    demo.start();
    const res = await as.post(`/debug-it/targets/run/${FAILED_RUN}/runs`).expect(201);
    expect(res.body).toMatchObject({ repository: 'acme/payments-api', jobName: 'Deploy', target: { kind: 'run', id: FAILED_RUN } });
    await waitForState(store, res.body.runId, 'finished');
    const result = await as.get(`/debug-it/runs/${res.body.runId}/result`).expect(200);
    expect(result.body.result.patch).toContain('a/payments-api/.github/workflows/ci.yml');
  });

  test.each([
    ['a successful job', '/debug-it/targets/job/900010/runs'],
    ['an unknown job', '/debug-it/targets/job/1/runs'],
    ['an unknown run', '/debug-it/targets/run/1/runs'],
  ])('%s is 404 with the existing sentence', async (_name, path) => {
    const { as, store } = build();
    const res = await as.post(path).expect(404);
    expect(res.body).toEqual({ error: RUN_ERRORS.targetNotFound });
    expect(await store.list('runs/')).toEqual([]);
  });

  test('a second click while the run is active answers the existing run', async () => {
    const gate = deferred();
    const { as, store, demo } = build({ sleep: () => gate.promise });
    demo.start();
    const first = await as.post(`/debug-it/targets/job/${FAILED_JOB}/runs`).expect(201);
    const second = await as.post(`/debug-it/targets/job/${FAILED_JOB}/runs`).expect(200);
    expect(second.body).toMatchObject({ runId: first.body.runId, existing: true });
    gate.resolve();
    await waitForState(store, first.body.runId, 'finished');
  });

  test('usage: dana 1 run at 0.42, lee 2 runs, sam 1 run', async () => {
    const { as, store, demo } = build();
    demo.start();
    const res = await as.post(`/debug-it/targets/job/${FAILED_JOB}/runs`).expect(201);
    await waitForState(store, res.body.runId, 'finished');
    // The cost is set right after the finished write.
    for (let i = 0; i < 100; i += 1) {
      const usage = await store.read<{ entries: Array<{ costUsd: number }> }>(`usage/${usageMonth(new Date())}/1000001.json`);
      if (usage?.value.entries[0]?.costUsd === DEMO_COST_USD) break;
      await new Promise((done) => setTimeout(done, 1));
    }
    const usage = await as.get('/debug-it/usage').expect(200);
    const rows = Object.fromEntries(
      (usage.body.users as Array<{ login: string; runs: number; costUsd: number }>).map((u) => [u.login, u]),
    );
    expect(rows.dana).toMatchObject({ runs: 1, costUsd: DEMO_COST_USD });
    expect(rows.lee).toMatchObject({ runs: 2 });
    expect(rows.sam).toMatchObject({ runs: 1 });
  });

  test('an existing usage object is left alone by the seed', async () => {
    const { store, demo } = build();
    const key = `usage/${usageMonth(new Date())}/1000002.json`;
    await store.create(key, { entries: [] });
    demo.start();
    for (let i = 0; i < 20; i += 1) await new Promise((done) => setTimeout(done, 1));
    expect((await store.read(key))!.value).toEqual({ entries: [] });
    expect(await store.read(`usage/${usageMonth(new Date())}/1000003.json`)).not.toBeNull();
  });

  test('the run record gone mid-flow: the flow stops with no write and no throw', async () => {
    let store!: S3Store;
    let calls = 0;
    const sleep = jest.fn(async () => {
      calls += 1;
      if (calls === 2) await store.deleteAllVersions(`runs/${'00000000-0000-4000-8000-000000000001'}.json`);
    });
    const built = build({ sleep });
    store = built.store;
    const res = await built.as.post(`/debug-it/targets/job/${FAILED_JOB}/runs`).expect(201);
    const created = (await record(store, res.body.runId))!;
    await expect(built.demo.advance(created)).resolves.toBeUndefined();
    expect(await record(store, res.body.runId)).toBeNull();
    expect(await store.list('runs/')).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(allLogs()).not.toContain('cloning -> analyzing');
  });

  test('a thrown S3 error logs [ERROR] and ends the run failed with a fixed sentence', async () => {
    const store = createS3Store({ bucket: 'mock-bucket', client: createMemoryS3Client() });
    const built = build({ store });
    const res = await built.as.post(`/debug-it/targets/job/${FAILED_JOB}/runs`).expect(201);
    const created = (await record(store, res.body.runId))!;
    let modifies = 0;
    const flaky: Pick<S3Store, 'modify' | 'create'> = {
      create: (key, value) => store.create(key, value),
      modify: (key, fn) => {
        modifies += 1;
        if (modifies === 2) return Promise.reject(new S3StoreError('failed', 'The S3 request failed.', key));
        return store.modify(key, fn);
      },
    };
    const demo = createDemoRunLifecycle({ store: flaky, runs: built.runs, stepMs: 0 });
    await demo.advance(created);
    const failed = (await record(store, res.body.runId))!;
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toBe(DEMO_ERRORS.s3);
    expect(error.mock.calls.map((a) => a.join(' ')).some((l) => l.startsWith('[ERROR] Debug it demo run'))).toBe(true);
  });

  test('only waiting runs are advanced', async () => {
    const { store, demo } = build();
    const modify = jest.spyOn(store, 'modify');
    await demo.advance({ runId: '00000000-0000-4000-8000-000000000009', state: 'finished' } as RunRecord);
    expect(modify).not.toHaveBeenCalled();
  });

  test('the process demo lifecycle is built lazily and reset', () => {
    const first = getDemoRunLifecycle(MOCK_ENV);
    expect(getDemoRunLifecycle(MOCK_ENV)).toBe(first);
    resetDemoRunLifecycle();
    expect(getDemoRunLifecycle(MOCK_ENV)).not.toBe(first);
  });
});

describe('process wiring in mock mode', () => {
  function resetAll(): void {
    resetDemoRunLifecycle();
    resetRunService();
    resetSettingsService();
    resetIsolationGate();
    kubernetes.resetIsolationCheckRunner();
    resetGitHubApp();
    resetS3Store();
  }

  afterEach(() => {
    jest.useRealTimers();
    resetAll();
  });

  test('the process gate, run service and demo lifecycle take a failed mock job to finished', async () => {
    resetAll();
    expect((await getIsolationGate(MOCK_ENV).run()).state).toBe('on');

    const session = createSessionService(KEY, { secure: false });
    const app = express();
    app.use(express.json());
    registerDebugIt(app, { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'http://localhost:8080' }, { session, env: MOCK_ENV });
    getDemoRunLifecycle(MOCK_ENV).start();

    // The singleton keeps the default 3 s step: move the clock instead of waiting.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] });
    const value = session.seal(DANA);
    const res = await request(app)
      .post(`/debug-it/targets/job/${FAILED_JOB}/runs`)
      .set('Cookie', `dbg_session=${value}`)
      .set('X-CSRF-Token', session.csrfToken(value))
      .expect(201);
    expect(res.body.state).toBe('waiting');

    const store = getS3Store(MOCK_ENV);
    let state = (await record(store, res.body.runId))?.state;
    for (let i = 0; i < 10 && state !== 'finished'; i += 1) {
      await jest.advanceTimersByTimeAsync(3000);
      state = (await record(store, res.body.runId))?.state;
    }
    expect(state).toBe('finished');
    expect(kubernetes.getKubernetesAdapter).not.toHaveBeenCalled();
  });
});
