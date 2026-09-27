import request from 'supertest';
import { app } from '../src/app';
import { RUNNERS_TTL_SECONDS } from '../src/services/cache';

process.env.USE_MOCK_DATA = 'true';
process.env.GITHUB_ORGANIZATION = 'test-org';
delete process.env.GITHUB_TOKEN;

describe('GET /runners', () => {
  test('returns readable scale-set names, not the raw "scaleset:N" label', async () => {
    const response = await request(app).get('/runners').expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (const runner of response.body) {
      expect(runner.scaleSet).not.toBeNull();
      expect(runner.scaleSet.name).not.toMatch(/^scaleset:/);
    }

    const names = response.body.map((r: any) => r.scaleSet.name);
    expect(names).toContain('arc-linux-x64');
    expect(names).toContain('arc-gpu-a10');
    expect(names).toContain('arc-linux-arm64');
  });

  test('keeps availability totals on every runner', async () => {
    const response = await request(app).get('/runners').expect(200);
    const [first] = response.body;

    expect(first.availability).toEqual(
      expect.objectContaining({
        total: expect.any(Number),
        online: expect.any(Number),
        offline: expect.any(Number),
        busy: expect.any(Number),
        free: expect.any(Number),
      })
    );
  });

  test('scaleSet filter narrows the results to that scale set only', async () => {
    const response = await request(app).get('/runners').query({ scaleSet: 'arc-gpu-a10' }).expect(200);

    expect(response.body.length).toBe(4);
    for (const runner of response.body) {
      expect(runner.scaleSet.id).toBe('arc-gpu-a10');
    }
  });

  test('unknown scaleSet filter returns an empty list, not an error', async () => {
    const response = await request(app).get('/runners').query({ scaleSet: 'does-not-exist' }).expect(200);
    expect(response.body).toEqual([]);
  });
});

describe('GET /scale-sets', () => {
  test('lists every scale set with total/online/busy/free counts', async () => {
    const response = await request(app).get('/scale-sets').expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'arc-linux-x64', totalRunners: 6, online: 5, busy: 2, free: 3 }),
        expect.objectContaining({ id: 'arc-gpu-a10', totalRunners: 4, online: 3, busy: 3, free: 0 }),
        expect.objectContaining({ id: 'arc-linux-arm64', totalRunners: 4, online: 3, busy: 1, free: 2 }),
        expect.objectContaining({ id: 'arc-windows-x64', totalRunners: 2, online: 0, busy: 0, free: 0 }),
      ])
    );
  });

  test('scaleSet filter returns just that one entry', async () => {
    const response = await request(app).get('/scale-sets').query({ scaleSet: 'arc-linux-arm64' }).expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).toBe('arc-linux-arm64');
  });
});

describe('GET /jobs/queue', () => {
  test('returns an envelope that says the ordering is an estimate', async () => {
    const response = await request(app).get('/jobs/queue').expect(200);

    expect(response.body.orderingIsEstimate).toBe(true);
    expect(typeof response.body.note).toBe('string');
    expect(response.body.note.length).toBeGreaterThan(0);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  test('only ever contains jobs that are actually waiting, never running or finished ones', async () => {
    const response = await request(app).get('/jobs/queue').expect(200);

    expect(response.body.items.length).toBe(5);
    for (const job of response.body.items) {
      expect(job.repository).toMatch(/^acme\//);
      expect(job.repositoryUrl).toBe(`https://github.com/${job.repository}`);
      expect(job.htmlUrl).toMatch(/^https:\/\/github\.com\//);
      expect(job.runUrl).toMatch(/^https:\/\/github\.com\//);
      expect(job.status).toBeUndefined();
      expect(job.runnerName).toBeUndefined();
    }
  });

  test('carries enough to tell two identical-looking jobs apart: branch, who triggered it, and the run link', async () => {
    const response = await request(app).get('/jobs/queue').expect(200);

    for (const job of response.body.items) {
      expect(typeof job.branch).toBe('string');
      expect(job.actor).toEqual(
        expect.objectContaining({ login: expect.any(String), avatarUrl: expect.any(String) })
      );
      expect(typeof job.event).toBe('string');
      expect(job.runUrl).toMatch(/^https:\/\/github\.com\//);
      expect(job.runUrl).not.toBe(job.htmlUrl);
    }
  });

  test('two jobs on the same repo and scale set are distinguishable by branch and actor', async () => {
    const response = await request(app).get('/jobs/queue').query({ scaleSet: 'arc-gpu-a10' }).expect(200);
    const sameRepoJobs = response.body.items.filter((i: any) => i.repository === 'acme/web-app');

    expect(sameRepoJobs.length).toBe(2);
    const [a, b] = sameRepoJobs;
    expect(a.branch).not.toBe(b.branch);
    expect(a.actor.login).not.toBe(b.actor.login);
  });

  test('gives every waiting job a 1-based position, ranked oldest-first within its own scale set', async () => {
    const response = await request(app).get('/jobs/queue').query({ scaleSet: 'arc-gpu-a10' }).expect(200);
    const items = response.body.items;

    expect(items.length).toBe(4);
    expect(items.map((i: any) => i.position)).toEqual([1, 2, 3, 4]);

    const waitTimes = items.map((i: any) => i.waitMs);
    expect(waitTimes[0]).toBeGreaterThan(waitTimes[1]);
    expect(waitTimes[1]).toBeGreaterThan(waitTimes[2]);
    expect(waitTimes[2]).toBeGreaterThan(waitTimes[3]);

    for (const job of items) {
      expect(job.scaleSet).toBe('arc-gpu-a10');
    }
  });

  test('a job with no resolvable scale set still gets a position, in its own group', async () => {
    const response = await request(app).get('/jobs/queue').expect(200);
    const unassigned = response.body.items.find((i: any) => i.scaleSet === null);

    expect(unassigned).toBeDefined();
    expect(unassigned.position).toBe(1);
  });

  test('scaleSet filter narrows the queue to that scale set', async () => {
    const response = await request(app).get('/jobs/queue').query({ scaleSet: 'arc-linux-x64' }).expect(200);
    expect(response.body.items).toEqual([]);
  });
});

describe('GET /jobs/running', () => {
  test('returns an envelope that says the ordering is an estimate', async () => {
    const response = await request(app).get('/jobs/running').expect(200);

    expect(response.body.orderingIsEstimate).toBe(true);
    expect(typeof response.body.note).toBe('string');
    expect(response.body.note.length).toBeGreaterThan(0);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  test('returns only jobs that are on a runner right now, with branch/actor/event/run link', async () => {
    const response = await request(app).get('/jobs/running').expect(200);
    const items = response.body.items;

    expect(items.length).toBe(6);
    for (const job of items) {
      expect(job.runnerName).toEqual(expect.any(String));
      expect(job.repository).toMatch(/^acme\//);
      expect(job.repositoryUrl).toBe(`https://github.com/${job.repository}`);
      expect(job.htmlUrl).toMatch(/^https:\/\/github\.com\//);
      expect(job.runUrl).toMatch(/^https:\/\/github\.com\//);
      expect(job.runningMs).toEqual(expect.any(Number));
      expect(job.runningMs).toBeGreaterThan(0);
      expect(typeof job.branch).toBe('string');
      expect(job.actor).toEqual(
        expect.objectContaining({ login: expect.any(String), avatarUrl: expect.any(String) })
      );
      expect(typeof job.event).toBe('string');
    }
  });

  test('orders running jobs earliest-started first (longest elapsed runningMs first)', async () => {
    const response = await request(app).get('/jobs/running').expect(200);
    const runningMsValues = response.body.items.map((i: any) => i.runningMs);

    for (let i = 1; i < runningMsValues.length; i++) {
      expect(runningMsValues[i - 1]).toBeGreaterThanOrEqual(runningMsValues[i]);
    }
  });

  test('scaleSet filter narrows to jobs running on that scale set', async () => {
    const response = await request(app).get('/jobs/running').query({ scaleSet: 'arc-gpu-a10' }).expect(200);
    expect(response.body.items.length).toBe(3);
    for (const job of response.body.items) {
      expect(job.scaleSet).toBe('arc-gpu-a10');
    }
  });
});

describe('GET /jobs/history', () => {
  test('returns finished jobs with a result, duration, repo and GitHub link', async () => {
    const response = await request(app).get('/jobs/history').expect(200);

    expect(response.body.length).toBe(11);
    for (const job of response.body) {
      expect(['success', 'failure', 'cancelled', 'timed_out', 'other']).toContain(job.result);
      expect(job.repository).toMatch(/^acme\//);
      expect(job.repositoryUrl).toBe(`https://github.com/${job.repository}`);
      expect(job.htmlUrl).toMatch(/^https:\/\/github\.com\//);
      expect(job.runUrl).toMatch(/^https:\/\/github\.com\//);
      expect(typeof job.branch).toBe('string');
      expect(job.actor).toEqual(
        expect.objectContaining({ login: expect.any(String), avatarUrl: expect.any(String) })
      );
      expect(typeof job.event).toBe('string');
    }
  });

  test('limit query param caps the number of rows returned', async () => {
    const response = await request(app).get('/jobs/history').query({ limit: 3 }).expect(200);
    expect(response.body.length).toBe(3);
  });

  test('surfaces failure, cancelled and timed_out results distinctly', async () => {
    const response = await request(app).get('/jobs/history').expect(200);
    const byId = (id: number) => response.body.find((j: any) => j.id === id);

    expect(byId(900012).result).toBe('failure');
    expect(byId(900014).result).toBe('cancelled');
    expect(byId(900019).result).toBe('timed_out');
  });

  test('scaleSet filter narrows history to that scale set', async () => {
    const response = await request(app).get('/jobs/history').query({ scaleSet: 'arc-linux-arm64' }).expect(200);
    expect(response.body.length).toBeGreaterThan(0);
    for (const job of response.body) {
      expect(job.scaleSet).toBe('arc-linux-arm64');
    }
  });
});

describe('No logs route', () => {
  test('the dropped /jobs/:jobId/logs route no longer exists', async () => {
    await request(app).get('/jobs/900010/logs').expect(404);
  });
});

describe('GET /settings', () => {
  test('hands the page the runner cache TTL so the header can state it', async () => {
    const response = await request(app).get('/settings').expect(200);

    expect(response.body).toEqual({ runnersRefreshSeconds: RUNNERS_TTL_SECONDS });
    expect(response.body.runnersRefreshSeconds).toBeGreaterThan(0);
  });

  test('needs no GitHub token', async () => {
    const token = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      await request(app).get('/settings').expect(200);
    } finally {
      if (token !== undefined) process.env.GITHUB_TOKEN = token;
    }
  });
});
