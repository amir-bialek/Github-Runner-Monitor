import { isMockMode, mockJobs, mockRunContext } from './mockData.ts';
import {
  assignQueuePositions,
  extractRepositoryFromJob,
  orderRunningJobs,
  toJobHistoryItem,
  toJobQueueItem,
  toJobRunningItem,
} from './dataTransformation.ts';
import { buildSnapshot } from './jobStore.ts';
import type { GitHubJob, JobHistoryItem, JobQueueItem, JobRunningItem } from '../types/github.ts';

export const DEFAULT_HISTORY_MAX_AGE_DAYS = 7;

export interface JobSnapshot {
  queue: JobQueueItem[];
  running: JobRunningItem[];
  history: JobHistoryItem[];
  incomplete: boolean;
}

export interface LiveJobs {
  queue: JobQueueItem[];
  running: JobRunningItem[];
  incomplete: boolean;
}

function repositoryOf(job: GitHubJob): string {
  return extractRepositoryFromJob(job) ?? 'unknown/unknown';
}

function buildSnapshotFromMock(scaleSetSlugs: string[]): JobSnapshot {
  const queueDrafts = mockJobs
    .filter(job => job.status === 'queued')
    .map(job => toJobQueueItem(job, repositoryOf(job), mockRunContext(job), scaleSetSlugs));

  const running = mockJobs
    .filter(job => job.status === 'in_progress')
    .map(job => toJobRunningItem(job, repositoryOf(job), mockRunContext(job), scaleSetSlugs));

  const history = mockJobs
    .filter(job => job.status === 'completed')
    .map(job => toJobHistoryItem(job, repositoryOf(job), mockRunContext(job), scaleSetSlugs))
    .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime());

  return { queue: assignQueuePositions(queueDrafts), running: orderRunningJobs(running), history, incomplete: false };
}

function snapshotFor(knownScaleSetSlugs: string[]): JobSnapshot {
  if (isMockMode()) {
    return buildSnapshotFromMock(knownScaleSetSlugs);
  }
  return buildSnapshot(knownScaleSetSlugs);
}

export async function getQueueAndRunning(
  _org: string,
  _token: string,
  knownScaleSetSlugs: string[]
): Promise<LiveJobs> {
  const { queue, running, incomplete } = snapshotFor(knownScaleSetSlugs);
  return { queue, running, incomplete };
}

export async function getHistory(
  _org: string,
  _token: string,
  knownScaleSetSlugs: string[]
): Promise<JobHistoryItem[]> {
  return snapshotFor(knownScaleSetSlugs).history;
}
