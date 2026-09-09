jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

import axios from 'axios';
import { GitHubApiError, GitHubClient, hasNextPage } from '../src/services/githubClient';
import { buildScaleSets, transformRunnersCollection } from '../src/services/dataTransformation';
import { GitHubRunner } from '../src/types/github';

const mockGet = axios.get as unknown as jest.Mock;

function runner(id: number, name: string, status: 'online' | 'offline' = 'online', busy = false): GitHubRunner {
  return { id, name, os: 'linux', status, busy, labels: [] };
}

function runnersPage(runners: GitHubRunner[], totalCount: number, nextPage: number | null) {
  const link = nextPage
    ? `<https://api.github.com/organizations/1/actions/runners?page=${nextPage}>; rel="next", ` +
      `<https://api.github.com/organizations/1/actions/runners?page=9>; rel="last"`
    : `<https://api.github.com/organizations/1/actions/runners?page=1>; rel="first"`;

  return { status: 200, data: { total_count: totalCount, runners }, headers: { link } };
}

function fullPage(offset: number, count = 100): GitHubRunner[] {
  return Array.from({ length: count }, (_, i) => runner(offset + i, `arc-linux-x64-${offset + i}aaa`));
}

beforeEach(() => {
  mockGet.mockReset();
});

describe('GitHubClient.getRunners pagination', () => {
  test('asks for 100 per page instead of taking GitHub\'s default 30', async () => {
    mockGet.mockResolvedValueOnce(runnersPage([runner(1, 'arc-linux-x64-9f2c1')], 1, null));

    await new GitHubClient('test-token').getRunners('acme');

    expect(mockGet).toHaveBeenCalledTimes(1);
    const url = mockGet.mock.calls[0]![0] as string;
    expect(url).toContain('/orgs/acme/actions/runners');
    expect(url).toContain('per_page=100');
    expect(url).toContain('page=1');
  });

  test('follows every page and returns all the runners, not just the first page', async () => {
    mockGet
      .mockResolvedValueOnce(runnersPage(fullPage(0), 250, 2))
      .mockResolvedValueOnce(runnersPage(fullPage(100), 250, 3))
      .mockResolvedValueOnce(runnersPage(fullPage(200, 50), 250, null));

    const runners = await new GitHubClient('test-token').getRunners('acme');

    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(runners).toHaveLength(250);
    expect(runners[0]!.id).toBe(0);
    expect(runners[249]!.id).toBe(249);
    expect(new Set(runners.map(r => r.id)).size).toBe(250);
  });

  test('stops after one call when the org fits on a single page', async () => {
    mockGet.mockResolvedValue(runnersPage([runner(1, 'arc-gpu-a10-1x2y3')], 1, null));

    const runners = await new GitHubClient('test-token').getRunners('acme');

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(runners).toHaveLength(1);
  });

  test('stops once it holds everything GitHub says exists, even if the Link header keeps offering more', async () => {
    mockGet
      .mockResolvedValueOnce(runnersPage(fullPage(0), 100, 2))
      .mockResolvedValueOnce(runnersPage(fullPage(100), 100, 3));

    const runners = await new GitHubClient('test-token').getRunners('acme');

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(runners).toHaveLength(100);
  });

  test('gives up at the page cap rather than walking a huge org forever', async () => {
    mockGet.mockImplementation(async () => runnersPage(fullPage(0), 1_000_000, 99));

    const runners = await new GitHubClient('test-token').getRunners('acme');

    const maxPages = parseInt(process.env.GITHUB_MAX_RUNNER_PAGES || '20');
    expect(mockGet).toHaveBeenCalledTimes(maxPages);
    expect(runners).toHaveLength(maxPages * 100);
  });

  test('a scale set that only appears past page 1 still reaches the dashboard', async () => {
    const pageOne = fullPage(0);
    const pageTwo = [
      runner(500, 'arc-gpu-a10-aa11a', 'online', true),
      runner(501, 'arc-gpu-a10-bb22b', 'online', false),
      runner(502, 'arc-gpu-a10-cc33c', 'offline', false),
    ];

    mockGet
      .mockResolvedValueOnce(runnersPage(pageOne, 103, 2))
      .mockResolvedValueOnce(runnersPage(pageTwo, 103, null));

    const runners = await new GitHubClient('test-token').getRunners('acme');
    const scaleSets = buildScaleSets(runners);
    const gpu = scaleSets.find(s => s.id === 'arc-gpu-a10');

    expect(gpu).toBeDefined();
    expect(gpu).toEqual(
      expect.objectContaining({ totalRunners: 3, online: 2, busy: 1, free: 1 })
    );

    const transformed = transformRunnersCollection(runners);
    expect(transformed[0]!.availability.total).toBe(103);
    expect(transformed[0]!.availability.offline).toBe(1);
  });
});

describe('hasNextPage', () => {
  test('recognizes a rel="next" part in GitHub\'s Link header', () => {
    expect(
      hasNextPage({
        headers: { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"' },
      } as any)
    ).toBe(true);
  });

  test('says no on the last page and when there is no Link header at all', () => {
    expect(hasNextPage({ headers: { link: '<https://api.github.com/x?page=1>; rel="prev"' } } as any)).toBe(false);
    expect(hasNextPage({ headers: {} } as any)).toBe(false);
  });
});

describe('Rate limiting and retry bounds', () => {
  test('refuses to make a call once the remaining budget hits the reserve', async () => {
    const client = new GitHubClient('test-token');

    mockGet.mockResolvedValueOnce({
      status: 200,
      data: { total_count: 0, runners: [] },
      headers: {
        'x-ratelimit-remaining': '3',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
      },
    });

    await client.getRunners('acme');
    expect(mockGet).toHaveBeenCalledTimes(1);

    await expect(client.getRunners('acme')).rejects.toEqual(
      expect.objectContaining({ type: 'RATE_LIMIT', statusCode: 429, rateLimitRemaining: 3 })
    );
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test('a rate-limit reset minutes away fails immediately instead of sleeping until it', async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 290;
    mockGet.mockRejectedValue({
      response: {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) },
      },
      message: 'rate limited',
    });

    await expect(new GitHubClient('test-token').getRunners('acme')).rejects.toEqual(
      expect.objectContaining({ type: 'RATE_LIMIT', statusCode: 403 })
    );

    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe('GitHubClient.getJobsForRun pagination', () => {
  function jobsPage(jobs: unknown[], totalCount: number, hasNext: boolean) {
    const link = hasNext
      ? '<https://api.github.com/repos/acme/x/actions/runs/1/jobs?page=2>; rel="next"'
      : '<https://api.github.com/repos/acme/x/actions/runs/1/jobs?page=1>; rel="first"';
    return { status: 200, data: { total_count: totalCount, jobs }, headers: { link } };
  }

  function jobBatch(offset: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({ id: offset + i, name: `matrix-${offset + i}` }));
  }

  test('asks for 100 per page instead of taking GitHub\'s default 30', async () => {
    mockGet.mockResolvedValueOnce(jobsPage(jobBatch(0, 4), 4, false));

    await new GitHubClient('test-token').getJobsForRun('acme', 'web-app', 700001);

    const url = mockGet.mock.calls[0]![0] as string;
    expect(url).toContain('/repos/acme/web-app/actions/runs/700001/jobs');
    expect(url).toContain('per_page=100');
    expect(url).toContain('page=1');
  });

  test('a matrix build past 30 jobs keeps every job, across pages', async () => {
    mockGet
      .mockResolvedValueOnce(jobsPage(jobBatch(0, 100), 240, true))
      .mockResolvedValueOnce(jobsPage(jobBatch(100, 100), 240, true))
      .mockResolvedValueOnce(jobsPage(jobBatch(200, 40), 240, false));

    const response = await new GitHubClient('test-token').getJobsForRun('acme', 'web-app', 700001);

    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(response.jobs).toHaveLength(240);
    expect(response.total_count).toBe(240);
    expect(response.jobs[239]!.id).toBe(239);
    expect(new Set(response.jobs.map(j => j.id)).size).toBe(240);
  });

  test('stops after one call for a run that fits on one page', async () => {
    mockGet.mockResolvedValue(jobsPage(jobBatch(0, 6), 6, false));

    const response = await new GitHubClient('test-token').getJobsForRun('acme', 'platform', 700002);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(response.jobs).toHaveLength(6);
  });

  test('gives up at the page cap rather than walking one run forever', async () => {
    mockGet.mockImplementation(async () => jobsPage(jobBatch(0, 100), 1_000_000, true));

    const response = await new GitHubClient('test-token').getJobsForRun('acme', 'platform', 700003);

    const maxPages = parseInt(process.env.GITHUB_MAX_JOB_PAGES || '10');
    expect(mockGet).toHaveBeenCalledTimes(maxPages);
    expect(response.jobs).toHaveLength(maxPages * 100);
  });
});

describe('Errors are real Errors', () => {
  test('a GitHub 401 arrives as an Error whose message is readable', async () => {
    mockGet.mockRejectedValue({
      response: { status: 401, headers: {} },
      message: 'Request failed with status code 401',
    });

    const thrown = await new GitHubClient('test-token').getRunners('acme').catch(e => e);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBeInstanceOf(GitHubApiError);
    expect(thrown.message).toBe('Invalid GitHub token - please check your credentials');
    expect(String(thrown)).not.toContain('[object Object]');
    expect(thrown.type).toBe('AUTHENTICATION');
    expect(thrown.statusCode).toBe(401);
    expect(thrown.endpoint).toContain('/orgs/acme/actions/runners');
  });

  test('the rate-limit refusal is a real Error too', async () => {
    const client = new GitHubClient('test-token');
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: { total_count: 0, runners: [] },
      headers: {
        'x-ratelimit-remaining': '1',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
      },
    });
    await client.getRunners('acme');

    const thrown = await client.getRunners('acme').catch(e => e);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain('rate limit exceeded');
    expect(String(thrown)).not.toContain('[object Object]');
  });

  test('adding context to an error keeps the message and the structured fields', async () => {
    mockGet.mockRejectedValue({
      response: { status: 404, headers: {} },
      message: 'Request failed with status code 404',
    });

    const thrown = await new GitHubClient('test-token')
      .getJobsForRun('acme', 'web-app', 700001)
      .catch(e => e);

    expect(thrown).toBeInstanceOf(GitHubApiError);
    expect(thrown.message).toContain('Failed to fetch jobs for run 700001 in acme/web-app');
    expect(thrown.message).toContain('GitHub API resource not found');
    expect(thrown.statusCode).toBe(404);
    expect(String(thrown)).not.toContain('[object Object]');
  });
});
