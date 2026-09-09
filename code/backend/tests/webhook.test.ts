import crypto from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app';
import { buildSnapshot, clearJobStore, serialize, restore, stats } from '../src/services/jobStore';
import { clearDeliveryDedupe } from '../src/routes/githubWebhook';

const SECRET = 'a-test-secret-not-a-real-one';
const POOLS = ['arc-linux-x64'];

const previousEnv = {
  secret: process.env.GITHUB_WEBHOOK_SECRET,
  useMock: process.env.USE_MOCK_DATA,
  token: process.env.GITHUB_TOKEN,
};

beforeEach(() => {
  clearJobStore();
  clearDeliveryDedupe();
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.USE_MOCK_DATA = 'false';
  delete process.env.GITHUB_TOKEN;
});

afterAll(() => {
  if (previousEnv.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = previousEnv.secret;
  process.env.USE_MOCK_DATA = previousEnv.useMock ?? 'true';
  if (previousEnv.token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousEnv.token;
});

function sign(body: string, secret = SECRET): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

let deliveryCounter = 0;

interface JobOptions {
  id?: number;
  runId?: number;
  runnerName?: string | null;
  steps?: unknown[];
}

function payload(action: string, options: JobOptions = {}) {
  const id = options.id ?? 900001;
  const runId = options.runId ?? 700001;
  return {
    action,
    workflow_job: {
      id,
      run_id: runId,
      run_attempt: 1,
      name: 'build',
      status: action === 'queued' ? 'queued' : action,
      conclusion: action === 'completed' ? 'success' : null,
      created_at: new Date().toISOString(),
      started_at: action === 'queued' ? null : new Date().toISOString(),
      completed_at: action === 'completed' ? new Date().toISOString() : null,
      html_url: `https://github.com/acme/platform/actions/runs/${runId}/job/${id}`,
      run_url: `https://api.github.com/repos/acme/platform/actions/runs/${runId}`,
      labels: ['arc-linux-x64'],
      runner_name: options.runnerName ?? (action === 'queued' ? null : 'arc-linux-x64-9f2c1'),
      steps: options.steps ?? [],
      workflow_name: 'CI',
      head_branch: 'main',
    },
    repository: {
      full_name: 'acme/platform',
      name: 'platform',
      html_url: 'https://github.com/acme/platform',
      owner: { login: 'acme' },
    },
    sender: { login: 'someone', avatar_url: 'https://example.invalid/a.png' },
  };
}

function deliver(body: unknown, overrides: { signature?: string; event?: string; delivery?: string } = {}) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', overrides.event ?? 'workflow_job')
    .set('X-GitHub-Delivery', overrides.delivery ?? `delivery-${++deliveryCounter}`)
    .set('X-Hub-Signature-256', overrides.signature ?? sign(raw))
    .send(raw);
}

describe('Only GitHub gets in', () => {
  test('a message with no signature is refused', async () => {
    const raw = JSON.stringify(payload('queued'));
    await request(app)
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'workflow_job')
      .send(raw)
      .expect(401);

    expect(stats().total).toBe(0);
  });

  test('a message signed with the wrong secret is refused', async () => {
    const body = payload('queued');
    await deliver(body, { signature: sign(JSON.stringify(body), 'the-wrong-secret') }).expect(401);
    expect(stats().total).toBe(0);
  });

  test('a signature of the right length but wrong content is refused', async () => {
    const fake = `sha256=${'0'.repeat(64)}`;
    await deliver(payload('queued'), { signature: fake }).expect(401);
    expect(stats().total).toBe(0);
  });

  test('with no secret configured the route refuses everything rather than trusting the caller', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    await deliver(payload('queued')).expect(500);
    expect(stats().total).toBe(0);
  });

  test('a correctly signed message is accepted', async () => {
    await deliver(payload('queued')).expect(200);
    expect(stats().queued).toBe(1);
  });
});

describe('Which messages are acted on', () => {
  test('the setup ping is answered 200 so the webhook shows as working', async () => {
    await deliver({ zen: 'Anything added dilutes everything else.' }, { event: 'ping' }).expect(200);
    expect(stats().total).toBe(0);
  });

  test('an event we did not ask for is ignored, not rejected', async () => {
    const response = await deliver(payload('queued'), { event: 'push' }).expect(200);
    expect(response.body.ignored).toBe('push');
    expect(stats().total).toBe(0);
  });

  test('a repeat of the same delivery is answered 200 and applied once', async () => {
    await deliver(payload('completed'), { delivery: 'repeat-me' }).expect(200);
    const second = await deliver(payload('queued'), { delivery: 'repeat-me' }).expect(200);

    expect(second.body.duplicate).toBe(true);
    expect(stats().finished).toBe(1);
    expect(stats().queued).toBe(0);
  });

  test('a job blocked on an approval is stored but shown nowhere', async () => {
    await deliver(payload('waiting')).expect(200);

    const snapshot = buildSnapshot(POOLS);
    expect(snapshot.queue).toEqual([]);
    expect(snapshot.running).toEqual([]);
    expect(snapshot.history).toEqual([]);
  });
});

describe('Messages that arrive out of order', () => {
  test('a job moves queued to running to finished', async () => {
    await deliver(payload('queued')).expect(200);
    expect(buildSnapshot(POOLS).queue).toHaveLength(1);

    await deliver(payload('in_progress')).expect(200);
    expect(buildSnapshot(POOLS).queue).toHaveLength(0);
    expect(buildSnapshot(POOLS).running).toHaveLength(1);

    await deliver(payload('completed')).expect(200);
    expect(buildSnapshot(POOLS).running).toHaveLength(0);
    expect(buildSnapshot(POOLS).history).toHaveLength(1);
  });

  test('a late "queued" arriving after "completed" does not put the job back in the queue', async () => {
    await deliver(payload('completed')).expect(200);
    const late = await deliver(payload('queued')).expect(200);

    expect(late.body.applied).toBe(false);
    expect(buildSnapshot(POOLS).queue).toEqual([]);
    expect(buildSnapshot(POOLS).history).toHaveLength(1);
  });

  test('a re-run is a new row, not an overwrite of the original', async () => {
    await deliver(payload('completed', { id: 900001 })).expect(200);
    await deliver(payload('completed', { id: 900002 })).expect(200);

    expect(buildSnapshot(POOLS).history).toHaveLength(2);
  });
});

describe('The size of a real message', () => {
  test('a finished job carrying a long step list is accepted', async () => {
    const steps = Array.from({ length: 600 }, (_, i) => ({
      name: `step ${i} with a fairly long name so the body grows past the old default limit`,
      status: 'completed',
      conclusion: 'success',
      number: i + 1,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }));

    const body = payload('completed', { steps });
    expect(JSON.stringify(body).length).toBeGreaterThan(100 * 1024);

    await deliver(body).expect(200);
    expect(stats().finished).toBe(1);
  });
});

describe('Which pool a row is shown under', () => {
  test('a job on one of our runners lands in that pool', async () => {
    await deliver(payload('in_progress', { runnerName: 'arc-linux-x64-9f2c1' })).expect(200);
    expect(buildSnapshot(POOLS).running[0]?.scaleSet).toBe('arc-linux-x64');
  });

  test("a job on GitHub's own runners is left unassigned rather than given a pool of its own", async () => {
    await deliver(payload('in_progress', { runnerName: 'GitHub Actions 2' })).expect(200);

    const row = buildSnapshot(POOLS).running[0];
    expect(row).toBeDefined();
    expect(row?.scaleSet).toBeNull();
  });
});

describe('Surviving a restart', () => {
  test('what was saved comes back, and the page stops warning', async () => {
    await deliver(payload('queued', { id: 900001 })).expect(200);
    await deliver(payload('completed', { id: 900002 })).expect(200);

    const saved = JSON.parse(JSON.stringify(serialize()));

    clearJobStore();
    expect(buildSnapshot(POOLS).incomplete).toBe(true);

    expect(restore(saved)).toBe(2);

    const snapshot = buildSnapshot(POOLS);
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.incomplete).toBe(false);
  });

  test('an unreadable saved file costs the history, not the service', () => {
    clearJobStore();
    expect(restore({ nonsense: true })).toBe(0);
    expect(restore(null)).toBe(0);
    expect(buildSnapshot(POOLS).incomplete).toBe(true);
  });

  test('a message that arrived during the restore is not overwritten by the older saved copy', async () => {
    await deliver(payload('completed', { id: 900001 })).expect(200);

    const stale = {
      version: 1,
      savedAt: new Date().toISOString(),
      jobs: [{ ...serialize().jobs[0], rank: 1 }],
    };

    restore(stale);

    expect(buildSnapshot(POOLS).history).toHaveLength(1);
    expect(buildSnapshot(POOLS).queue).toEqual([]);
  });
});
