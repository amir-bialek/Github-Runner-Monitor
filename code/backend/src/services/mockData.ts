import { GitHubRunner, GitHubJob, JobActor, RunContext } from '../types/github';
import type { StoredRun } from './jobStore.ts';
import type { ResolvedTarget, TargetKind } from './debugIt/runs.ts';

export function isMockMode(): boolean {
  return process.env.USE_MOCK_DATA === 'true';
}

function label(id: number, name: string, type: 'read-only' | 'custom' = 'custom') {
  return { id, name, type };
}

export const mockRunners: GitHubRunner[] = [
  { id: 101, name: 'arc-linux-x64-9f2c1', os: 'linux', status: 'online', busy: true, labels: [label(2, 'self-hosted', 'read-only'), label(3, 'linux', 'read-only'), label(4, 'x64', 'read-only')] },
  { id: 102, name: 'arc-linux-x64-4a8de', os: 'linux', status: 'online', busy: true, labels: [label(2, 'self-hosted', 'read-only'), label(3, 'linux', 'read-only'), label(4, 'x64', 'read-only')] },
  { id: 103, name: 'arc-linux-x64-77b03', os: 'linux', status: 'online', busy: false, labels: [label(2, 'self-hosted', 'read-only'), label(3, 'linux', 'read-only'), label(4, 'x64', 'read-only')] },
  { id: 104, name: 'arc-linux-x64-2c5f9', os: 'linux', status: 'online', busy: false, labels: [label(2, 'self-hosted', 'read-only'), label(3, 'linux', 'read-only'), label(4, 'x64', 'read-only')] },
  { id: 105, name: 'arc-linux-x64-e01a7', os: 'linux', status: 'online', busy: false, labels: [label(2, 'self-hosted', 'read-only'), label(3, 'linux', 'read-only'), label(4, 'x64', 'read-only')] },
  { id: 106, name: 'arc-linux-x64-b3d44', os: 'linux', status: 'offline', busy: false, labels: [label(2, 'self-hosted', 'read-only'), label(3, 'linux', 'read-only'), label(4, 'x64', 'read-only')] },

  { id: 201, name: 'arc-gpu-a10-16cc2', os: 'linux', status: 'online', busy: true, labels: [label(6, 'self-hosted', 'read-only'), label(7, 'linux', 'read-only'), label(8, 'gpu'), label(9, 'a10')] },
  { id: 202, name: 'arc-gpu-a10-83fb1', os: 'linux', status: 'online', busy: true, labels: [label(6, 'self-hosted', 'read-only'), label(7, 'linux', 'read-only'), label(8, 'gpu'), label(9, 'a10')] },
  { id: 203, name: 'arc-gpu-a10-5da60', os: 'linux', status: 'online', busy: true, labels: [label(6, 'self-hosted', 'read-only'), label(7, 'linux', 'read-only'), label(8, 'gpu'), label(9, 'a10')] },
  { id: 204, name: 'arc-gpu-a10-c9e18', os: 'linux', status: 'offline', busy: false, labels: [label(6, 'self-hosted', 'read-only'), label(7, 'linux', 'read-only'), label(8, 'gpu'), label(9, 'a10')] },

  { id: 301, name: 'arc-linux-arm64-a71f4', os: 'linux', status: 'online', busy: false, labels: [label(11, 'self-hosted', 'read-only'), label(12, 'linux', 'read-only'), label(13, 'arm64')] },
  { id: 302, name: 'arc-linux-arm64-6b2c8', os: 'linux', status: 'online', busy: false, labels: [label(11, 'self-hosted', 'read-only'), label(12, 'linux', 'read-only'), label(13, 'arm64')] },
  { id: 303, name: 'arc-linux-arm64-d40e5', os: 'linux', status: 'online', busy: true, labels: [label(11, 'self-hosted', 'read-only'), label(12, 'linux', 'read-only'), label(13, 'arm64')] },
  { id: 304, name: 'arc-linux-arm64-31ba9', os: 'linux', status: 'offline', busy: false, labels: [label(11, 'self-hosted', 'read-only'), label(12, 'linux', 'read-only'), label(13, 'arm64')] },

  { id: 401, name: 'arc-windows-x64-5e7a2', os: 'windows', status: 'offline', busy: false, labels: [label(15, 'self-hosted', 'read-only'), label(16, 'windows', 'read-only'), label(17, 'x64', 'read-only')] },
  { id: 402, name: 'arc-windows-x64-c18b9', os: 'windows', status: 'offline', busy: false, labels: [label(15, 'self-hosted', 'read-only'), label(16, 'windows', 'read-only'), label(17, 'x64', 'read-only')] },
];

const REPOS = ['acme/web-app', 'acme/platform', 'acme/infra-tools', 'acme/billing-service', 'acme/deploy-tools'];

/** Every invented repository of mock mode, including the one with a failed run without jobs (story 3.14). */
export const MOCK_REPOSITORIES: readonly string[] = [...REPOS, 'acme/payments-api'];

const MOCK_WORKFLOW_BY_JOB_NAME: Record<string, string> = {
  build: 'CI',
  'unit-tests': 'CI',
  'docker-build': 'Docker Publish',
  'package-release': 'Package Release',
  lint: 'CI',
  'integration-tests': 'Integration Suite',
};

const MOCK_ACTORS: JobActor[] = [
  { login: 'amira-k', avatarUrl: 'https://avatars.githubusercontent.com/u/10001001?v=4' },
  { login: 'devlin-park', avatarUrl: 'https://avatars.githubusercontent.com/u/10001002?v=4' },
  { login: 'marco-t', avatarUrl: 'https://avatars.githubusercontent.com/u/10001003?v=4' },
  { login: 'priya-s', avatarUrl: 'https://avatars.githubusercontent.com/u/10001004?v=4' },
];
const MOCK_BRANCHES = ['main', 'feature/queue-position-fix', 'fix/runner-labels', 'feature/telemetry-export', 'release/1.4', 'chore/deps-bump'];
const MOCK_EVENTS = ['push', 'pull_request', 'workflow_dispatch', 'schedule'];

const mockRunContextByRunId: Record<number, RunContext> = {};
const mockRepositoryByJobId = new Map<number, string>();

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeJob(
  index: number,
  repo: string,
  status: GitHubJob['status'],
  conclusion: GitHubJob['conclusion'],
  runnerId: number | null,
  runnerName: string | null,
  createdMinutesAgo: number,
  durationMinutes: number | null,
  requestedScaleSet?: string,
  branch?: string,
  actor?: JobActor,
  event?: string
): GitHubJob {
  const id = 900000 + index;
  const runId = 700000 + index;
  const started = status === 'queued' ? null : minutesAgo(createdMinutesAgo - 1);
  const completed = status === 'completed' && durationMinutes !== null
    ? minutesAgo(createdMinutesAgo - 1 - durationMinutes)
    : null;
  const jobName = ['build', 'unit-tests', 'docker-build', 'package-release', 'lint', 'integration-tests'][index % 6]!;

  mockRepositoryByJobId.set(id, repo);
  mockRunContextByRunId[runId] = {
    workflowName: MOCK_WORKFLOW_BY_JOB_NAME[jobName] ?? null,
    branch: branch ?? MOCK_BRANCHES[index % MOCK_BRANCHES.length]!,
    actor: actor ?? MOCK_ACTORS[index % MOCK_ACTORS.length]!,
    event: event ?? MOCK_EVENTS[index % MOCK_EVENTS.length]!,
    runUrl: `https://github.com/${repo}/actions/runs/${runId}`,
  };

  return {
    id,
    run_id: runId,
    run_url: `https://api.github.com/repos/${repo}/actions/runs/${runId}`,
    run_attempt: 1,
    node_id: `MOCK_kwDOA${id}`,
    head_sha: Array.from({ length: 40 }, (_, i) => '0123456789abcdef'[(id + i) % 16]).join(''),
    url: `https://api.github.com/repos/${repo}/actions/jobs/${id}`,
    html_url: `https://github.com/${repo}/actions/runs/${runId}/job/${id}`,
    status,
    conclusion,
    created_at: minutesAgo(createdMinutesAgo),
    started_at: started,
    completed_at: completed,
    name: jobName,
    steps: [
      { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, started_at: started, completed_at: started },
      { name: 'Checkout', status: 'completed', conclusion: 'success', number: 2, started_at: started, completed_at: started },
      { name: 'Build', status: status === 'completed' ? 'completed' : status, conclusion, number: 3, started_at: started, completed_at: completed },
    ],
    check_run_url: `https://api.github.com/repos/${repo}/check-runs/${id}`,
    labels: requestedScaleSet ? ['self-hosted', 'linux', requestedScaleSet] : ['self-hosted', 'linux'],
    runner_id: runnerId,
    runner_name: runnerName,
    runner_group_id: runnerId ? 1 : null,
    runner_group_name: runnerId ? 'Default' : null,
  };
}

export const mockJobs: GitHubJob[] = [
  makeJob(1, REPOS[0]!, 'in_progress', null, 101, 'arc-linux-x64-9f2c1', 4, null),
  makeJob(2, REPOS[1]!, 'in_progress', null, 102, 'arc-linux-x64-4a8de', 7, null),
  makeJob(3, REPOS[2]!, 'in_progress', null, 201, 'arc-gpu-a10-16cc2', 12, null),
  makeJob(4, REPOS[3]!, 'in_progress', null, 202, 'arc-gpu-a10-83fb1', 15, null),
  makeJob(5, REPOS[0]!, 'in_progress', null, 203, 'arc-gpu-a10-5da60', 18, null),
  makeJob(6, REPOS[4]!, 'in_progress', null, 303, 'arc-linux-arm64-d40e5', 3, null),
  makeJob(7, REPOS[1]!, 'queued', null, null, null, 17, null, 'arc-gpu-a10'),
  makeJob(8, REPOS[2]!, 'queued', null, null, null, 11, null, 'arc-gpu-a10'),
  makeJob(9, REPOS[3]!, 'queued', null, null, null, 3, null),
  makeJob(10, REPOS[0]!, 'completed', 'success', 103, 'arc-linux-x64-77b03', 25, 6),
  makeJob(11, REPOS[1]!, 'completed', 'success', 104, 'arc-linux-x64-2c5f9', 38, 11),
  makeJob(12, REPOS[2]!, 'completed', 'failure', 105, 'arc-linux-x64-e01a7', 52, 4),
  makeJob(13, REPOS[3]!, 'completed', 'success', 301, 'arc-linux-arm64-a71f4', 64, 9),
  makeJob(14, REPOS[4]!, 'completed', 'cancelled', 302, 'arc-linux-arm64-6b2c8', 71, 2),
  makeJob(15, REPOS[0]!, 'completed', 'success', 201, 'arc-gpu-a10-16cc2', 88, 23),
  makeJob(16, REPOS[1]!, 'completed', 'failure', 202, 'arc-gpu-a10-83fb1', 104, 17),
  makeJob(17, REPOS[2]!, 'completed', 'success', 103, 'arc-linux-x64-77b03', 121, 5),
  makeJob(18, REPOS[3]!, 'completed', 'success', 104, 'arc-linux-x64-2c5f9', 143, 8),
  makeJob(19, REPOS[4]!, 'completed', 'timed_out', 203, 'arc-gpu-a10-5da60', 166, 60),
  makeJob(20, REPOS[0]!, 'completed', 'success', 301, 'arc-linux-arm64-a71f4', 190, 12),
  makeJob(21, REPOS[0]!, 'queued', null, null, null, 2, null, 'arc-gpu-a10', 'feature/telemetry-export', MOCK_ACTORS[0]!, 'pull_request'),
  makeJob(22, REPOS[0]!, 'queued', null, null, null, 20, null, 'arc-gpu-a10', 'release/1.4', MOCK_ACTORS[3]!, 'push'),
];

export function mockRunContext(job: GitHubJob): RunContext {
  return (
    mockRunContextByRunId[job.run_id] ?? {
      workflowName: null,
      branch: null,
      actor: null,
      event: null,
      runUrl: job.run_url,
    }
  );
}

/**
 * Invented workflow runs that failed before any job started (story 3.14): they
 * show in mock Recent history as run rows, so Debug it can start on them.
 */
export const mockFailedRuns: StoredRun[] = [
  {
    id: 780001,
    runAttempt: 1,
    name: 'Deploy',
    headBranch: 'main',
    headSha: 'fedcba9876543210fedcba9876543210fedcba98',
    htmlUrl: 'https://github.com/acme/payments-api/actions/runs/780001',
    createdAt: minutesAgo(46),
    runStartedAt: null,
    updatedAt: minutesAgo(45),
    conclusion: 'failure',
    event: 'push',
    repository: 'acme/payments-api',
    headRepository: 'acme/payments-api',
    actor: MOCK_ACTORS[1]!,
  },
];

/**
 * The Debug it target of a failed mock job or a failed mock run without jobs
 * (story 3.14), or null. Only mock mode consults it.
 */
export function mockDebugTarget(kind: TargetKind, id: number): ResolvedTarget | null {
  if (kind === 'job') {
    const job = mockJobs.find((j) => j.id === id);
    const repository = mockRepositoryByJobId.get(id);
    if (!job || !repository || job.status !== 'completed' || job.conclusion !== 'failure') return null;
    return {
      kind: 'job',
      id,
      repository,
      jobName: job.name,
      headSha: job.head_sha || null,
      branch: mockRunContext(job).branch,
      workflowRunId: job.run_id,
    };
  }
  if (kind === 'run') {
    const run = mockFailedRuns.find((r) => r.id === id);
    if (!run) return null;
    return {
      kind: 'run',
      id,
      repository: run.repository,
      jobName: run.name ?? '',
      headSha: run.headSha,
      branch: run.headBranch,
      workflowRunId: run.id,
    };
  }
  return null;
}
