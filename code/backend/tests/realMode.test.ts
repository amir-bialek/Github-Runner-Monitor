jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

import request from 'supertest';
import axios from 'axios';
import { app } from '../src/app';
import { clearAllCache } from '../src/services/cache';
import { clearJobStore, restore } from '../src/services/jobStore';

const mockGet = axios.get as unknown as jest.Mock;

const WELL_FORMED_FAKE_TOKEN = 'ghp_thisisnotarealtokenitisatestfixture';

const ALL_ROUTES = ['/runners', '/scale-sets', '/jobs/queue', '/jobs/running', '/jobs/history'];

function storedQueuedJob() {
  return {
    job: {
      id: 900001,
      run_id: 700001,
      run_attempt: 1,
      name: 'build',
      status: 'queued',
      conclusion: null,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      html_url: 'https://github.com/acme/platform/actions/runs/700001/job/900001',
      run_url: 'https://api.github.com/repos/acme/platform/actions/runs/700001',
      labels: ['arc-linux-x64'],
      runner_name: null,
      steps: [],
      workflow_name: 'CI',
      head_branch: 'main',
    },
    repository: 'acme/platform',
    owner: 'acme',
    repo: 'platform',
    runUrl: 'https://github.com/acme/platform/actions/runs/700001',
    sender: { login: 'someone', avatarUrl: 'https://example.invalid/a.png' },
    rank: 1,
    updatedAt: Date.now(),
  };
}

function storedRunningJob(runnerName: string) {
  const stored = storedQueuedJob();
  return {
    ...stored,
    job: { ...stored.job, id: 900002, status: 'in_progress', started_at: new Date().toISOString(), runner_name: runnerName },
    rank: 2,
  };
}

const previousEnv = {
  useMock: process.env.USE_MOCK_DATA,
  token: process.env.GITHUB_TOKEN,
  org: process.env.GITHUB_ORGANIZATION,
};

beforeEach(() => {
  mockGet.mockReset();
  clearAllCache();
  clearJobStore();
  process.env.USE_MOCK_DATA = 'false';
  process.env.GITHUB_TOKEN = WELL_FORMED_FAKE_TOKEN;
  process.env.GITHUB_ORGANIZATION = 'test-org';
});

afterAll(() => {
  process.env.USE_MOCK_DATA = previousEnv.useMock ?? 'true';
  if (previousEnv.token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousEnv.token;
  process.env.GITHUB_ORGANIZATION = previousEnv.org ?? 'test-org';
});

describe('A GitHub failure reaches the caller as a readable message', () => {
  test.each(ALL_ROUTES)('%s says what went wrong, not "[object Object]"', async route => {
    mockGet.mockRejectedValue({
      response: { status: 401, headers: {} },
      message: 'Request failed with status code 401',
    });

    const response = await request(app).get(route).expect(500);

    expect(response.body.error).toBe('Invalid GitHub token - please check your credentials');
    expect(response.body.error).not.toBe('[object Object]');
    expect(typeof response.body.error).toBe('string');
    expect(response.body.error.length).toBeGreaterThan(0);
  });

  test('a rate-limit refusal keeps its numbers in the message', async () => {
    mockGet.mockRejectedValue({
      response: {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 900),
        },
      },
      message: 'Request failed with status code 403',
    });

    const response = await request(app).get('/runners').expect(500);

    expect(response.body.error).toContain('rate limit exceeded');
    expect(response.body.error).toContain('0 requests remaining');
  });

  test(
    'a network failure is readable too, and gives up inside the retry budget',
    async () => {
      mockGet.mockRejectedValue({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.github.com' });

      const response = await request(app).get('/scale-sets').expect(500);

      expect(response.body.error).toBe('Unable to connect to GitHub API - network connectivity issue');
      expect(mockGet).toHaveBeenCalledTimes(3);
    },
    20000
  );
});

describe('The other documented error cases still behave', () => {
  test('a malformed token is a 400 with the documented message', async () => {
    process.env.GITHUB_TOKEN = 'not-a-token';

    const response = await request(app).get('/runners').expect(400);

    expect(response.body.error).toBe('Invalid GitHub token format');
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('a missing token is a 500 with the documented message', async () => {
    delete process.env.GITHUB_TOKEN;

    const response = await request(app).get('/jobs/queue').expect(500);

    expect(response.body.error).toBe('GitHub token not configured');
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('a missing organization is a 500 with the documented message', async () => {
    delete process.env.GITHUB_ORGANIZATION;

    const response = await request(app).get('/jobs/history').expect(500);

    expect(response.body.error).toBe('GitHub organization not configured');
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('The real path returns the documented shapes when GitHub answers', () => {
  const runnersResponse = {
    status: 200,
    data: {
      total_count: 2,
      runners: [
        { id: 1, name: 'arc-linux-x64-9f2c1', os: 'linux', status: 'online', busy: true, labels: [] },
        { id: 2, name: 'arc-linux-x64-e01a7', os: 'linux', status: 'online', busy: false, labels: [] },
      ],
    },
    headers: {},
  };

  test('/runners and /scale-sets come back in the documented shape', async () => {
    mockGet.mockResolvedValue(runnersResponse);

    const runners = await request(app).get('/runners').expect(200);
    expect(runners.body).toHaveLength(2);
    expect(runners.body[0].scaleSet).toEqual(
      expect.objectContaining({ id: 'arc-linux-x64', name: 'arc-linux-x64' })
    );

    clearAllCache();
    mockGet.mockResolvedValue(runnersResponse);

    const scaleSets = await request(app).get('/scale-sets').expect(200);
    expect(scaleSets.body).toEqual([
      { id: 'arc-linux-x64', name: 'arc-linux-x64', totalRunners: 2, online: 2, busy: 1, free: 1 },
    ]);
  });

  test('/jobs/queue warns that jobs may be missing while the store is still cold', () => {
    clearJobStore();
    mockGet.mockResolvedValue(runnersResponse);

    return request(app)
      .get('/jobs/queue')
      .expect(200)
      .then(response => {
        expect(response.body.incomplete).toBe(true);
        expect(response.body.note).toContain('some jobs may be missing');
        expect(response.body.orderingIsEstimate).toBe(true);
        expect(Array.isArray(response.body.items)).toBe(true);
      });
  });

  test('/jobs/queue stops warning once the saved store has been read back', async () => {
    clearJobStore();
    restore({ version: 1, savedAt: new Date().toISOString(), jobs: [storedQueuedJob()] });
    mockGet.mockResolvedValue(runnersResponse);

    const response = await request(app).get('/jobs/queue').expect(200);

    expect(response.body.incomplete).toBe(false);
    expect(response.body.note).not.toContain('some jobs may be missing');
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toEqual(
      expect.objectContaining({ repository: 'acme/platform', scaleSet: 'arc-linux-x64' })
    );
  });

  test('a job on a GitHub-hosted runner keeps its row instead of inventing a pool', async () => {
    clearJobStore();
    restore({
      version: 1,
      savedAt: new Date().toISOString(),
      jobs: [storedRunningJob('GitHub Actions 2')],
    });
    mockGet.mockResolvedValue(runnersResponse);

    const response = await request(app).get('/jobs/running').expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].scaleSet).toBeNull();
    expect(response.body.items[0].runnerName).toBe('GitHub Actions 2');
  });
});
