import type { JobActor, JobHistoryItem, JobQueueItem, JobRunningItem, RunContext } from '../types/github.ts';
import type { WorkflowJobAction, WorkflowJobEvent, WorkflowJobPayloadJob } from '../types/webhook.ts';
import {
  assignQueuePositions,
  GITHUB_HOSTED_POOL,
  orderRunningJobs,
  toJobHistoryItem,
  toJobQueueItem,
  toJobRunningItem,
} from './dataTransformation.ts';
import { extrasFor } from './runContextStore.ts';

const RANK: Record<WorkflowJobAction, number> = {
  waiting: 0,
  queued: 1,
  in_progress: 2,
  completed: 3,
};

const MAX_JOBS = parseInt(process.env.JOB_STORE_MAX_JOBS || '5000');

const MAX_AGE_DAYS = parseInt(process.env.JOB_STORE_MAX_AGE_DAYS || '7');

const STUCK_JOB_HOURS = parseInt(process.env.JOB_STORE_STUCK_HOURS || '12');

const WARMUP_MS = parseFloat(process.env.JOB_STORE_WARMUP_SECONDS || '300') * 1000;

export interface StoredJob {
  job: WorkflowJobPayloadJob;
  repository: string;
  owner: string;
  repo: string;
  runUrl: string;
  sender: JobActor | null;
  rank: number;
  updatedAt: number;
}

const jobs = new Map<number, StoredJob>();

let restoreSettled = false;
let restoredAnything = false;
let startedAt = Date.now();

let revision = 0;

export function currentRevision(): number {
  return revision;
}

export function upsert(event: WorkflowJobEvent): boolean {
  const job = event.workflow_job;
  if (!job || typeof job.id !== 'number') return false;

  const rank = RANK[event.action];
  if (rank === undefined) return false;

  const existing = jobs.get(job.id);
  if (existing && rank < existing.rank) {
    return false;
  }

  const fullName = event.repository?.full_name ?? '';
  const [owner = '', repo = ''] = fullName.split('/');

  jobs.set(job.id, {
    job,
    repository: fullName,
    owner,
    repo,
    runUrl: runUrlFor(job, fullName),
    sender: event.sender ? { login: event.sender.login, avatarUrl: event.sender.avatar_url } : null,
    rank,
    updatedAt: Date.now(),
  });

  revision++;
  prune();
  return true;
}

function runUrlFor(job: WorkflowJobPayloadJob, repository: string): string {
  const base = `https://github.com/${repository}/actions/runs/${job.run_id}`;
  return job.run_attempt && job.run_attempt > 1 ? `${base}/attempts/${job.run_attempt}` : base;
}

function prune(): void {
  const now = Date.now();
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  for (const [id, stored] of jobs) {
    const finished = stored.rank === RANK.completed;
    if (finished && now - anchorTime(stored) > maxAgeMs) {
      jobs.delete(id);
    }
  }

  if (jobs.size <= MAX_JOBS) return;

  const byAge = [...jobs.entries()].sort((a, b) => anchorTime(a[1]) - anchorTime(b[1]));
  for (const [id] of byAge.slice(0, jobs.size - MAX_JOBS)) {
    jobs.delete(id);
  }
}

function anchorTime(stored: StoredJob): number {
  const raw = stored.job.completed_at ?? stored.job.started_at ?? stored.job.created_at;
  const parsed = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : stored.updatedAt;
}

function isStuck(stored: StoredJob, now: number): boolean {
  return now - anchorTime(stored) > STUCK_JOB_HOURS * 60 * 60 * 1000;
}

function runContextFor(stored: StoredJob): RunContext {
  const extras = extrasFor(stored.job.run_id);
  return {
    workflowName: stored.job.workflow_name ?? null,
    branch: stored.job.head_branch ?? null,
    actor: extras.actor ?? stored.sender,
    event: extras.event,
    runUrl: stored.runUrl,
  };
}

function confineToKnownPools<T extends { scaleSet: string | null }>(row: T, knownScaleSetSlugs: string[]): T {
  if (row.scaleSet === GITHUB_HOSTED_POOL) {
    return row;
  }
  if (row.scaleSet && !knownScaleSetSlugs.includes(row.scaleSet)) {
    return { ...row, scaleSet: null };
  }
  return row;
}

export interface StoreSnapshot {
  queue: JobQueueItem[];
  running: JobRunningItem[];
  history: JobHistoryItem[];
  incomplete: boolean;
}

export function buildSnapshot(knownScaleSetSlugs: string[]): StoreSnapshot {
  const now = Date.now();
  const queueDrafts: ReturnType<typeof toJobQueueItem>[] = [];
  const running: JobRunningItem[] = [];
  const history: JobHistoryItem[] = [];

  for (const stored of jobs.values()) {
    const context = runContextFor(stored);

    if (stored.rank === RANK.completed) {
      if (stored.job.conclusion !== 'skipped') {
        history.push(
          confineToKnownPools(toJobHistoryItem(stored.job, stored.repository, context, knownScaleSetSlugs), knownScaleSetSlugs)
        );
      }
      continue;
    }

    if (isStuck(stored, now)) continue;

    if (stored.rank === RANK.queued) {
      queueDrafts.push(
        confineToKnownPools(toJobQueueItem(stored.job, stored.repository, context, knownScaleSetSlugs), knownScaleSetSlugs)
      );
    } else if (stored.rank === RANK.in_progress) {
      running.push(
        confineToKnownPools(toJobRunningItem(stored.job, stored.repository, context, knownScaleSetSlugs), knownScaleSetSlugs)
      );
    }
  }

  history.sort(
    (a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime()
  );

  return {
    queue: assignQueuePositions(queueDrafts),
    running: orderRunningJobs(running),
    history,
    incomplete: isIncomplete(),
  };
}

function isIncomplete(): boolean {
  if (!restoreSettled) return true;
  if (restoredAnything) return false;
  return Date.now() - startedAt < WARMUP_MS;
}

export interface PersistedState {
  version: 1;
  savedAt: string;
  jobs: StoredJob[];
}

export function serialize(): PersistedState {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    jobs: [...jobs.values()],
  };
}

export function restore(state: unknown): number {
  restoreSettled = true;

  const rows = (state as PersistedState | null)?.jobs;
  if (!Array.isArray(rows)) {
    restoredAnything = false;
    return 0;
  }

  let accepted = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const stored = row as StoredJob;
    if (typeof stored.job?.id !== 'number' || typeof stored.rank !== 'number') continue;
    if (jobs.has(stored.job.id)) continue;
    jobs.set(stored.job.id, stored);
    accepted++;
  }

  prune();
  revision++;
  restoredAnything = accepted > 0;
  return accepted;
}

export function markRestoreFailed(): void {
  restoreSettled = true;
  restoredAnything = false;
}

export function stats() {
  const now = Date.now();
  let queued = 0;
  let running = 0;
  let finished = 0;
  for (const stored of jobs.values()) {
    if (stored.rank === RANK.completed) finished++;
    else if (isStuck(stored, now)) continue;
    else if (stored.rank === RANK.queued) queued++;
    else if (stored.rank === RANK.in_progress) running++;
  }
  return { total: jobs.size, queued, running, finished, incomplete: isIncomplete() };
}

export function clearJobStore(): void {
  jobs.clear();
  revision = 0;
  restoreSettled = false;
  restoredAnything = false;
  startedAt = Date.now();
}
