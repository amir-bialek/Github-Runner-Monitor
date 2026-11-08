import express from 'express';
import request from 'supertest';
import { registerDebugIt } from '../src/routes/debugIt';
import { DEBUG_IT_DEFAULTS } from '../src/services/debugItConfig';
import { createSessionService } from '../src/services/session';
import { createMockGitHubApp, GitHubAppError, type GitHubApp, type RepositoryPermission } from '../src/adapters/githubApp';
import { createSettingsService } from '../src/services/debugIt/settings';
import { createMemoryS3Client, createS3Store, type S3Client, type S3Command } from '../src/adapters/s3Store';
import { CHECK_ERRORS } from '../src/routes/checkChain';
import { ISOLATION_REASONS, type IsolationStatus } from '../src/services/debugIt/isolation';
import { createRunService, RUN_ERRORS, type RunRecord } from '../src/services/debugIt/runs';
import { PATCH_RULE_MESSAGES, type PatchRule } from '../src/services/debugIt/patchValidation';
import { clearJobStore, keepFailedRun, upsert } from '../src/services/jobStore';
import type { WorkflowJobEvent, WorkflowRunEvent } from '../src/types/webhook';

const KEY = Buffer.alloc(32, 9);
const DANA = { uid: 1000001, login: 'dana' }; // allowed user
const LEE = { uid: 1000002, login: 'lee' }; // allowed user
const SAM = { uid: 1000003, login: 'sam' }; // not allowed
const REPO = 'acme/payments-api';
const JOB_ID = 900001;
const RUN_ID = 810001;
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NOVEMBER = new Date('2026-11-05T10:00:00.000Z');
const ON: IsolationStatus = { state: 'on', reason: null, checkedAt: '2026-11-05T09:00:00.000Z' };

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

function failedJob(id: number, repository = REPO, conclusion = 'failure'): void {
  const now = new Date().toISOString();
  upsert({
    action: 'completed',
    workflow_job: {
      id,
      run_id: 700001,
      run_attempt: 1,
      name: 'test',
      status: 'completed',
      conclusion,
      head_sha: SHA,
      head_branch: 'feature/refunds',
      workflow_name: 'CI',
      created_at: now,
      started_at: now,
      completed_at: now,
      html_url: '',
      run_url: '',
      labels: [],
      steps: [],
    },
    repository: { full_name: repository, name: repository.split('/')[1], html_url: '', owner: { login: 'acme' } },
  } as unknown as WorkflowJobEvent);
}

function failedRun(id: number): void {
  const now = new Date().toISOString();
  keepFailedRun({
    action: 'completed',
    workflow_run: {
      id,
      run_attempt: 1,
      name: 'Deploy',
      head_branch: 'main',
      head_sha: SHA,
      html_url: `https://github.com/${REPO}/actions/runs/${id}`,
      created_at: now,
      updated_at: now,
      conclusion: 'failure',
      event: 'push',
    },
    repository: { full_name: REPO },
  } as unknown as WorkflowRunEvent);
}

function fakeGitHub(permission: (uid: number, repository: string) => RepositoryPermission = () => 'read') {
  const mock = createMockGitHubApp();
  return {
    ...mock,
    checkPermission: jest.fn(async (user: { githubUserId: number }, repository: string) =>
      permission(user.githubUserId, repository),
    ),
    readContextFile: jest.fn(mock.readContextFile),
    readWorkflowRun: jest.fn(mock.readWorkflowRun),
  } satisfies GitHubApp;
}

function build(
  options: { github?: ReturnType<typeof fakeGitHub>; isolation?: IsolationStatus; client?: S3Client; allowedRepositories?: string[] } = {},
) {
  const client = options.client ?? createMemoryS3Client();
  const store = createS3Store({ bucket: 'acme-bucket', client });
  const settings = createSettingsService({
    store,
    config: {
      administrators: ['1000001'],
      allowedRepositories: options.allowedRepositories ?? [REPO],
      allowedUsers: ['1000001', '1000002'],
    },
  });
  const github = options.github ?? fakeGitHub();
  const isolation = { status: () => options.isolation ?? ON };
  let counter = 0;
  const runs = createRunService({
    store,
    githubApp: github,
    config: DEBUG_IT_DEFAULTS,
    isolation,
    organization: 'acme',
    now: () => NOVEMBER,
    newRunId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
  const session = createSessionService(KEY, { secure: false });
  const app = express();
  app.use(express.json());
  registerDebugIt(
    app,
    { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'https://monitor.acme.example', githubAppClientId: 'Iv1.acme' },
    { session, githubApp: github, env: {}, settings, isolation, runs },
  );
  const as = (user = DANA) => {
    const value = session.seal(user);
    const cookie = `dbg_session=${value}`;
    const csrf = session.csrfToken(value);
    return {
      get: (path: string) => request(app).get(path).set('Cookie', cookie),
      post: (path: string, body: unknown = {}) =>
        request(app).post(path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body as object),
      postNoCsrf: (path: string) => request(app).post(path).set('Cookie', cookie).send({}),
      put: (path: string, body: unknown = {}) =>
        request(app).put(path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body as object),
      putNoCsrf: (path: string, body: unknown = {}) => request(app).put(path).set('Cookie', cookie).send(body as object),
      sealed: value,
      csrf,
    };
  };
  // Every object except the settings record.
  const objects = async () => [...(await store.list('usage/')), ...(await store.list('runs/'))];
  return { app, store, github, runs, settings, as, objects };
}

function allLogs(): string {
  return [...log.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

const START = `/debug-it/targets/job/${JOB_ID}/runs`;

beforeEach(() => {
  clearJobStore();
  log.mockClear();
  error.mockClear();
  failedJob(JOB_ID);
  failedRun(RUN_ID);
});

describe('POST /debug-it/targets/{kind}/{id}/runs', () => {
  test('an allowed user starts a run on a failed job: 201 waiting', async () => {
    const { as, store, github } = build();
    const res = await as().post(START).expect(201);
    expect(res.body).toEqual({
      runId: '00000000-0000-4000-8000-000000000001',
      target: { kind: 'job', id: JOB_ID },
      state: 'waiting',
      createdAt: NOVEMBER.toISOString(),
      updatedAt: NOVEMBER.toISOString(),
      elapsedMs: 0,
      repository: REPO,
      jobName: 'test',
      failureReason: null,
    });
    const record = (await store.read<RunRecord>('runs/00000000-0000-4000-8000-000000000001.json'))!.value;
    expect(record.usageKey).toBe('usage/2026-11/1000001.json');
    expect(record.headRepository).toBe(REPO);
    expect(await store.read('usage/2026-11/1000001.json')).not.toBeNull();
    expect(github.checkPermission).toHaveBeenCalledWith({ githubUserId: 1000001, login: 'dana' }, REPO, { fresh: false });
  });

  test('a failed run without jobs: 201 with kind run', async () => {
    const { as } = build();
    const res = await as().post(`/debug-it/targets/run/${RUN_ID}/runs`).expect(201);
    expect(res.body).toMatchObject({ target: { kind: 'run', id: RUN_ID }, jobName: 'Deploy' });
  });

  test('the request body and query string are ignored', async () => {
    const { as, store } = build();
    const res = await as()
      .post(`${START}?repository=acme/other&headSha=deadbeef`, {
        repository: 'acme/other',
        headSha: 'deadbeef',
        branch: 'evil',
        jobName: 'evil',
        target: { kind: 'run', id: 1 },
        requester: { githubUserId: 1, login: 'mallory' },
      })
      .expect(201);
    const record = (await store.read<RunRecord>(`runs/${res.body.runId}.json`))!.value;
    expect(record).toMatchObject({
      repository: REPO,
      headSha: SHA,
      branch: 'feature/refunds',
      jobName: 'test',
      target: { kind: 'job', id: JOB_ID },
      requester: { githubUserId: 1000001, login: 'dana' },
    });
    expect(JSON.stringify(record)).not.toMatch(/acme\/other|deadbeef|evil|mallory/);
  });

  test.each([
    ['an unknown job', `/debug-it/targets/job/123/runs`],
    ['a successful job', `/debug-it/targets/job/900002/runs`],
    ['a bad kind', `/debug-it/targets/workflow/${JOB_ID}/runs`],
    ['a bad ID', `/debug-it/targets/job/abc/runs`],
    ['a zero ID', `/debug-it/targets/job/0/runs`],
    ['a job ID as a run', `/debug-it/targets/run/${JOB_ID}/runs`],
  ])('%s is 404 with no GitHub call and nothing written', async (_name, path) => {
    failedJob(900002, REPO, 'success');
    const { as, github, objects } = build();
    const res = await as().post(path).expect(404);
    expect(res.body).toEqual({ error: RUN_ERRORS.targetNotFound });
    expect(github.checkPermission).not.toHaveBeenCalled();
    expect(github.readContextFile).not.toHaveBeenCalled();
    expect(await objects()).toEqual([]);
  });

  test('without a session: 401', async () => {
    const { app } = build();
    await request(app).post(START).expect(401);
  });

  test('without a CSRF token: 403', async () => {
    const { as, objects } = build();
    const res = await as().postNoCsrf(START).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.csrf });
    expect(await objects()).toEqual([]);
  });

  test('a user who is not allowed: 403 before the target lookup', async () => {
    const { as, github, objects } = build();
    const res = await as(SAM).post(START).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notAllowedUser });
    expect(github.checkPermission).not.toHaveBeenCalled();
    expect(await objects()).toEqual([]);
  });

  test('a repository that is not allowed: 403', async () => {
    failedJob(900003, 'acme/billing');
    const { as, github, objects } = build();
    const res = await as().post('/debug-it/targets/job/900003/runs').expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.repositoryNotAllowed });
    expect(github.readContextFile).not.toHaveBeenCalled();
    expect(await objects()).toEqual([]);
  });

  test('no read access: 403', async () => {
    const { as, github, objects } = build({ github: fakeGitHub(() => 'none') });
    const res = await as().post(START).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.tooLittleAccess });
    expect(github.readContextFile).not.toHaveBeenCalled();
    expect(await objects()).toEqual([]);
  });

  test('the isolation gate off: 503 with its reason', async () => {
    const isolation: IsolationStatus = { state: 'off', reason: ISOLATION_REASONS.timeout, checkedAt: null };
    const { as, objects } = build({ isolation });
    const res = await as().post(START).expect(503);
    expect(res.body).toEqual({ error: ISOLATION_REASONS.timeout });
    expect(await objects()).toEqual([]);
  });

  test('a missing context file: 409 with its reason', async () => {
    const github = fakeGitHub();
    github.readContextFile.mockResolvedValue({ status: 'missing' });
    const { as, objects } = build({ github });
    const res = await as().post(START).expect(409);
    expect(res.body.error).toBe(`${REPO} has no debug context file at .github/claude-debug-context.md on its default branch.`);
    expect(await objects()).toEqual([]);
  });

  test('the cap reached: 429 with the reset date', async () => {
    const { as, store } = build();
    await store.create('usage/2026-11/1000001.json', {
      entries: Array.from({ length: 5 }, (_, i) => ({ runId: `seed-${i}`, costUsd: 0, fixPullRequests: 0 })),
    });
    const res = await as().post(START).expect(429);
    expect(res.body).toEqual({
      error: 'You have used all 5 debug runs for this month; your runs reset on 2026-12-01 (UTC).',
    });
    expect(await store.list('runs/')).toEqual([]);
  });

  test('S3 down: 503', async () => {
    const memory = createMemoryS3Client();
    const client: S3Client = {
      async send(command: S3Command) {
        if (command.name === 'HeadBucketCommand') {
          throw Object.assign(new Error('TimeoutError'), { name: 'TimeoutError', $metadata: {} });
        }
        return memory.send(command);
      },
    };
    const { as, objects } = build({ client });
    const res = await as().post(START).expect(503);
    expect(res.body).toEqual({ error: RUN_ERRORS.s3 });
    expect(await objects()).toEqual([]);
  });

  test('a second click by a user with read access opens the run in progress', async () => {
    const { as, store } = build();
    const first = await as().post(START).expect(201);
    const second = await as(LEE).post(START).expect(200);
    expect(second.body).toEqual({ ...first.body, existing: true });
    expect(await store.list('runs/')).toHaveLength(1);
    expect(await store.read('usage/2026-11/1000002.json')).toBeNull();
  });

  test('10 concurrent clicks on one target: one 201, the rest 200 existing', async () => {
    const { as, store } = build();
    const responses = await Promise.all(Array.from({ length: 10 }, () => as().post(START)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200 && r.body.existing === true)).toHaveLength(9);
    expect(await store.list('runs/')).toHaveLength(1);
  });

  test('no log line holds a session cookie or CSRF token', async () => {
    const { as } = build();
    const dana = as();
    await dana.post(START).expect(201);
    await dana.get('/debug-it/runs/00000000-0000-4000-8000-000000000001').expect(200);
    await dana.postNoCsrf(START).expect(403);
    const logs = allLogs();
    expect(logs).not.toMatch(/dbg_session|X-CSRF/i);
    expect(dana.sealed.length).toBeGreaterThan(0);
    expect(dana.csrf.length).toBeGreaterThan(0);
    expect(logs).not.toContain(dana.sealed);
    expect(logs).not.toContain(dana.csrf);
  });
});

describe('GET /debug-it/runs/{runId}', () => {
  test('a user with read access sees state and elapsed time', async () => {
    const { as } = build();
    const started = await as().post(START).expect(201);
    const res = await as(LEE).get(`/debug-it/runs/${started.body.runId}`).expect(200);
    expect(res.body).toEqual(started.body);
  });

  test.each(['not-a-uuid', '00000000-0000-4000-8000-00000000000A', '..'])('malformed run ID %j: 404', async (runId) => {
    const { as, github } = build();
    const res = await as().get(`/debug-it/runs/${runId}`).expect(404);
    expect(res.body).toEqual({ error: RUN_ERRORS.runNotFound });
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('an unknown run: 404 with no permission call', async () => {
    const { as, github } = build();
    const res = await as().get('/debug-it/runs/00000000-0000-4000-8000-000000000042').expect(404);
    expect(res.body).toEqual({ error: RUN_ERRORS.runNotFound });
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('a user without read access to a downloaded repository: 403', async () => {
    const github = fakeGitHub((uid, repository) => (uid === 1000002 && repository === 'acme/shared-config' ? 'none' : 'read'));
    const { as, store } = build({ github });
    // Downloads are set by story 3.8; written straight to the store here.
    await store.create('settings.json', {
      allowedRepositories: [REPO, 'acme/shared-config'],
      allowedUsers: [{ githubUserId: 1000001 }, { githubUserId: 1000002 }],
    });
    const started = await as().post(START).expect(201);
    await store.modify<RunRecord>(`runs/${started.body.runId}.json`, (r) => ({
      ...r!,
      downloads: [
        { repository: REPO, commitSha: SHA, folder: 'payments-api' },
        { repository: 'acme/shared-config', commitSha: SHA, folder: 'shared-config' },
      ],
    }));
    const res = await as(LEE).get(`/debug-it/runs/${started.body.runId}`).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.tooLittleAccess });
    await as().get(`/debug-it/runs/${started.body.runId}`).expect(200);
  });

  test('a user who is not allowed: 403', async () => {
    const { as } = build();
    const started = await as().post(START).expect(201);
    const res = await as(SAM).get(`/debug-it/runs/${started.body.runId}`).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notAllowedUser });
  });

  test('without a session: 401', async () => {
    const { app } = build();
    await request(app).get('/debug-it/runs/00000000-0000-4000-8000-000000000001').expect(401);
  });
});

describe('GET /debug-it/runs (story 3.11)', () => {
  const LIST = '/debug-it/runs';

  async function startAndRead(store: ReturnType<typeof build>['store'], as: ReturnType<typeof build>['as'], path = START) {
    const started = await as().post(path).expect(201);
    return (await store.read<RunRecord>(`runs/${started.body.runId}.json`))!.value;
  }

  test('without a session: 401', async () => {
    const { app } = build();
    const res = await request(app).get(LIST).expect(401);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notSignedIn });
  });

  test('a user who is not allowed: 403', async () => {
    const { as, github } = build();
    const res = await as(SAM).get(LIST).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.notAllowedUser });
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('no runs: the allowed repositories and an empty list', async () => {
    const { as } = build();
    const res = await as().get(LIST).expect(200);
    expect(res.body).toEqual({ allowedRepositories: [REPO], runs: [] });
  });

  test('only the signed in user\'s latest runs, as run views', async () => {
    const { as } = build();
    const job = await as().post(START).expect(201);
    const run = await as().post(`/debug-it/targets/run/${RUN_ID}/runs`).expect(201);
    const dana = await as().get(LIST).expect(200);
    expect(dana.body.allowedRepositories).toEqual([REPO]);
    expect(dana.body.runs).toEqual(expect.arrayContaining([job.body, run.body]));
    expect(dana.body.runs).toHaveLength(2);
    // Lee opened Dana's run through the POST; it is still Dana's.
    await as(LEE).post(START).expect(200);
    expect((await as(LEE).get(LIST).expect(200)).body.runs).toEqual([]);
  });

  test('no secret or result field is answered', async () => {
    const { as, store, runs } = build();
    const record = await startAndRead(store, as);
    runs.trackRun({ ...record, state: 'finished', resultCodeHash: 'f'.repeat(64), result: { summary: 'secret result' } });
    const res = await as().get(LIST).expect(200);
    expect(Object.keys(res.body.runs[0]).sort()).toEqual(
      ['createdAt', 'elapsedMs', 'failureReason', 'jobName', 'repository', 'runId', 'state', 'target', 'updatedAt'].sort(),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/secret result|ffff|usage|requester/);
  });

  test('a failed run lists its failure reason', async () => {
    const { as, store, runs } = build();
    const record = await startAndRead(store, as);
    runs.trackRun({ ...record, state: 'failed', failureReason: 'The Debug Job of this run no longer exists.' });
    const res = await as().get(LIST).expect(200);
    expect(res.body.runs).toEqual([
      expect.objectContaining({ state: 'failed', failureReason: 'The Debug Job of this run no longer exists.' }),
    ]);
  });

  test('a run whose repository is no longer allowed is dropped, with no permission call', async () => {
    const { as, store, runs, github } = build();
    const record = await startAndRead(store, as);
    runs.trackRun({
      ...record,
      state: 'analyzing',
      downloads: [{ repository: 'acme/shared-config', commitSha: SHA, folder: 'shared-config' }],
    });
    github.checkPermission.mockClear();
    const res = await as().get(LIST).expect(200);
    expect(res.body.runs).toEqual([]);
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('a run the user can no longer read is dropped', async () => {
    let permission: RepositoryPermission = 'read';
    const github = fakeGitHub(() => permission);
    const { as, store } = build({ github });
    await startAndRead(store, as);
    expect((await as().get(LIST).expect(200)).body.runs).toHaveLength(1);
    permission = 'none';
    expect((await as().get(LIST).expect(200)).body.runs).toEqual([]);
  });

  test('a GitHub error drops that run and does not fail the answer', async () => {
    const { as, store, github } = build();
    await startAndRead(store, as);
    await startAndRead(store, as, `/debug-it/targets/run/${RUN_ID}/runs`);
    let calls = 0;
    github.checkPermission.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new GitHubAppError('GitHub did not answer.');
      return 'read';
    });
    const res = await as().get(LIST).expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.allowedRepositories).toEqual([REPO]);
  });

  test('settings that cannot be read: 503', async () => {
    const memory = createMemoryS3Client();
    let settingsReads = 0;
    let failFrom = Number.POSITIVE_INFINITY;
    const client: S3Client = {
      async send(command: S3Command) {
        const key = String((command.input as { Key?: unknown }).Key ?? '');
        if (command.name === 'GetObjectCommand' && key.endsWith('settings.json')) {
          settingsReads += 1;
          if (settingsReads >= failFrom) {
            throw Object.assign(new Error('TimeoutError'), { name: 'TimeoutError', $metadata: {} });
          }
        }
        return memory.send(command);
      },
    };
    const { as } = build({ client });
    await as().get(LIST).expect(200);
    // The allowed user step reads the settings first; the listing's own read fails.
    failFrom = settingsReads + 2;
    const res = await as().get(LIST).expect(503);
    expect(res.body).toEqual({ error: CHECK_ERRORS.settingsUnreadable });
  });
});

describe('GET /debug-it/runs/{runId}/result and PUT .../feedback (story 3.12)', () => {
  const ID = '00000000-0000-4000-8000-000000000077';
  const RESULT_PATH = `/debug-it/runs/${ID}/result`;
  const FEEDBACK_PATH = `/debug-it/runs/${ID}/feedback`;
  const EXPLANATION = 'The refund test expects a rounding mode the code no longer uses.';
  const PATCH = 'diff --git a/src/refund.ts b/src/refund.ts\n--- a/src/refund.ts\n+++ b/src/refund.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const COMMENT = 'Spot on, applied it as is.';

  function finishedRecord(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      runId: ID,
      target: { kind: 'job', id: JOB_ID },
      requester: { githubUserId: DANA.uid, login: DANA.login },
      state: 'finished',
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T10:04:00.000Z',
      repository: REPO,
      headRepository: REPO,
      headSha: SHA,
      branch: 'feature/refunds',
      jobName: 'test',
      downloads: [{ repository: REPO, commitSha: SHA, folder: 'payments-api' }],
      usageKey: 'usage/2026-11/1000001.json',
      resultCodeHash: 'f'.repeat(64),
      result: {
        schemaVersion: 1,
        explanation: EXPLANATION,
        causeLocation: { kind: 'this-repository' },
        patch: PATCH,
        costUsd: 0.4231,
        inputTokens: 1200,
        outputTokens: 300,
        durationMs: 154000,
        logTruncated: true,
        failureReason: 'none',
      },
      feedback: null,
      fixPullRequests: [],
      failureReason: null,
      skippedRepositories: [{ repository: 'acme/private-tools', reason: 'It is not on the allowed list.' }],
      logTruncated: true,
      ...overrides,
    };
  }

  async function seeded(record: RunRecord = finishedRecord(), options: Parameters<typeof build>[0] = {}) {
    const built = build(options);
    await built.store.create(`runs/${ID}.json`, record);
    return built;
  }

  test('a finished run, read by a reader: the result view, nothing secret', async () => {
    const { as } = await seeded();
    const res = await as(LEE).get(RESULT_PATH).expect(200);
    expect(res.body).toEqual({
      run: expect.objectContaining({ runId: ID, state: 'finished', elapsedMs: 240000, failureReason: null }),
      result: {
        explanation: EXPLANATION,
        causeLocation: { kind: 'this-repository' },
        patch: PATCH,
        costUsd: 0.4231,
        durationMs: 154000,
        logTruncated: true,
        failureReason: 'none',
      },
      downloads: [{ repository: REPO, commitSha: SHA, folder: 'payments-api' }],
      skippedRepositories: [{ repository: 'acme/private-tools', reason: 'It is not on the allowed list.' }],
      feedback: null,
      canGiveFeedback: false,
      // The stored patch names src/, which is not a download folder.
      patchCheck: {
        status: 'refused',
        rule: 'outside-downloads',
        message: PATCH_RULE_MESSAGES['outside-downloads'],
        repositories: [],
      },
      fixPullRequests: [],
      canOpenPullRequest: [],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ffff|usage|requester|1000001|inputTokens/);
    const mine = await as().get(RESULT_PATH).expect(200);
    expect(mine.body.canGiveFeedback).toBe(true);
    expect(allLogs()).not.toContain(EXPLANATION);
  });

  test('an active run: result null, no feedback', async () => {
    const { as } = await seeded(finishedRecord({ state: 'analyzing', result: null }));
    const res = await as().get(RESULT_PATH).expect(200);
    expect(res.body).toMatchObject({ result: null, canGiveFeedback: false, feedback: null, patchCheck: null });
  });

  test('one repository the user cannot read: 403, no result', async () => {
    const github = fakeGitHub((_uid, repository) => (repository === 'acme/shared-config' ? 'none' : 'read'));
    const record = finishedRecord({
      downloads: [
        { repository: REPO, commitSha: SHA, folder: 'payments-api' },
        { repository: 'acme/shared-config', commitSha: SHA, folder: 'shared-config' },
      ],
    });
    const { as } = await seeded(record, { github });
    const res = await as().get(RESULT_PATH).expect(403);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(JSON.stringify(res.body)).not.toContain(EXPLANATION);
    await as().put(FEEDBACK_PATH, { rating: 'useful' }).expect(403);
  });

  test('unknown and bad run IDs: 404', async () => {
    const { as } = build();
    expect((await as().get(RESULT_PATH).expect(404)).body).toEqual({ error: RUN_ERRORS.runNotFound });
    await as().get('/debug-it/runs/not-a-run/result').expect(404);
    await as().put(FEEDBACK_PATH, { rating: 'useful' }).expect(404);
  });

  test('a user who is not allowed: 403', async () => {
    const { as } = await seeded();
    expect((await as(SAM).get(RESULT_PATH).expect(403)).body).toEqual({ error: CHECK_ERRORS.notAllowedUser });
  });

  test('the requester rates the result; a later save replaces it', async () => {
    const { as, store } = await seeded();
    const res = await as().put(FEEDBACK_PATH, { rating: 'useful', comment: `  ${COMMENT}  ` }).expect(200);
    expect(res.body.feedback).toEqual({ rating: 'useful', comment: COMMENT, at: NOVEMBER.toISOString() });
    expect(res.body.canGiveFeedback).toBe(true);
    const stored = (await store.read<RunRecord>(`runs/${ID}.json`))!.value;
    expect(stored.feedback).toEqual({ rating: 'useful', comment: COMMENT, at: NOVEMBER.toISOString(), githubUserId: DANA.uid });
    expect({ ...stored, feedback: null }).toEqual(finishedRecord());

    const again = await as().put(FEEDBACK_PATH, { rating: 'not-useful', comment: '   ' }).expect(200);
    expect(again.body.feedback).toEqual({ rating: 'not-useful', comment: null, at: NOVEMBER.toISOString() });
    expect((await as().get(RESULT_PATH).expect(200)).body.feedback).toMatchObject({ rating: 'not-useful' });

    const audit = log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT] Debug it run'));
    expect(audit).toEqual([
      `[AUDIT] Debug it run ${ID} rated useful by GitHub user ${DANA.uid}`,
      `[AUDIT] Debug it run ${ID} rated not-useful by GitHub user ${DANA.uid}`,
    ]);
    expect(allLogs()).not.toContain(COMMENT);
    expect(allLogs()).not.toContain(EXPLANATION);
  });

  test('another reader cannot rate: 403', async () => {
    const { as, store } = await seeded();
    const res = await as(LEE).put(FEEDBACK_PATH, { rating: 'useful' }).expect(403);
    expect(res.body).toEqual({ error: RUN_ERRORS.feedbackNotRequester });
    expect((await store.read<RunRecord>(`runs/${ID}.json`))!.value.feedback).toBeNull();
  });

  test.each([
    [{ rating: 'great' }, RUN_ERRORS.feedbackRating],
    [{}, RUN_ERRORS.feedbackRating],
    [{ rating: 'useful', comment: 'x'.repeat(2001) }, RUN_ERRORS.feedbackComment],
    [{ rating: 'useful', comment: 42 }, RUN_ERRORS.feedbackComment],
  ])('a bad body %#: 400', async (body, sentence) => {
    const { as, store } = await seeded();
    const res = await as().put(FEEDBACK_PATH, body).expect(400);
    expect(res.body).toEqual({ error: sentence });
    expect((await store.read<RunRecord>(`runs/${ID}.json`))!.value.feedback).toBeNull();
  });

  test('a comment of exactly 2000 characters is kept', async () => {
    const { as } = await seeded();
    const res = await as().put(FEEDBACK_PATH, { rating: 'useful', comment: 'y'.repeat(2000) }).expect(200);
    expect(res.body.feedback.comment).toHaveLength(2000);
  });

  test('without a CSRF token: 403 at the CSRF step', async () => {
    const { as, store } = await seeded();
    const res = await as().putNoCsrf(FEEDBACK_PATH, { rating: 'useful' }).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.csrf });
    expect((await store.read<RunRecord>(`runs/${ID}.json`))!.value.feedback).toBeNull();
  });

  test('a run without a result: 409', async () => {
    const { as } = await seeded(finishedRecord({ state: 'analyzing', result: null }));
    const res = await as().put(FEEDBACK_PATH, { rating: 'useful' }).expect(409);
    expect(res.body).toEqual({ error: RUN_ERRORS.feedbackNoResult });
  });

  test('S3 down on the save: 503', async () => {
    const memory = createMemoryS3Client();
    let failPuts = false;
    const client: S3Client = {
      async send(command: S3Command) {
        if (failPuts && command.name === 'PutObjectCommand') {
          throw Object.assign(new Error('TimeoutError'), { name: 'TimeoutError', $metadata: {} });
        }
        return memory.send(command);
      },
    };
    const { as } = await seeded(finishedRecord(), { client });
    await as().get(RESULT_PATH).expect(200); // the settings record is created first
    failPuts = true;
    const res = await as().put(FEEDBACK_PATH, { rating: 'useful', comment: COMMENT }).expect(503);
    expect(res.body).toEqual({ error: RUN_ERRORS.s3Feedback });
    expect(allLogs()).not.toContain(COMMENT);
  });
});

describe('GET /debug-it/runs/{runId}/result: patchCheck (story 4.1)', () => {
  const ID = '00000000-0000-4000-8000-000000000041';
  const RESULT_PATH = `/debug-it/runs/${ID}/result`;
  const DOWNLOADS = [
    { repository: REPO, commitSha: SHA, folder: 'payments-api' },
    { repository: 'acme/shared-lib', commitSha: SHA, folder: 'shared-lib' },
  ];
  const HUNK = '@@ -1 +1 @@\n-old\n+new\n';
  const file = (oldPath: string, newPath = oldPath.replace(/^a\//, 'b/')) => `--- ${oldPath}\n+++ ${newPath}\n${HUNK}`;
  const CLEAN = file('a/payments-api/src/db.ts');

  function record(patch: string | null): RunRecord {
    return {
      runId: ID,
      target: { kind: 'job', id: JOB_ID },
      requester: { githubUserId: DANA.uid, login: DANA.login },
      state: 'finished',
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T10:04:00.000Z',
      repository: REPO,
      headRepository: REPO,
      headSha: SHA,
      branch: 'feature/refunds',
      jobName: 'test',
      downloads: DOWNLOADS,
      usageKey: 'usage/2026-11/1000001.json',
      resultCodeHash: 'f'.repeat(64),
      result:
        patch === null
          ? null
          : {
              schemaVersion: 1,
              explanation: 'Why it failed.',
              causeLocation: { kind: 'this-repository' },
              patch,
              costUsd: 0.1,
              inputTokens: 1,
              outputTokens: 1,
              durationMs: 1000,
              logTruncated: false,
              failureReason: 'none',
            },
      feedback: null,
      fixPullRequests: [],
      failureReason: null,
    };
  }

  async function read(patch: string | null) {
    const { store, as } = build({ allowedRepositories: [REPO, 'acme/shared-lib'] });
    await store.create(`runs/${ID}.json`, record(patch));
    return (await as().get(RESULT_PATH).expect(200)).body;
  }

  test('a clean patch is answered passed, per repository', async () => {
    const body = await read(CLEAN + file('a/shared-lib/README.md'));
    expect(body.patchCheck).toEqual({
      status: 'passed',
      rule: null,
      message: null,
      repositories: [
        { repository: REPO, folder: 'payments-api', files: ['src/db.ts'], status: 'passed', rule: null, message: null },
        { repository: 'acme/shared-lib', folder: 'shared-lib', files: ['README.md'], status: 'passed', rule: null, message: null },
      ],
    });
    expect(JSON.stringify(body.patchCheck)).not.toMatch(/sections|oldPath|@@/);
  });

  test('a run with no result has patchCheck null', async () => {
    expect((await read(null)).patchCheck).toBeNull();
  });

  test('an empty patch is answered empty', async () => {
    expect((await read('')).patchCheck).toEqual({ status: 'empty', rule: null, message: null, repositories: [] });
  });

  const HOSTILE: Array<[PatchRule, string]> = [
    ['too-large', CLEAN.replace('+new', `+${'x'.repeat(102400)}`)],
    ['unreadable', 'diff --git a/payments-api/x.png b/payments-api/x.png\nBinary files a/payments-api/x.png and b/payments-api/x.png differ\n'],
    ['outside-downloads', CLEAN + file('a/other-repo/x')],
    ['outside-repository', CLEAN + file('a/shared-lib/x', 'b/shared-lib/../../etc/passwd')],
    ['git-internals', CLEAN + file('a/shared-lib/.GIT/hooks/pre-commit')],
    ['workflow-file', CLEAN + file('a/shared-lib/.github\\WorkFlows/ci.yml')],
    ['symbolic-link', CLEAN + 'diff --git a/shared-lib/l b/shared-lib/l\nnew file mode 120000\n--- /dev/null\n+++ b/shared-lib/l\n@@ -0,0 +1 @@\n+/etc/passwd\n'],
    ['file-mode', CLEAN + 'diff --git a/shared-lib/run.sh b/shared-lib/run.sh\nold mode 100644\nnew mode 100755\n'],
  ];

  test.each(HOSTILE)('a stored %s patch is refused with that rule, and not logged', async (rule, patch) => {
    const body = await read(patch);
    expect(body.patchCheck.status).toBe('refused');
    expect(body.patchCheck.rule).toBe(rule);
    expect(body.patchCheck.message).toBe(PATCH_RULE_MESSAGES[rule]);
    if (rule === 'unreadable') {
      expect(body.patchCheck.repositories).toEqual([]);
    } else if (rule === 'too-large' || rule === 'outside-downloads') {
      expect(body.patchCheck.repositories).toEqual([
        expect.objectContaining({ folder: 'payments-api', status: 'refused', rule, message: PATCH_RULE_MESSAGES[rule] }),
      ]);
    } else {
      expect(body.patchCheck.repositories).toEqual([
        expect.objectContaining({ folder: 'payments-api', status: 'passed', rule: null, message: null }),
        expect.objectContaining({ folder: 'shared-lib', status: 'refused', rule, message: PATCH_RULE_MESSAGES[rule] }),
      ]);
    }
    const logs = allLogs();
    expect(logs).not.toContain('payments-api/');
    expect(logs).not.toContain('shared-lib/');
    expect(logs).not.toContain('@@');
  });

  test('the patch size limit comes from the configuration', async () => {
    const store = createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() });
    const runs = createRunService({
      store,
      githubApp: fakeGitHub(),
      config: { ...DEBUG_IT_DEFAULTS, limits: { ...DEBUG_IT_DEFAULTS.limits, patchLimitBytes: 50 } },
      isolation: { status: () => ON },
      organization: 'acme',
      now: () => NOVEMBER,
    });
    const patch = CLEAN.padEnd(CLEAN.length + 1, '\n');
    const small = record(patch);
    expect(Buffer.byteLength(CLEAN)).toBeGreaterThan(50);
    expect(runs.resultView(small, DANA.uid).patchCheck?.rule).toBe('too-large');
    const generous = createRunService({
      store,
      githubApp: fakeGitHub(),
      config: { ...DEBUG_IT_DEFAULTS, limits: { ...DEBUG_IT_DEFAULTS.limits, patchLimitBytes: Buffer.byteLength(patch) } },
      isolation: { status: () => ON },
      organization: 'acme',
      now: () => NOVEMBER,
    });
    expect(generous.resultView(small, DANA.uid).patchCheck?.status).toBe('passed');
  });
});

describe('result and feedback answers: fix pull request offers (story 4.3)', () => {
  const ID = '00000000-0000-4000-8000-000000000043';
  const RESULT_PATH = `/debug-it/runs/${ID}/result`;
  const FEEDBACK_PATH = `/debug-it/runs/${ID}/feedback`;
  const EXTRA = 'acme/shared-lib';
  const HUNK = '@@ -1 +1 @@\n-old\n+new\n';
  const file = (path: string) => `--- a/${path}\n+++ b/${path}\n${HUNK}`;
  const BOTH = file('payments-api/src/db.ts') + file('shared-lib/index.ts');
  const WORKFLOW = file('payments-api/src/db.ts') + file('shared-lib/.github/workflows/ci.yml');
  const PR_URL = 'https://github.com/acme/payments-api/pull/17';
  const write = (uid: number) => (uid === DANA.uid ? 'write' : 'read');

  function record(overrides: Partial<RunRecord> = {}, patch = BOTH): RunRecord {
    return {
      runId: ID,
      target: { kind: 'job', id: JOB_ID },
      requester: { githubUserId: DANA.uid, login: DANA.login },
      state: 'finished',
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T10:04:00.000Z',
      repository: REPO,
      headRepository: REPO,
      headSha: SHA,
      branch: 'feature/refunds',
      jobName: 'test',
      downloads: [
        { repository: REPO, commitSha: SHA, folder: 'payments-api' },
        { repository: EXTRA, commitSha: SHA, folder: 'shared-lib' },
      ],
      usageKey: 'usage/2026-11/1000001.json',
      resultCodeHash: 'f'.repeat(64),
      result: {
        schemaVersion: 1,
        explanation: 'Why it failed.',
        causeLocation: { kind: 'this-repository' },
        patch,
        costUsd: 0.1,
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1000,
        logTruncated: false,
        failureReason: 'none',
      },
      feedback: null,
      fixPullRequests: [],
      failureReason: null,
      ...overrides,
    };
  }

  async function seeded(
    stored: RunRecord = record(),
    permission: (uid: number, repository: string) => RepositoryPermission = write,
  ) {
    const built = build({ github: fakeGitHub(permission), allowedRepositories: [REPO, EXTRA] });
    await built.store.create(`runs/${ID}.json`, stored);
    const realLoad = built.settings.load.bind(built.settings);
    const load = jest.spyOn(built.settings, 'load');
    return { ...built, load, realLoad };
  }

  // The chain's lookups pass options ({ fresh }); the offers' cached lookups pass none.
  const offerLookups = (github: ReturnType<typeof fakeGitHub>) =>
    github.checkPermission.mock.calls.filter((call) => (call as unknown[])[2] === undefined);

  // Reads the result once and checks that the offers did no lookup and no settings read.
  async function expectNoOfferLookup(built: Awaited<ReturnType<typeof seeded>>, user = DANA) {
    built.load.mockClear();
    built.github.checkPermission.mockClear();
    const res = await built.as(user).get(RESULT_PATH).expect(200);
    expect(res.body.canOpenPullRequest).toEqual([]);
    expect(offerLookups(built.github)).toHaveLength(0);
    // Only the check chain read the settings.
    expect(built.load).toHaveBeenCalledTimes(1);
    return res.body;
  }

  test('the requester with write access is offered every passed repository', async () => {
    const { as, github } = await seeded();
    const res = await as().get(RESULT_PATH).expect(200);
    expect(res.body.canOpenPullRequest).toEqual([REPO, EXTRA]);
    expect(res.body.fixPullRequests).toEqual([]);
    // Cached lookups are fine here; the click rechecks fresh.
    expect(github.checkPermission).toHaveBeenCalledWith({ githubUserId: DANA.uid, login: 'dana' }, EXTRA);
    expect(offerLookups(github)).toHaveLength(2);
  });

  test('another viewer is offered nothing but sees the opened links', async () => {
    const built = await seeded(record({ fixPullRequests: [{ repository: REPO, url: PR_URL }] }), () => 'write');
    const body = await expectNoOfferLookup(built, LEE);
    expect(body.fixPullRequests).toEqual([{ repository: REPO, url: PR_URL }]);
  });

  test('a read only requester is offered nothing', async () => {
    const { as } = await seeded(record(), () => 'read');
    expect((await as().get(RESULT_PATH).expect(200)).body.canOpenPullRequest).toEqual([]);
  });

  test('a repository removed from the allowed list is not offered', async () => {
    const { as, load, realLoad } = await seeded();
    let calls = 0;
    // The check chain reads the settings first; the offers read them again.
    load.mockImplementation(async () => {
      const current = await realLoad();
      calls += 1;
      return calls % 2 === 0 ? { ...current, allowedRepositories: [REPO] } : current;
    });
    expect((await as().get(RESULT_PATH).expect(200)).body.canOpenPullRequest).toEqual([REPO]);
  });

  test('settings that cannot be read for the offers: nothing offered, 200, one error line', async () => {
    const { as, load, realLoad } = await seeded();
    let calls = 0;
    load.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('settings down');
      return realLoad();
    });
    const res = await as().get(RESULT_PATH).expect(200);
    expect(res.body.canOpenPullRequest).toEqual([]);
    expect(error.mock.calls.filter((c) => String(c[0]).startsWith('[ERROR]'))).toHaveLength(1);
  });

  test('a fork run is offered nothing', async () => {
    await expectNoOfferLookup(await seeded(record({ headRepository: 'someone/payments-api' })));
    await expectNoOfferLookup(await seeded(record({ headRepository: null })));
  });

  test('a head repository spelled differently still counts as the same repository', async () => {
    const { as } = await seeded(record({ headRepository: 'ACME/Payments-API' }));
    expect((await as().get(RESULT_PATH).expect(200)).body.canOpenPullRequest).toEqual([REPO, EXTRA]);
  });

  test('a refused workflow-file part is not offered; the passed one is', async () => {
    const { as } = await seeded(record({}, WORKFLOW));
    const res = await as().get(RESULT_PATH).expect(200);
    expect(res.body.canOpenPullRequest).toEqual([REPO]);
    expect(res.body.patchCheck.repositories[1]).toMatchObject({
      repository: EXTRA,
      status: 'refused',
      rule: 'workflow-file',
      message: PATCH_RULE_MESSAGES['workflow-file'],
    });
  });

  test('an already opened repository is not offered, case-insensitive; its link is answered', async () => {
    const { as } = await seeded(
      record({
        fixPullRequests: [
          { repository: 'ACME/payments-api', url: PR_URL },
          { repository: EXTRA, url: 'javascript:alert(1)' },
          'junk',
        ],
      }),
    );
    const res = await as().get(RESULT_PATH).expect(200);
    expect(res.body.fixPullRequests).toEqual([{ repository: 'ACME/payments-api', url: PR_URL }]);
    expect(res.body.canOpenPullRequest).toEqual([EXTRA]);
  });

  test('a permission lookup error leaves that repository out, answers 200, logs one error line', async () => {
    const github = fakeGitHub(write);
    const { as, store } = build({ github, allowedRepositories: [REPO, EXTRA] });
    await store.create(`runs/${ID}.json`, record());
    // The chain's read lookups pass; the offer lookup of shared-lib fails.
    github.checkPermission.mockImplementation(async (user: { githubUserId: number }, repository: string, options?: unknown) => {
      if (repository === EXTRA && options === undefined) throw new GitHubAppError('GitHub answered 502 (repository permission).');
      return write(user.githubUserId);
    });
    const res = await as().get(RESULT_PATH).expect(200);
    expect(res.body.canOpenPullRequest).toEqual([REPO]);
    const lines = error.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[ERROR]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ID);
  });

  test('no result, an empty patch or an unreadable patch: nothing offered, no lookup for offers', async () => {
    const none = await expectNoOfferLookup(await seeded(record({ state: 'analyzing', result: null })));
    expect(none).toMatchObject({ canOpenPullRequest: [], fixPullRequests: [] });
    await expectNoOfferLookup(await seeded(record({}, '')));
    const body = await expectNoOfferLookup(
      await seeded(record({}, 'diff --git a/payments-api/x.png b/payments-api/x.png\nBinary files a/payments-api/x.png and b/payments-api/x.png differ\n')),
    );
    expect(body.patchCheck).toMatchObject({ status: 'refused', repositories: [] });
  });

  test('the feedback answer keeps the offers', async () => {
    const { as } = await seeded(record({ fixPullRequests: [{ repository: REPO, url: PR_URL }] }));
    const res = await as().put(FEEDBACK_PATH, { rating: 'useful' }).expect(200);
    expect(res.body.feedback).toMatchObject({ rating: 'useful' });
    expect(res.body.canOpenPullRequest).toEqual([EXTRA]);
    expect(res.body.fixPullRequests).toEqual([{ repository: REPO, url: PR_URL }]);
  });
});
