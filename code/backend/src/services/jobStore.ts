import type { JobActor, JobHistoryItem, JobQueueItem, JobRunningItem, RunContext } from '../types/github.ts';
import type {
  WorkflowJobAction,
  WorkflowJobEvent,
  WorkflowJobPayloadJob,
  WorkflowRunEvent,
} from '../types/webhook.ts';
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

// A workflow run that failed before any job started (a broken workflow file,
// startup_failure) sends no workflow_job events, so it is kept as its own row.
// Run IDs and job IDs are separate ID spaces, hence a separate map.
export interface StoredRun {
  id: number;
  runAttempt: number;
  name: string | null;
  headBranch: string | null;
  headSha: string | null;
  htmlUrl: string;
  createdAt: string;
  runStartedAt: string | null;
  updatedAt: string;
  conclusion: string;
  event: string | null;
  repository: string;
  headRepository: string | null;
  actor: JobActor | null;
}

const runs = new Map<number, StoredRun>();

const KEEPABLE_RUN_CONCLUSIONS = new Set(['failure', 'startup_failure']);

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

  // Self-correction: a job event for a run we kept as "without jobs" proves
  // the run had jobs after all (the job event arrived after the run event).
  runs.delete(job.run_id);

  revision++;
  prune();
  return true;
}

/**
 * Whether a workflow_run event is one we could keep: a completed run that
 * failed (or failed to start) and that the store has no job rows for.
 *
 * "Has no jobs" is decided in this order:
 *   1. If the store holds any job row with the same run_id, the run has jobs:
 *      ignore it (this function returns false).
 *   2. Otherwise, if GITHUB_TOKEN is set, the webhook route asks GitHub for the
 *      run's jobs (latest attempt) after replying, and keeps the run only if
 *      that returns zero jobs. If the call fails, the run is kept, since step 1
 *      already found no jobs.
 *   3. Without a token, step 1 alone decides.
 *   4. Self-correction: when a workflow_job event is applied for a run_id that
 *      has a run row, `upsert` deletes the run row.
 */
export function isKeepableFailedRun(event: WorkflowRunEvent): boolean {
  if (!event || event.action !== 'completed') return false;
  const run = event.workflow_run;
  if (!run || typeof run.id !== 'number' || !Number.isFinite(run.id)) return false;
  if (!run.conclusion || !KEEPABLE_RUN_CONCLUSIONS.has(run.conclusion)) return false;
  if (typeof event.repository?.full_name !== 'string' || !event.repository.full_name) return false;
  return !hasJobsForRun(run.id);
}

export function hasJobsForRun(runId: number): boolean {
  for (const stored of jobs.values()) {
    if (stored.job.run_id === runId) return true;
  }
  return false;
}

/**
 * Stores the run row. Rechecks step 1 of the rule above, because job events
 * may have arrived while the jobs lookup was in flight. Returns whether a row
 * was stored.
 */
export function keepFailedRun(event: WorkflowRunEvent): boolean {
  if (!isKeepableFailedRun(event)) return false;

  const run = event.workflow_run;
  const runAttempt = typeof run.run_attempt === 'number' ? run.run_attempt : 1;
  const existing = runs.get(run.id);
  if (existing && runAttempt < existing.runAttempt) return false;

  const who = run.triggering_actor ?? run.actor ?? event.sender ?? null;

  runs.set(run.id, {
    id: run.id,
    runAttempt,
    name: run.name ?? null,
    headBranch: run.head_branch ?? null,
    headSha: run.head_sha ?? null,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    runStartedAt: run.run_started_at ?? null,
    updatedAt: run.updated_at,
    conclusion: run.conclusion as string,
    event: run.event ?? null,
    repository: event.repository.full_name,
    headRepository: run.head_repository?.full_name ?? null,
    actor: who ? { login: who.login, avatarUrl: who.avatar_url } : null,
  });

  revision++;
  prune();
  return true;
}

/**
 * The stored job with this ID when it completed with conclusion failure, else
 * null. Debug it reads its targets only from these signed webhook records.
 */
export function getFailedJob(id: number): StoredJob | null {
  const stored = jobs.get(id);
  if (!stored || stored.rank !== RANK.completed || stored.job.conclusion !== 'failure') return null;
  return stored;
}

/** The stored failed run without jobs with this ID, else null. */
export function getFailedRun(id: number): StoredRun | null {
  return runs.get(id) ?? null;
}

function runUrlFor(job: WorkflowJobPayloadJob, repository: string): string {
  const base = `https://github.com/${repository}/actions/runs/${job.run_id}`;
  return job.run_attempt && job.run_attempt > 1 ? `${base}/attempts/${job.run_attempt}` : base;
}

function prune(): void {
  pruneRuns();
  pruneJobs();
}

function pruneJobs(): void {
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

function pruneRuns(): void {
  const now = Date.now();
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  for (const [id, stored] of runs) {
    if (now - runAnchorTime(stored) > maxAgeMs) {
      runs.delete(id);
    }
  }

  if (runs.size <= MAX_JOBS) return;

  const byAge = [...runs.entries()].sort((a, b) => runAnchorTime(a[1]) - runAnchorTime(b[1]));
  for (const [id] of byAge.slice(0, runs.size - MAX_JOBS)) {
    runs.delete(id);
  }
}

function runAnchorTime(stored: StoredRun): number {
  const parsed = new Date(stored.updatedAt ?? stored.createdAt).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function toRunHistoryItem(stored: StoredRun): JobHistoryItem {
  return {
    id: stored.id,
    name: stored.name ?? '',
    workflowName: stored.name,
    branch: stored.headBranch,
    actor: stored.actor,
    event: stored.event,
    repository: stored.repository,
    repositoryUrl: `https://github.com/${stored.repository}`,
    result: 'failure',
    runnerName: null,
    scaleSet: null,
    createdAt: stored.createdAt,
    startedAt: stored.runStartedAt ?? null,
    completedAt: stored.updatedAt,
    durationMs: null,
    htmlUrl: stored.htmlUrl,
    runUrl: stored.htmlUrl,
    target: { kind: 'run', id: stored.id },
  };
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

  for (const stored of runs.values()) {
    history.push(toRunHistoryItem(stored));
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
  runs?: StoredRun[];
}

export function serialize(): PersistedState {
  const state: PersistedState = {
    version: 1,
    savedAt: new Date().toISOString(),
    jobs: [...jobs.values()],
  };
  // Only written when there are run rows, so a job-only stream persists exactly as 1.x.
  if (runs.size > 0) state.runs = [...runs.values()];
  return state;
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
    runs.delete(stored.job.run_id);
    accepted++;
  }

  // A snapshot written before run rows existed has no `runs` field.
  let acceptedRuns = 0;
  const runRows = (state as PersistedState).runs;
  if (Array.isArray(runRows)) {
    for (const row of runRows) {
      if (!row || typeof row !== 'object') continue;
      const stored = row as StoredRun;
      if (typeof stored.id !== 'number' || typeof stored.repository !== 'string') continue;
      if (typeof stored.htmlUrl !== 'string' || typeof stored.createdAt !== 'string') continue;
      if (typeof stored.updatedAt !== 'string') continue;
      if (runs.has(stored.id)) continue;
      // A job row (live or restored) for this run means it had jobs.
      if (hasJobsForRun(stored.id)) continue;
      runs.set(stored.id, stored);
      acceptedRuns++;
    }
  }

  prune();
  revision++;
  restoredAnything = accepted + acceptedRuns > 0;
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
  runs.clear();
  revision = 0;
  restoreSettled = false;
  restoredAnything = false;
  startedAt = Date.now();
}
