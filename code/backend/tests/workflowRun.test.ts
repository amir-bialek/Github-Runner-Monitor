jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

import crypto from 'node:crypto';
import request from 'supertest';
import axios from 'axios';
import { app } from '../src/app';
import { clearAllCache } from '../src/services/cache';
import { buildSnapshot, clearJobStore, restore, serialize } from '../src/services/jobStore';
import { clearDeliveryDedupe, settleWorkflowRunChecks } from '../src/routes/githubWebhook';
import { clearRunContextStore } from '../src/services/runContextStore';

const mockGet = axios.get as unknown as jest.Mock;

const SECRET = 'a-test-secret-not-a-real-one';
const FAKE_TOKEN = 'ghp_thisisnotarealtokenitisatestfixture';
const POOLS = ['arc-linux-x64'];
const RUN_ID = 810001;

const previousEnv = {
  secret: process.env.GITHUB_WEBHOOK_SECRET,
  useMock: process.env.USE_MOCK_DATA,
  token: process.env.GITHUB_TOKEN,
  org: process.env.GITHUB_ORGANIZATION,
};

beforeEach(() => {
  mockGet.mockReset();
  clearAllCache();
  clearJobStore();
  clearDeliveryDedupe();
  clearRunContextStore();
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.USE_MOCK_DATA = 'false';
  process.env.GITHUB_ORGANIZATION = 'acme';
  delete process.env.GITHUB_TOKEN;
});

afterEach(async () => {
  await settleWorkflowRunChecks();
});

afterAll(() => {
  if (previousEnv.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = previousEnv.secret;
  process.env.USE_MOCK_DATA = previousEnv.useMock ?? 'true';
  if (previousEnv.token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousEnv.token;
  process.env.GITHUB_ORGANIZATION = previousEnv.org ?? 'test-org';
});

function sign(body: string, secret = SECRET): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

let deliveryCounter = 0;

function deliver(body: unknown, event: string, overrides: { signature?: string } = {}) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', `run-delivery-${++deliveryCounter}`)
    .set('X-Hub-Signature-256', overrides.signature ?? sign(raw))
    .send(raw);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
const CREATED_AT = minutesAgo(10);
const STARTED_AT = minutesAgo(9);
const UPDATED_AT = minutesAgo(8);

function runPayload(conclusion: string | null, action = 'completed', runId = RUN_ID) {
  return {
    action,
    workflow_run: {
      id: runId,
      run_attempt: 1,
      name: 'Deploy',
      head_branch: 'main',
      head_sha: 'abc123def456',
      html_url: `https://github.com/acme/payments-api/actions/runs/${runId}`,
      created_at: CREATED_AT,
      run_started_at: STARTED_AT,
      updated_at: UPDATED_AT,
      status: 'completed',
      conclusion,
      event: 'push',
      head_repository: { full_name: 'acme/payments-api' },
      actor: { login: 'pusher', avatar_url: 'https://example.invalid/p.png' },
      triggering_actor: { login: 'rerunner', avatar_url: 'https://example.invalid/r.png' },
    },
    repository: { full_name: 'acme/payments-api' },
    sender: { login: 'sender', avatar_url: 'https://example.invalid/s.png' },
  };
}

function jobPayload(id: number, runId: number) {
  const now = new Date().toISOString();
  return {
    action: 'completed',
    workflow_job: {
      id,
      run_id: runId,
      run_attempt: 1,
      name: 'build',
      status: 'completed',
      conclusion: 'failure',
      created_at: now,
      started_at: now,
      completed_at: now,
      html_url: `https://github.com/acme/payments-api/actions/runs/${runId}/job/${id}`,
      run_url: `https://api.github.com/repos/acme/payments-api/actions/runs/${runId}`,
      labels: ['arc-linux-x64'],
      runner_name: 'arc-linux-x64-9f2c1',
      steps: [],
      workflow_name: 'CI',
      head_branch: 'main',
    },
    repository: {
      full_name: 'acme/payments-api',
      name: 'payments-api',
      html_url: 'https://github.com/acme/payments-api',
      owner: { login: 'acme' },
    },
    sender: { login: 'someone', avatar_url: 'https://example.invalid/a.png' },
  };
}

function runRows() {
  return buildSnapshot(POOLS).history.filter(item => item.target.kind === 'run');
}

function jobsApiAnswer(totalCount: number) {
  return {
    status: 200,
    data: {
      total_count: totalCount,
      jobs: Array.from({ length: totalCount }, (_, i) => ({ id: 1 + i, run_id: RUN_ID })),
    },
    headers: {},
  };
}

describe('A failed run without jobs is kept', () => {
  test('startup failure without a token gives one run row', async () => {
    const response = await deliver(runPayload('startup_failure'), 'workflow_run').expect(200);
    expect(response.body).toEqual({ ok: true, applied: true });

    const rows = runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: RUN_ID,
      name: 'Deploy',
      workflowName: 'Deploy',
      branch: 'main',
      actor: { login: 'rerunner', avatarUrl: 'https://example.invalid/r.png' },
      event: 'push',
      repository: 'acme/payments-api',
      repositoryUrl: 'https://github.com/acme/payments-api',
      result: 'failure',
      runnerName: null,
      scaleSet: null,
      createdAt: CREATED_AT,
      startedAt: STARTED_AT,
      completedAt: UPDATED_AT,
      durationMs: null,
      htmlUrl: `https://github.com/acme/payments-api/actions/runs/${RUN_ID}`,
      runUrl: `https://github.com/acme/payments-api/actions/runs/${RUN_ID}`,
      target: { kind: 'run', id: RUN_ID },
    });
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('a plain failure is kept too', async () => {
    await deliver(runPayload('failure'), 'workflow_run').expect(200);
    expect(runRows()).toHaveLength(1);
  });

  test('actor falls back to actor, then sender', async () => {
    const body = runPayload('failure');
    delete (body.workflow_run as Record<string, unknown>).triggering_actor;
    await deliver(body, 'workflow_run').expect(200);
    expect(runRows()[0]!.actor?.login).toBe('pusher');

    clearJobStore();
    const bare = runPayload('failure', 'completed', RUN_ID + 1);
    delete (bare.workflow_run as Record<string, unknown>).triggering_actor;
    delete (bare.workflow_run as Record<string, unknown>).actor;
    await deliver(bare, 'workflow_run').expect(200);
    expect(runRows()[0]!.actor?.login).toBe('sender');
  });

  test('a run whose jobs are already stored is ignored', async () => {
    await deliver(jobPayload(920001, RUN_ID), 'workflow_job').expect(200);

    const response = await deliver(runPayload('failure'), 'workflow_run').expect(200);
    expect(response.body).toEqual({ ok: true, applied: false });
    expect(runRows()).toHaveLength(0);
  });

  test.each(['success', 'cancelled', 'skipped', null])('conclusion %s is not stored', async conclusion => {
    const response = await deliver(runPayload(conclusion), 'workflow_run').expect(200);
    expect(response.body).toEqual({ ok: true, applied: false });
    expect(runRows()).toHaveLength(0);
  });

  test.each(['requested', 'in_progress'])('action %s is not stored', async action => {
    const response = await deliver(runPayload('failure', action), 'workflow_run').expect(200);
    expect(response.body).toEqual({ ok: true, applied: false });
    expect(runRows()).toHaveLength(0);
  });

  test('a bad signature is refused and nothing is stored', async () => {
    const body = runPayload('startup_failure');
    await deliver(body, 'workflow_run', { signature: sign(JSON.stringify(body), 'the-wrong-secret') }).expect(401);
    expect(runRows()).toHaveLength(0);
  });

  test('a repeated delivery is applied once', async () => {
    const raw = JSON.stringify(runPayload('startup_failure'));
    const send = () =>
      request(app)
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'same-run-delivery')
        .set('X-Hub-Signature-256', sign(raw))
        .send(raw);

    await send().expect(200);
    const second = await send().expect(200);
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(runRows()).toHaveLength(1);
  });

  test('an older attempt never replaces a newer one', async () => {
    const newer = runPayload('failure');
    newer.workflow_run.run_attempt = 2;
    newer.workflow_run.updated_at = minutesAgo(1);
    newer.workflow_run.triggering_actor = { login: 'second-try', avatar_url: 'https://example.invalid/2.png' };
    await deliver(newer, 'workflow_run').expect(200);

    const older = runPayload('failure');
    older.workflow_run.run_attempt = 1;
    older.workflow_run.updated_at = minutesAgo(30);
    older.workflow_run.triggering_actor = { login: 'first-try', avatar_url: 'https://example.invalid/1.png' };
    const response = await deliver(older, 'workflow_run').expect(200);
    expect(response.body).toEqual({ ok: true, applied: false });

    const rows = runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor?.login).toBe('second-try');
    expect(rows[0]!.completedAt).toBe(newer.workflow_run.updated_at);
    expect(JSON.parse(JSON.stringify(serialize())).runs[0].runAttempt).toBe(2);
  });

  test('a job event after the run row removes the run row', async () => {
    await deliver(runPayload('failure'), 'workflow_run').expect(200);
    expect(runRows()).toHaveLength(1);

    await deliver(jobPayload(920002, RUN_ID), 'workflow_job').expect(200);

    const history = buildSnapshot(POOLS).history;
    expect(history.filter(item => item.target.kind === 'run')).toHaveLength(0);
    expect(history).toHaveLength(1);
    expect(history[0]!.target).toEqual({ kind: 'job', id: 920002 });
  });
});

describe('With a token, the jobs API decides', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = FAKE_TOKEN;
  });

  test('jobs exist: nothing is stored', async () => {
    mockGet.mockResolvedValue(jobsApiAnswer(2));

    const response = await deliver(runPayload('failure'), 'workflow_run').expect(200);
    expect(response.body.applied).toBe(false);
    await settleWorkflowRunChecks();

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining(`/repos/acme/payments-api/actions/runs/${RUN_ID}/jobs`),
      expect.anything()
    );
    expect(runRows()).toHaveLength(0);
  });

  test('no jobs: the row is stored', async () => {
    mockGet.mockResolvedValue(jobsApiAnswer(0));

    const response = await deliver(runPayload('startup_failure'), 'workflow_run').expect(200);
    expect(response.body).toEqual({ ok: true, applied: false, checking: true });
    await settleWorkflowRunChecks();

    expect(runRows()).toHaveLength(1);
  });

  test('the API fails: the row is stored and one warning is logged', async () => {
    mockGet.mockRejectedValue({
      response: { status: 404, headers: {} },
      message: 'Request failed with status code 404',
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await deliver(runPayload('startup_failure'), 'workflow_run').expect(200);
      await settleWorkflowRunChecks();

      expect(runRows()).toHaveLength(1);
      const lines = warn.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('[WARN]'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(String(RUN_ID));
      expect(lines[0]).toContain('acme/payments-api');
      expect(lines[0]).not.toContain(FAKE_TOKEN);
      expect(lines[0]).not.toContain('404');
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('a job event during the lookup wins over the run row', async () => {
    let answer: (value: unknown) => void = () => {};
    mockGet.mockReturnValue(new Promise(resolve => (answer = resolve)));

    await deliver(runPayload('failure'), 'workflow_run').expect(200);
    await deliver(jobPayload(920003, RUN_ID), 'workflow_job').expect(200);
    answer(jobsApiAnswer(0));
    await settleWorkflowRunChecks();

    expect(runRows()).toHaveLength(0);
  });
});

describe('Run rows survive a restart', () => {
  test('serialize then restore brings the run row back', async () => {
    await deliver(runPayload('startup_failure'), 'workflow_run').expect(200);
    const saved = JSON.parse(JSON.stringify(serialize()));
    expect(saved.version).toBe(1);
    expect(saved.runs).toHaveLength(1);

    clearJobStore();
    restore(saved);

    const rows = runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toEqual({ kind: 'run', id: RUN_ID });
    expect(buildSnapshot(POOLS).incomplete).toBe(false);
  });

  test('a snapshot with only run rows still counts as restored', () => {
    restore({
      version: 1,
      savedAt: new Date().toISOString(),
      jobs: [],
      runs: [
        {
          id: RUN_ID,
          runAttempt: 1,
          name: 'Deploy',
          headBranch: 'main',
          headSha: 'abc',
          htmlUrl: 'https://github.com/acme/payments-api/actions/runs/810001',
          createdAt: new Date().toISOString(),
          runStartedAt: null,
          updatedAt: new Date().toISOString(),
          conclusion: 'startup_failure',
          event: 'push',
          repository: 'acme/payments-api',
          headRepository: 'acme/payments-api',
          actor: null,
        },
      ],
    });
    expect(runRows()).toHaveLength(1);
    expect(buildSnapshot(POOLS).incomplete).toBe(false);
  });

  test('a snapshot without runs restores like 1.x', async () => {
    await deliver(jobPayload(920004, RUN_ID), 'workflow_job').expect(200);
    const oldShape = JSON.parse(JSON.stringify(serialize()));
    expect(Object.keys(oldShape).sort()).toEqual(['jobs', 'savedAt', 'version']);

    clearJobStore();
    expect(restore(oldShape)).toBe(1);
    const history = buildSnapshot(POOLS).history;
    expect(history).toHaveLength(1);
    expect(history[0]!.target).toEqual({ kind: 'job', id: 920004 });
  });

  test('a restored run row never overwrites one that arrived during the restore', async () => {
    await deliver(runPayload('startup_failure'), 'workflow_run').expect(200);
    const saved = JSON.parse(JSON.stringify(serialize()));
    saved.runs[0].name = 'Old name';

    restore(saved);
    expect(runRows()[0]!.name).toBe('Deploy');
  });

  test('a restored job row for a live run row removes the run row', async () => {
    await deliver(runPayload('failure'), 'workflow_run').expect(200);
    await deliver(jobPayload(920006, RUN_ID), 'workflow_job').expect(200);
    const saved = JSON.parse(JSON.stringify(serialize()));

    clearJobStore();
    await deliver(runPayload('failure'), 'workflow_run').expect(200);
    expect(runRows()).toHaveLength(1);

    restore(saved);
    expect(runRows()).toHaveLength(0);
    expect(buildSnapshot(POOLS).history.map(item => item.target)).toEqual([{ kind: 'job', id: 920006 }]);
  });

  test('a restored run row is not added when a live job row exists for that run', async () => {
    await deliver(runPayload('startup_failure'), 'workflow_run').expect(200);
    const saved = JSON.parse(JSON.stringify(serialize()));
    expect(saved.runs).toHaveLength(1);

    clearJobStore();
    await deliver(jobPayload(920007, RUN_ID), 'workflow_job').expect(200);

    restore(saved);
    expect(runRows()).toHaveLength(0);
  });

  test('run rows are capped at JOB_STORE_MAX_JOBS, keeping the newest', () => {
    const previous = process.env.JOB_STORE_MAX_JOBS;
    process.env.JOB_STORE_MAX_JOBS = '2';
    try {
      jest.isolateModules(() => {
        const store = require('../src/services/jobStore') as typeof import('../src/services/jobStore');
        const at = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
        const row = (id: number, minutes: number) => ({
          id,
          runAttempt: 1,
          name: 'Deploy',
          headBranch: 'main',
          headSha: 'abc',
          htmlUrl: `https://github.com/acme/payments-api/actions/runs/${id}`,
          createdAt: at(minutes),
          runStartedAt: null,
          updatedAt: at(minutes),
          conclusion: 'failure',
          event: 'push',
          repository: 'acme/payments-api',
          headRepository: null,
          actor: null,
        });
        store.restore({
          version: 1,
          savedAt: new Date().toISOString(),
          jobs: [],
          runs: [row(1, 30), row(2, 20), row(3, 10)],
        });
        const ids = store.buildSnapshot(POOLS).history.map(item => item.target.id).sort();
        expect(ids).toEqual([2, 3]);
      });
    } finally {
      if (previous === undefined) delete process.env.JOB_STORE_MAX_JOBS;
      else process.env.JOB_STORE_MAX_JOBS = previous;
    }
  });

  test('old run rows are pruned by age', () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    restore({
      version: 1,
      savedAt: new Date().toISOString(),
      jobs: [],
      runs: [
        {
          id: RUN_ID,
          runAttempt: 1,
          name: 'Deploy',
          headBranch: 'main',
          headSha: 'abc',
          htmlUrl: 'https://github.com/acme/payments-api/actions/runs/810001',
          createdAt: old,
          runStartedAt: null,
          updatedAt: old,
          conclusion: 'failure',
          event: 'push',
          repository: 'acme/payments-api',
          headRepository: null,
          actor: null,
        },
      ],
    });
    expect(runRows()).toHaveLength(0);
  });
});

describe('The history API shows both kinds', () => {
  const runnersResponse = {
    status: 200,
    data: {
      total_count: 1,
      runners: [{ id: 1, name: 'arc-linux-x64-9f2c1', os: 'linux', status: 'online', busy: false, labels: [] }],
    },
    headers: {},
  };

  test('job and run rows carry target, sort by finish time, and follow the scale set filter', async () => {
    await deliver(runPayload('startup_failure'), 'workflow_run').expect(200);
    await deliver(jobPayload(920005, 810099), 'workflow_job').expect(200);

    process.env.GITHUB_TOKEN = FAKE_TOKEN;
    mockGet.mockResolvedValue(runnersResponse);

    const all = await request(app).get('/jobs/history').expect(200);
    expect(all.body).toHaveLength(2);
    expect(all.body[0].target).toEqual({ kind: 'job', id: 920005 });
    expect(all.body[1].target).toEqual({ kind: 'run', id: RUN_ID });

    const filtered = await request(app).get('/jobs/history?scaleSet=arc-linux-x64').expect(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].target).toEqual({ kind: 'job', id: 920005 });
  });
});
