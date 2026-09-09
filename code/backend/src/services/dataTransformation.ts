import {
  GitHubRunner,
  GitHubRunnersResponse,
  GitHubJob,
  GitHubJobsResponse,
  InternalRunner,
  InternalJob,
  RunnerAvailability,
  ScaleSetInfo,
  ScaleSetSummary,
  JobHistorySummary,
  JobQueueStatus,
  JobResult,
  JobQueueItem,
  JobRunningItem,
  JobHistoryItem,
  RunContext,
} from '../types/github';

const RUNNER_SUFFIX_PATTERN = /-[a-z0-9]{4,10}$/i;

export function deriveScaleSetSlug(runnerName: string | null | undefined): string | null {
  if (!runnerName) return null;
  const match = runnerName.match(RUNNER_SUFFIX_PATTERN);
  if (!match || match.index === undefined) return runnerName;
  return runnerName.slice(0, match.index);
}

function groupRunnersBySlug(runners: GitHubRunner[]): Record<string, GitHubRunner[]> {
  const groups: Record<string, GitHubRunner[]> = {};
  for (const runner of runners) {
    const slug = deriveScaleSetSlug(runner.name) ?? 'ungrouped';
    (groups[slug] ??= []).push(runner);
  }
  return groups;
}

export function transformRunnerData(githubRunner: GitHubRunner): InternalRunner {
  return transformRunnersCollection([githubRunner])[0]!;
}

export function transformRunnersCollection(runners: GitHubRunner[]): InternalRunner[] {
  const availability = calculateRunnerAvailability(runners);
  const groups = groupRunnersBySlug(runners);

  return runners.map(runner => {
    const slug = deriveScaleSetSlug(runner.name) ?? 'ungrouped';
    const group = groups[slug] || [];

    const scaleSet: ScaleSetInfo = {
      id: slug,
      name: slug,
      runnerCount: group.length,
      onlineRunners: group.filter(r => r.status === 'online').length,
    };

    return {
      ...runner,
      availability,
      scaleSet,
      lastSeen: new Date().toISOString(),
    };
  });
}

export function buildScaleSets(runners: GitHubRunner[]): ScaleSetSummary[] {
  const groups = groupRunnersBySlug(runners);

  return Object.entries(groups)
    .map(([slug, group]) => {
      const online = group.filter(r => r.status === 'online').length;
      const busy = group.filter(r => r.busy).length;
      return {
        id: slug,
        name: slug,
        totalRunners: group.length,
        online,
        busy,
        free: Math.max(0, online - busy),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function calculateRunnerAvailability(runners: GitHubRunner[]): RunnerAvailability {
  const total = runners.length;
  const online = runners.filter(r => r.status === 'online').length;
  const offline = runners.filter(r => r.status === 'offline').length;
  const busy = runners.filter(r => r.busy).length;
  const free = online - busy;

  return {
    total,
    online,
    offline,
    busy,
    free: Math.max(0, free),
  };
}

export function transformJobData(githubJob: GitHubJob): InternalJob {
  const duration = calculateJobDuration(githubJob);
  const repository = extractRepositoryFromJob(githubJob);
  const workflowName = extractWorkflowNameFromJob(githubJob);

  return {
    ...githubJob,
    duration,
    repository,
    workflowName,
  };
}

function calculateJobDuration(job: GitHubJob): number | null {
  if (!job.started_at || !job.completed_at) return null;

  const startTime = new Date(job.started_at).getTime();
  const endTime = new Date(job.completed_at).getTime();

  return endTime - startTime;
}

export function extractRepositoryFromJob(job: GitHubJob): string | null {
  try {
    const urlParts = job.run_url.split('/');
    const repoIndex = urlParts.findIndex(part => part === 'repos') + 1;
    if (repoIndex > 0 && repoIndex < urlParts.length - 2) {
      return `${urlParts[repoIndex]}/${urlParts[repoIndex + 1]}`;
    }
  } catch (error) {
    console.warn('Failed to extract repository from job:', job.id, error);
  }
  return null;
}

function extractWorkflowNameFromJob(job: GitHubJob): string | null {
  try {
    const urlParts = job.run_url.split('/');
    const actionsIndex = urlParts.findIndex(part => part === 'actions');
    if (actionsIndex > 0 && actionsIndex < urlParts.length - 1) {
      return urlParts[actionsIndex + 2] || null;
    }
  } catch (error) {
    console.warn('Failed to extract workflow name from job:', job.id, error);
  }
  return null;
}

export const GITHUB_HOSTED_POOL = 'GitHub Actions (cloud)';

const GITHUB_HOSTED_GROUP_NAME = 'GitHub Actions';
const GITHUB_HOSTED_LABEL_PATTERN = /^(ubuntu|windows|macos)-/;

export function isGitHubHostedJob(job: GitHubJob): boolean {
  if (job.runner_group_name === GITHUB_HOSTED_GROUP_NAME) return true;
  if (job.runner_group_id === 0) return true;
  if (job.labels?.includes('self-hosted')) return false;
  return job.labels?.some(label => GITHUB_HOSTED_LABEL_PATTERN.test(label)) ?? false;
}

export function deriveJobScaleSet(job: GitHubJob, knownScaleSetSlugs: string[]): string | null {
  if (isGitHubHostedJob(job)) {
    return GITHUB_HOSTED_POOL;
  }
  if (job.runner_name) {
    return deriveScaleSetSlug(job.runner_name);
  }
  return job.labels?.find(label => knownScaleSetSlugs.includes(label)) ?? null;
}

const CONCLUSION_TO_RESULT: Partial<Record<NonNullable<GitHubJob['conclusion']>, JobResult>> = {
  success: 'success',
  failure: 'failure',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
};

function repositoryUrlFor(repository: string): string {
  return `https://github.com/${repository}`;
}

export const QUEUE_ORDERING_NOTE =
  'Estimated order — oldest waiting job first. GitHub does not publish a real queue position.';

export const INCOMPLETE_REFRESH_NOTE =
  'This refresh could not check every repository, so some jobs may be missing.';

export function noteFor(baseNote: string, incomplete: boolean): string {
  return incomplete ? `${baseNote} ${INCOMPLETE_REFRESH_NOTE}` : baseNote;
}

type QueueItemDraft = Omit<JobQueueItem, 'position'>;

const UNASSIGNED_GROUP = Symbol('unassigned');

export function toJobQueueItem(
  job: GitHubJob,
  repository: string,
  runContext: RunContext,
  knownScaleSetSlugs: string[]
): QueueItemDraft {
  const now = Date.now();

  return {
    id: job.id,
    name: job.name,
    workflowName: runContext.workflowName,
    branch: runContext.branch,
    actor: runContext.actor,
    event: runContext.event,
    repository,
    repositoryUrl: repositoryUrlFor(repository),
    scaleSet: deriveJobScaleSet(job, knownScaleSetSlugs),
    createdAt: job.created_at,
    waitMs: now - new Date(job.created_at).getTime(),
    htmlUrl: job.html_url,
    runUrl: runContext.runUrl,
  };
}

export function assignQueuePositions(drafts: QueueItemDraft[]): JobQueueItem[] {
  const groups = new Map<string | symbol, QueueItemDraft[]>();
  for (const draft of drafts) {
    const key = draft.scaleSet ?? UNASSIGNED_GROUP;
    const group = groups.get(key);
    if (group) {
      group.push(draft);
    } else {
      groups.set(key, [draft]);
    }
  }

  const result: JobQueueItem[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    ordered.forEach((draft, index) => result.push({ ...draft, position: index + 1 }));
  }

  return result.sort((a, b) => {
    const scaleSetCompare = (a.scaleSet ?? '').localeCompare(b.scaleSet ?? '');
    return scaleSetCompare !== 0 ? scaleSetCompare : a.position - b.position;
  });
}

export function toJobRunningItem(
  job: GitHubJob,
  repository: string,
  runContext: RunContext,
  knownScaleSetSlugs: string[]
): JobRunningItem {
  const now = Date.now();

  return {
    id: job.id,
    name: job.name,
    workflowName: runContext.workflowName,
    branch: runContext.branch,
    actor: runContext.actor,
    event: runContext.event,
    repository,
    repositoryUrl: repositoryUrlFor(repository),
    runnerName: job.runner_name,
    scaleSet: deriveJobScaleSet(job, knownScaleSetSlugs),
    startedAt: job.started_at,
    runningMs: job.started_at ? now - new Date(job.started_at).getTime() : null,
    htmlUrl: job.html_url,
    runUrl: runContext.runUrl,
  };
}

export const RUNNING_ORDER_NOTE =
  'There is no real "time remaining" for a running job. Rows are ordered by start time ' +
  '(earliest first) as a proxy for which is likely to free its runner soonest; actual ' +
  'finish times depend on each job\'s own duration and may differ substantially.';

export function orderRunningJobs(items: JobRunningItem[]): JobRunningItem[] {
  return [...items].sort((a, b) => {
    const aTime = a.startedAt ? new Date(a.startedAt).getTime() : Infinity;
    const bTime = b.startedAt ? new Date(b.startedAt).getTime() : Infinity;
    return aTime - bTime;
  });
}

export function toJobHistoryItem(
  job: GitHubJob,
  repository: string,
  runContext: RunContext,
  knownScaleSetSlugs: string[]
): JobHistoryItem {
  const durationMs =
    job.started_at && job.completed_at
      ? new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
      : null;

  return {
    id: job.id,
    name: job.name,
    workflowName: runContext.workflowName,
    branch: runContext.branch,
    actor: runContext.actor,
    event: runContext.event,
    repository,
    repositoryUrl: repositoryUrlFor(repository),
    result: (job.conclusion && CONCLUSION_TO_RESULT[job.conclusion]) || 'other',
    runnerName: job.runner_name,
    scaleSet: deriveJobScaleSet(job, knownScaleSetSlugs),
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    durationMs,
    htmlUrl: job.html_url,
    runUrl: runContext.runUrl,
  };
}

export function calculateJobHistorySummary(jobs: InternalJob[]): JobHistorySummary {
  const totalJobs = jobs.length;
  const successfulJobs = jobs.filter(job => job.conclusion === 'success').length;
  const failedJobs = jobs.filter(job => job.conclusion === 'failure').length;
  const successRate = totalJobs > 0 ? (successfulJobs / totalJobs) * 100 : 0;

  const durations = jobs
    .filter(job => job.duration !== null)
    .map(job => job.duration!);

  const averageDuration = durations.length > 0
    ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
    : null;

  const recentJobs = jobs
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10);

  return {
    totalJobs,
    successfulJobs,
    failedJobs,
    successRate,
    averageDuration,
    recentJobs,
  };
}

export function calculateJobQueueStatus(jobs: GitHubJob[]): JobQueueStatus {
  return {
    queued: jobs.filter(job => job.status === 'queued').length,
    inProgress: jobs.filter(job => job.status === 'in_progress').length,
    completed: jobs.filter(job => job.status === 'completed').length,
    waiting: jobs.filter(job => job.status === 'waiting').length,
    requested: jobs.filter(job => job.status === 'requested').length,
  };
}
