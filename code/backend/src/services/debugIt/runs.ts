// Debug it runs, start and view (story 3.7, FR7, AD-4, AD-13). A run starts
// on a failed job or a failed workflow run without jobs. The target is read
// only from the signed webhook store and the head repository from GitHub;
// nothing in the request body reaches the record. Every start check refuses
// with one sentence, writing nothing. An accepted run is counted first, by a
// conditional write of usage/{YYYY-MM}/{githubUserId}.json, and then created
// as runs/{runId}.json in state waiting.
//
// The target-to-run map and the per-target locks live in memory: this pod is
// the single owner (AD-4). The run lifecycle (story 3.10, lifecycle.ts)
// listens through onRunCreated, moves runs out of waiting, and rebuilds the
// map from runs/ at startup through trackRun. startedRunIds() names the runs
// this process generated, so the lifecycle's orphan usage cleanup never
// touches a start in flight (usage is written before the run record).
//
// A second in-memory map keeps each requester's latest run of every target, in any state
// (story 3.11): start sets it, trackRun updates it (final states included),
// the lifecycle feeds it every record at recovery and calls forgetRun when
// retention deletes a record. latestRunsOf answers the listing route, so a
// requester finds their run again from the Recent history row.
//
// The result view and feedback (story 3.12): resultView reads the stored
// result, downloads, skipped repositories and feedback field by field, so a
// malformed record can never break the answer or leak an extra field.
// saveFeedback lets the requester rate a run that has a result, with one
// conditional write that sets only the feedback field. The comment and the
// result text are never logged.
//
// The usage view (story 3.13): monthUsage reads only the current UTC
// month's usage objects and answers one row per user; it never reads a run
// record and never writes.
//
// The patch check (story 4.1): resultView also answers patchCheck, computed
// on every read by validatePatch (patchValidation.ts) from the stored patch,
// the downloads and the patch size limit. Nothing about it is stored.
//
// Fix pull requests in the result view (story 4.3): resultView answers the
// opened fix pull requests read field by field and an empty
// canOpenPullRequest; the result routes fill the offers for the viewer.
import { randomUUID } from 'crypto';
import { getS3Store, S3StoreError, type S3Store } from '../../adapters/s3Store.ts';
import { getGitHubApp, GitHubAppError, type GitHubApp, type WorkflowRunInfo } from '../../adapters/githubApp.ts';
import { debugItConfig, type DebugItConfig } from '../debugItConfig.ts';
import { getFailedJob, getFailedRun } from '../jobStore.ts';
import { mockDebugTarget } from '../mockData.ts';
import { loadContextFile } from './contextFile.ts';
import { getIsolationGate, ISOLATION_REASONS, type IsolationStatus } from './isolation.ts';
import { getSettingsService, type SettingsService } from './settings.ts';
import type { CauseLocation } from './resultSchema.ts';
import { patchCheckView, validatePatch, type PatchCheckView } from './patchValidation.ts';
import { getPersonalKeyService, type PersonalKeyService } from './personalKeys.ts';

type Env = Record<string, string | undefined>;

export type RunState = 'waiting' | 'cloning' | 'analyzing' | 'finished' | 'failed';
export type TargetKind = 'job' | 'run';

/** States in which a run holds its target: a second click opens it. */
export const ACTIVE_STATES: ReadonlySet<RunState> = new Set<RunState>(['waiting', 'cloning', 'analyzing']);
const FINAL_STATES: ReadonlySet<RunState> = new Set<RunState>(['finished', 'failed']);

export interface RunTarget {
  kind: TargetKind;
  id: number;
}

export interface RunDownload {
  repository: string;
  commitSha: string;
  folder: string;
}

export interface RunRecord {
  runId: string;
  target: RunTarget;
  requester: { githubUserId: number; login: string };
  state: RunState;
  createdAt: string;
  updatedAt: string;
  repository: string;
  headRepository: string | null;
  headSha: string | null;
  branch: string | null;
  jobName: string;
  downloads: RunDownload[];
  usageKey: string;
  resultCodeHash: string | null;
  result: unknown;
  feedback: unknown;
  fixPullRequests: unknown[];
  failureReason: string | null;
  /** Extra repositories named in the context file but not downloaded, with why (story 3.8). */
  skippedRepositories?: Array<{ repository: string; reason: string }>;
  /** Whether the log sent to the Debug Job was cut to its last part (story 3.8). */
  logTruncated?: boolean;
  /** Wrong result codes posted to the results port so far (story 3.9). */
  wrongResultCodes?: number;
  /** When the Debug Job must stop, as ISO 8601 UTC; set when the run leaves waiting (story 3.10). */
  deadlineAt?: string | null;
}

/** What the API answers about a run. */
export interface RunView {
  runId: string;
  target: RunTarget;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  elapsedMs: number;
  repository: string;
  jobName: string;
  /** Why a failed run failed: a fixed sentence set by the lifecycle, never secret; null otherwise. */
  failureReason: string | null;
}

export type FeedbackRating = 'useful' | 'not-useful';
export type ResultFailureReason = 'none' | 'time-limit' | 'spend-limit' | 'error';

/** The result fields the API answers, read defensively from the stored result. */
export interface RunResult {
  explanation: string;
  causeLocation: CauseLocation;
  patch: string;
  costUsd: number;
  durationMs: number;
  logTruncated: boolean;
  failureReason: ResultFailureReason;
}

/** The feedback field of a run record (story 3.12). */
export interface StoredFeedback {
  rating: FeedbackRating;
  comment: string | null;
  at: string;
  githubUserId: number;
}

/** What GET /debug-it/runs/{runId}/result answers. */
export interface RunResultView {
  run: RunView;
  result: RunResult | null;
  downloads: RunDownload[];
  skippedRepositories: Array<{ repository: string; reason: string }>;
  feedback: { rating: FeedbackRating; comment: string | null; at: string } | null;
  canGiveFeedback: boolean;
  /** Whether the patch may become fix pull requests (story 4.1); null when there is no result. */
  patchCheck: PatchCheckView | null;
  /** The fix pull requests already opened for this run (story 4.3), read field by field from the record. */
  fixPullRequests: RunFixPullRequest[];
  /**
   * The download repositories (stored spelling) for which this viewer is
   * offered Open a PR (story 4.3). resultView answers []; the route fills it.
   */
  canOpenPullRequest: string[];
}

/** One opened fix pull request of a run (story 4.3). */
export interface RunFixPullRequest {
  repository: string;
  url: string;
}

export interface FeedbackInput {
  rating: FeedbackRating;
  comment: string | null;
}

/** The longest feedback comment, in characters. */
export const FEEDBACK_COMMENT_MAX = 2000;

/** A start target, read only from the signed webhook store. */
export interface ResolvedTarget extends RunTarget {
  repository: string;
  jobName: string;
  headSha: string | null;
  branch: string | null;
  /** The workflow run to read the head repository from. */
  workflowRunId: number;
}

export interface UsageEntry {
  runId: string;
  costUsd: number;
  fixPullRequests: number;
}

export interface UsageRecord {
  entries: UsageEntry[];
}

/** One user's usage in a month, read only from their usage object (story 3.13). */
export interface UsageRow {
  githubUserId: number;
  runs: number;
  costUsd: number;
  fixPullRequests: number;
}

/** The usage of the current UTC month, before logins are added (story 3.13). */
export interface UsageView {
  month: string;
  credentialsMode: DebugItConfig['credentialsMode'];
  /** The monthly run cap per user in organization mode; null in personal mode. */
  monthlyCap: number | null;
  users: UsageRow[];
}

export type UsageOutcome = { ok: true; view: UsageView } | { ok: false; status: 503; error: string };

export const RUN_ERRORS = {
  targetNotFound: 'This failed job or run was not found.',
  runNotFound: 'This debug run was not found.',
  inProgressJob: 'A debug run is already in progress for this job.',
  inProgressRun: 'A debug run is already in progress for this workflow run.',
  s3: 'S3 cannot be reached, so Debug it cannot start a run right now.',
  s3Read: 'S3 cannot be reached, so this debug run cannot be read right now.',
  s3Feedback: 'S3 cannot be reached, so your rating cannot be saved right now.',
  s3Usage: 'S3 cannot be reached, so Debug it usage cannot be read right now.',
  feedbackRating: 'Choose Useful or Not useful to rate this result.',
  feedbackComment: `The comment must be text of at most ${FEEDBACK_COMMENT_MAX} characters.`,
  feedbackNotRequester: 'Only the person who started this debug run can rate its result.',
  feedbackNoResult: 'This debug run has no result to rate yet.',
  github: 'GitHub could not be reached to check this repository; please try again.',
  noPersonalKey: 'You have not saved a personal Anthropic API key.',
  personalKeyUnreadable: 'Your saved personal Anthropic API key cannot be read; please save it again.',
  spendLimit: (reset: string): string =>
    `The organization has reached its Debug it spend limit for this month; runs start again on ${reset} (UTC).`,
  cap: (cap: number, reset: string): string =>
    `You have used all ${cap} debug runs for this month; your runs reset on ${reset} (UTC).`,
} as const;

/** The UTC month of `date`, as YYYY-MM. */
export function usageMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The first day of the UTC month after `date`, as YYYY-MM-DD. */
export function resetDate(date: Date): string {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

/** The usage object of one user in the month of `date`, relative to debug-it/. */
export function usageKey(date: Date, githubUserId: number): string {
  return `usage/${usageMonth(date)}/${githubUserId}.json`;
}

export function runKey(runId: string): string {
  return `runs/${runId}.json`;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `value` is a run ID in the form crypto.randomUUID() makes. */
export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID.test(value);
}

function positiveId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = (value as { entries?: unknown }).entries;
  return (
    Array.isArray(entries) &&
    entries.every(
      (e) =>
        e !== null &&
        typeof e === 'object' &&
        typeof (e as UsageEntry).runId === 'string' &&
        typeof (e as UsageEntry).costUsd === 'number' &&
        Number.isFinite((e as UsageEntry).costUsd),
    )
  );
}

const STATES: ReadonlySet<string> = new Set(['waiting', 'cloning', 'analyzing', 'finished', 'failed']);

export function isRunRecord(value: unknown, runId: string): value is RunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<RunRecord>;
  return (
    r.runId === runId &&
    typeof r.state === 'string' &&
    STATES.has(r.state) &&
    typeof r.repository === 'string' &&
    r.repository !== '' &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string' &&
    !!r.target &&
    (r.target.kind === 'job' || r.target.kind === 'run') &&
    typeof r.target.id === 'number' &&
    Array.isArray(r.downloads) &&
    r.downloads.every((d) => !!d && typeof d === 'object' && typeof d.repository === 'string' && d.repository !== '')
  );
}

/** Every repository a viewer needs read access to: the downloads plus the run's repository. */
export function runRepositories(record: Pick<RunRecord, 'repository' | 'downloads'>): string[] {
  return [...new Set([...record.downloads.map((d) => d.repository), record.repository])];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a run record holds a result (an object). */
export function hasResult(record: Pick<RunRecord, 'result'>): boolean {
  return isObject(record.result);
}

const SIMPLE_CAUSES: ReadonlySet<string> = new Set(['this-repository', 'workflow-file', 'runner', 'infrastructure', 'unknown']);
const RESULT_FAILURE_REASONS: ReadonlySet<string> = new Set(['none', 'time-limit', 'spend-limit', 'error']);

function readCause(value: unknown): CauseLocation {
  if (!isObject(value) || typeof value.kind !== 'string') return { kind: 'unknown' };
  if (value.kind === 'extra-repository') {
    return typeof value.repository === 'string' && value.repository !== ''
      ? { kind: 'extra-repository', repository: value.repository }
      : { kind: 'unknown' };
  }
  return SIMPLE_CAUSES.has(value.kind) ? ({ kind: value.kind } as CauseLocation) : { kind: 'unknown' };
}

const nonNegative = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** The stored result, field by field; null when the record holds no object result. */
export function readRunResult(value: unknown): RunResult | null {
  if (!isObject(value)) return null;
  return {
    explanation: typeof value.explanation === 'string' ? value.explanation : '',
    causeLocation: readCause(value.causeLocation),
    patch: typeof value.patch === 'string' ? value.patch : '',
    costUsd: nonNegative(value.costUsd),
    durationMs: nonNegative(value.durationMs),
    logTruncated: value.logTruncated === true,
    failureReason:
      typeof value.failureReason === 'string' && RESULT_FAILURE_REASONS.has(value.failureReason)
        ? (value.failureReason as ResultFailureReason)
        : 'error',
  };
}

function readFeedback(value: unknown): RunResultView['feedback'] {
  if (!isObject(value)) return null;
  if (value.rating !== 'useful' && value.rating !== 'not-useful') return null;
  if (typeof value.at !== 'string') return null;
  return {
    rating: value.rating,
    comment: typeof value.comment === 'string' && value.comment !== '' ? value.comment : null,
    at: value.at,
  };
}

export function readDownloads(value: unknown): RunDownload[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).flatMap((d) =>
    typeof d.repository === 'string' && d.repository !== ''
      ? [
          {
            repository: d.repository,
            commitSha: typeof d.commitSha === 'string' ? d.commitSha : '',
            folder: typeof d.folder === 'string' ? d.folder : '',
          },
        ]
      : [],
  );
}

/**
 * The stored fix pull requests of a run, field by field (story 4.3): only a
 * string repository and a string URL starting with https://github.com/.
 */
export function readFixPullRequests(value: unknown): RunFixPullRequest[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).flatMap((e) =>
    typeof e.repository === 'string' &&
    e.repository !== '' &&
    typeof e.url === 'string' &&
    e.url.startsWith('https://github.com/')
      ? [{ repository: e.repository, url: e.url }]
      : [],
  );
}

function readSkipped(value: unknown): RunResultView['skippedRepositories'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).flatMap((s) =>
    typeof s.repository === 'string' && s.repository !== ''
      ? [{ repository: s.repository, reason: typeof s.reason === 'string' ? s.reason : '' }]
      : [],
  );
}

/** Checks a feedback body: a rating and an optional comment (trimmed, empty is null). */
export function parseFeedback(body: unknown): { ok: true; input: FeedbackInput } | { ok: false; error: string } {
  if (!isObject(body) || (body.rating !== 'useful' && body.rating !== 'not-useful')) {
    return { ok: false, error: RUN_ERRORS.feedbackRating };
  }
  const raw = body.comment;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return { ok: false, error: RUN_ERRORS.feedbackComment };
  const comment = typeof raw === 'string' ? raw.trim() : '';
  if (comment.length > FEEDBACK_COMMENT_MAX) return { ok: false, error: RUN_ERRORS.feedbackComment };
  return { ok: true, input: { rating: body.rating, comment: comment === '' ? null : comment } };
}

function copyRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    target: { ...record.target },
    requester: { ...record.requester },
    downloads: record.downloads.map((d) => ({ ...d })),
    fixPullRequests: Array.isArray(record.fixPullRequests) ? [...record.fixPullRequests] : [],
  };
}

function errorText(error: unknown): string {
  return error instanceof S3StoreError ? error.message : 'unknown error';
}

export type StartOutcome =
  | { status: 201; body: RunView }
  | { status: 200; body: RunView & { existing: true } }
  | { status: 409 | 429 | 502 | 503; body: { error: string } };

export type LoadOutcome = { ok: true; record: RunRecord } | { ok: false; status: 404 | 503; error: string };

export type FeedbackOutcome =
  | { ok: true; record: RunRecord }
  | { ok: false; status: 403 | 404 | 409 | 503; error: string };

export interface RunService {
  /** The failed job or run named by the route params, or null (unknown, not failed, bad kind or ID). */
  findTarget(kind: unknown, id: unknown): ResolvedTarget | null;
  /** Runs every start check after the check chain and starts the run, or refuses. */
  start(target: ResolvedTarget, user: { githubUserId: number; login: string }): Promise<StartOutcome>;
  /** Reads a run record by ID. */
  load(runId: unknown): Promise<LoadOutcome>;
  view(record: RunRecord): RunView;
  /** The result view of a run for one viewer (story 3.12); only the requester may rate it. */
  resultView(record: RunRecord, viewerGithubUserId: number): RunResultView;
  /**
   * Saves the requester's rating of a run with a result, replacing an earlier
   * one, by a conditional write that sets only the feedback field.
   */
  saveFeedback(runId: string, user: { githubUserId: number }, input: FeedbackInput): Promise<FeedbackOutcome>;
  /**
   * Records the latest copy of a run in the target-to-run map; the lifecycle
   * (story 3.10) calls it on every state change. A run in a final state
   * releases its target.
   */
  trackRun(record: RunRecord): void;
  /**
   * The latest run of every target whose requester is this GitHub user, in
   * any state, as copies. Only the newest run of a target is kept.
   */
  latestRunsOf(githubUserId: number): RunRecord[];
  /** Forgets a run whose record was deleted (retention). */
  forgetRun(runId: string): void;
  /**
   * Adds a listener called with a copy of each run record that start()
   * created, after it is created and tracked. A throwing listener is logged
   * and does not change the answer.
   */
  onRunCreated(listener: (record: RunRecord) => void): void;
  /** The IDs of every run this process generated, added before its usage write. */
  startedRunIds(): ReadonlySet<string>;
  /**
   * One row per usage object of the current UTC month (story 3.13). Reads
   * only usage/{month}/, never a run record, and writes nothing.
   */
  monthUsage(): Promise<UsageOutcome>;
}

export interface RunServiceOptions {
  store: S3Store | (() => S3Store);
  githubApp: GitHubApp | (() => GitHubApp);
  config: Pick<DebugItConfig, 'monthlyCap' | 'credentialsMode' | 'limits'>;
  isolation: { status(): IsolationStatus };
  organization: string;
  /**
   * The allowed lists: a second click opens a run only when every one of its
   * repositories is still allowed, as viewing it requires. Without it only
   * read access is checked.
   */
  settings?: Pick<SettingsService, 'load' | 'isRepositoryAllowed'>;
  now?: () => Date;
  newRunId?: () => string;
  /**
   * Demo mode only (story 3.14): resolves a target from the mock data when the
   * webhook store has none. Unset in real mode.
   */
  mockTargets?: (kind: TargetKind, id: number) => ResolvedTarget | null;
  /**
   * Personal key mode (story 5.1): the key store, read to check the requester
   * has a readable key. Without it every personal-mode start is refused.
   */
  personalKeys?: Pick<PersonalKeyService, 'keyFor'> | (() => Pick<PersonalKeyService, 'keyFor'>);
}

export function createRunService(options: RunServiceOptions): RunService {
  const { config, isolation, organization } = options;
  const store = (): S3Store => (typeof options.store === 'function' ? options.store() : options.store);
  const github = (): GitHubApp => (typeof options.githubApp === 'function' ? options.githubApp() : options.githubApp);
  const now = options.now ?? (() => new Date());
  const newRunId = options.newRunId ?? (() => randomUUID());
  // Target key ("job:123") to the run holding it.
  const targets = new Map<string, RunRecord>();
  // Requester and target key ("1000001:job:123") to that user's latest run in any state (story 3.11).
  const latest = new Map<string, RunRecord>();
  // Target key to the tail of its start queue.
  const locks = new Map<string, Promise<void>>();
  const listeners: Array<(record: RunRecord) => void> = [];
  const started = new Set<string>();

  const targetKey = (t: RunTarget): string => `${t.kind}:${t.id}`;

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    locks.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  function view(record: RunRecord): RunView {
    const created = new Date(record.createdAt).getTime();
    const end = FINAL_STATES.has(record.state) ? new Date(record.updatedAt).getTime() : now().getTime();
    const elapsed = end - created;
    return {
      runId: record.runId,
      target: { kind: record.target.kind, id: record.target.id },
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      elapsedMs: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0,
      repository: record.repository,
      jobName: record.jobName,
      failureReason: typeof record.failureReason === 'string' && record.failureReason !== '' ? record.failureReason : null,
    };
  }

  function resultView(record: RunRecord, viewerGithubUserId: number): RunResultView {
    const result = readRunResult(record.result);
    const downloads = readDownloads(record.downloads);
    return {
      run: view(record),
      result,
      downloads,
      skippedRepositories: readSkipped(record.skippedRepositories),
      feedback: readFeedback(record.feedback),
      canGiveFeedback: result !== null && record.requester?.githubUserId === viewerGithubUserId,
      // Computed on read, never stored or logged.
      patchCheck:
        result === null ? null : patchCheckView(validatePatch(result.patch, downloads, config.limits.patchLimitBytes)),
      fixPullRequests: readFixPullRequests(record.fixPullRequests),
      // The route fills the offers; they need settings and GitHub lookups.
      canOpenPullRequest: [],
    };
  }

  async function saveFeedback(
    runId: string,
    user: { githubUserId: number },
    input: FeedbackInput,
  ): Promise<FeedbackOutcome> {
    if (!isRunId(runId)) return { ok: false, status: 404, error: RUN_ERRORS.runNotFound };
    let refusal: FeedbackOutcome | null = null;
    let stored: unknown;
    try {
      stored = await store().modify<unknown>(runKey(runId), (current) => {
        refusal = null;
        if (current === null) {
          refusal = { ok: false, status: 404, error: RUN_ERRORS.runNotFound };
          return undefined;
        }
        if (!isRunRecord(current, runId)) {
          console.error(`[ERROR] Debug it run ${runId} has a malformed record.`);
          refusal = { ok: false, status: 503, error: RUN_ERRORS.s3Read };
          return undefined;
        }
        if (current.requester?.githubUserId !== user.githubUserId) {
          refusal = { ok: false, status: 403, error: RUN_ERRORS.feedbackNotRequester };
          return undefined;
        }
        if (!hasResult(current)) {
          refusal = { ok: false, status: 409, error: RUN_ERRORS.feedbackNoResult };
          return undefined;
        }
        const feedback: StoredFeedback = {
          rating: input.rating,
          comment: input.comment,
          at: now().toISOString(),
          githubUserId: user.githubUserId,
        };
        return { ...current, feedback };
      });
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId}: the rating could not be saved: ${errorText(error)}`);
      return { ok: false, status: 503, error: RUN_ERRORS.s3Feedback };
    }
    if (refusal) return refusal;
    if (!isRunRecord(stored, runId)) return { ok: false, status: 503, error: RUN_ERRORS.s3Feedback };
    console.log(`[AUDIT] Debug it run ${runId} rated ${input.rating} by GitHub user ${user.githubUserId}`);
    return { ok: true, record: stored };
  }

  // Keeps the newest run per requester and target; the same run replaces its older copy.
  function remember(record: RunRecord): void {
    const key = `${record.requester?.githubUserId}:${targetKey(record.target)}`;
    const current = latest.get(key);
    if (current && current.runId !== record.runId) {
      const known = Date.parse(current.createdAt);
      const incoming = Date.parse(record.createdAt);
      if (Number.isFinite(known) && (!Number.isFinite(incoming) || incoming < known)) return;
    }
    latest.set(key, copyRecord(record));
  }

  function findTarget(kind: unknown, id: unknown): ResolvedTarget | null {
    const numeric = positiveId(id);
    if (numeric === null) return null;
    const found = findStoredTarget(kind, numeric);
    if (found || !options.mockTargets || (kind !== 'job' && kind !== 'run')) return found;
    return options.mockTargets(kind, numeric);
  }

  function findStoredTarget(kind: unknown, numeric: number): ResolvedTarget | null {
    if (kind === 'job') {
      const stored = getFailedJob(numeric);
      if (!stored || !stored.repository) return null;
      return {
        kind: 'job',
        id: numeric,
        repository: stored.repository,
        jobName: stored.job.name ?? '',
        headSha: stored.job.head_sha || null,
        branch: stored.job.head_branch ?? null,
        workflowRunId: stored.job.run_id,
      };
    }
    if (kind === 'run') {
      const stored = getFailedRun(numeric);
      if (!stored || !stored.repository) return null;
      return {
        kind: 'run',
        id: numeric,
        repository: stored.repository,
        jobName: stored.name ?? '',
        headSha: stored.headSha,
        branch: stored.headBranch,
        workflowRunId: stored.id,
      };
    }
    return null;
  }

  // Whether every repository is still on the allowed list; a settings read failure throws.
  async function allAllowed(repositories: string[]): Promise<boolean> {
    const settings = options.settings;
    if (!settings) return true;
    const current = await settings.load();
    return repositories.length > 0 && repositories.every((r) => settings.isRepositoryAllowed(current, r));
  }

  // Whether the user can read every repository; a GitHub failure throws.
  async function canReadAll(user: { githubUserId: number; login: string }, repositories: string[]): Promise<boolean> {
    for (const repository of repositories) {
      const level = await github().checkPermission(user, repository);
      if (level !== 'read' && level !== 'write') return false;
    }
    return true;
  }

  const refuse = (status: 409 | 429 | 502 | 503, error: string): StartOutcome => ({ status, body: { error } });

  function s3Failed(error: unknown, what: string): StartOutcome {
    console.error(`[ERROR] Debug it run could not start (${what}): ${errorText(error)}`);
    return refuse(503, RUN_ERRORS.s3);
  }

  function githubFailed(error: unknown, what: string): StartOutcome {
    // GitHubAppError messages are built to hold no token; any other error text is not logged.
    const detail = error instanceof GitHubAppError ? error.message : 'unknown error';
    console.error(`[ERROR] Debug it run could not start (${what}): ${detail}`);
    return refuse(502, RUN_ERRORS.github);
  }

  // Sum of costUsd across every usage object of the month; throws on any S3 failure.
  // A malformed record is skipped with one error line, so it cannot block every start.
  async function monthSpend(month: string): Promise<number> {
    const keys = await store().list(`usage/${month}/`);
    let total = 0;
    for (const key of keys) {
      const stored = await store().read<unknown>(key);
      if (!stored) continue;
      if (!isUsageRecord(stored.value)) {
        console.error(`[ERROR] Debug it usage record ${key} is malformed; it is left out of the spend sum.`);
        continue;
      }
      for (const entry of stored.value.entries) total += entry.costUsd;
    }
    return total;
  }

  const USAGE_FILE = /^([1-9]\d*)\.json$/;
  const countOf = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

  async function monthUsage(): Promise<UsageOutcome> {
    const month = usageMonth(now());
    const prefix = `usage/${month}/`;
    const users: UsageRow[] = [];
    try {
      const keys = await store().list(prefix);
      for (const key of keys) {
        const match = key.startsWith(prefix) ? USAGE_FILE.exec(key.slice(prefix.length)) : null;
        const githubUserId = match ? Number(match[1]) : NaN;
        if (!match || !Number.isSafeInteger(githubUserId)) {
          console.error(`[ERROR] Debug it usage key ${key} is not a user usage object; it is left out of the usage view.`);
          continue;
        }
        const stored = await store().read<unknown>(key);
        if (!stored) continue;
        if (!isUsageRecord(stored.value)) {
          console.error(`[ERROR] Debug it usage record ${key} is malformed; it is left out of the usage view.`);
          continue;
        }
        const entries = stored.value.entries;
        users.push({
          githubUserId,
          runs: entries.length,
          costUsd: entries.reduce((sum, e) => sum + e.costUsd, 0),
          fixPullRequests: entries.reduce((sum, e) => sum + countOf(e.fixPullRequests), 0),
        });
      }
    } catch (error) {
      console.error(`[ERROR] Debug it usage could not be read: ${errorText(error)}`);
      return { ok: false, status: 503, error: RUN_ERRORS.s3Usage };
    }
    users.sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs || a.githubUserId - b.githubUserId);
    return {
      ok: true,
      view: {
        month,
        credentialsMode: config.credentialsMode,
        monthlyCap: config.credentialsMode === 'organization' ? config.monthlyCap : null,
        users,
      },
    };
  }

  async function giveBack(key: string, runId: string): Promise<void> {
    try {
      await store().modify<UsageRecord>(key, (current) => {
        if (!isUsageRecord(current) || !current.entries.some((e) => e.runId === runId)) return undefined;
        return { ...current, entries: current.entries.filter((e) => e.runId !== runId) };
      });
    } catch (error) {
      console.error(`[ERROR] Debug it usage entry of run ${runId} could not be removed: ${errorText(error)}`);
    }
  }

  async function startLocked(target: ResolvedTarget, user: { githubUserId: number; login: string }): Promise<StartOutcome> {
    // 1. The startup isolation check must have passed.
    const gate = isolation.status();
    if (gate.state !== 'on') return refuse(503, gate.reason ?? ISOLATION_REASONS.checking);

    // 2. A run in progress on this target answers instead of a new one.
    const existing = targets.get(targetKey(target));
    if (existing && ACTIVE_STATES.has(existing.state)) {
      const repositories = runRepositories(existing);
      let allowed: boolean;
      try {
        allowed = await allAllowed(repositories);
      } catch {
        console.error('[ERROR] Debug it run could not start (settings): Debug it settings could not be read.');
        return refuse(503, RUN_ERRORS.s3);
      }
      let readable = false;
      if (allowed) {
        try {
          readable = await canReadAll(user, repositories);
        } catch (error) {
          return githubFailed(error, 'repository permission');
        }
      }
      if (!readable) return refuse(409, target.kind === 'job' ? RUN_ERRORS.inProgressJob : RUN_ERRORS.inProgressRun);
      return { status: 200, body: { ...view(existing), existing: true } };
    }

    // 3. S3 must answer.
    try {
      await store().checkReachable();
    } catch (error) {
      return s3Failed(error, 'S3 check');
    }

    // 4. The repository must opt in with a debug context file.
    try {
      const context = await loadContextFile(github(), target.repository, organization);
      if (!context.ok) return refuse(409, context.reason);
    } catch (error) {
      return githubFailed(error, 'debug context file');
    }

    // 5. Personal key mode: the requester must have a readable saved key.
    // The key itself is read again only when the run leaves waiting.
    if (config.credentialsMode === 'personal') {
      if (!options.personalKeys) return refuse(409, RUN_ERRORS.noPersonalKey);
      let found: 'saved' | 'none' | 'unreadable';
      try {
        const keys = typeof options.personalKeys === 'function' ? options.personalKeys() : options.personalKeys;
        found = (await keys.keyFor(user.githubUserId)).status;
      } catch (error) {
        return s3Failed(error, 'personal key');
      }
      if (found === 'none') return refuse(409, RUN_ERRORS.noPersonalKey);
      if (found === 'unreadable') return refuse(409, RUN_ERRORS.personalKeyUnreadable);
    }

    const at = now();
    const month = usageMonth(at);
    const reset = resetDate(at);

    // 6. The organization spend limit, when set.
    const spendLimit = config.limits.organizationMonthlySpendLimitUsd;
    if (spendLimit > 0) {
      let spent: number;
      try {
        spent = await monthSpend(month);
      } catch (error) {
        return s3Failed(error, 'spend limit');
      }
      if (spent >= spendLimit) return refuse(429, RUN_ERRORS.spendLimit(reset));
    }

    // 7. The head repository, from GitHub.
    let workflowRun: WorkflowRunInfo;
    try {
      workflowRun = await github().readWorkflowRun(target.repository, target.workflowRunId);
    } catch (error) {
      return githubFailed(error, 'workflow run');
    }

    // 8. Count the run, unless the user is at the cap.
    const runId = newRunId();
    started.add(runId);
    const key = usageKey(at, user.githubUserId);
    let counted = 'added' as 'added' | 'cap' | 'malformed';
    try {
      await store().modify<UsageRecord>(key, (current) => {
        if (current !== null && !isUsageRecord(current)) {
          counted = 'malformed';
          return undefined;
        }
        const entries = current?.entries ?? [];
        if (config.credentialsMode === 'organization' && entries.length >= config.monthlyCap) {
          counted = 'cap';
          return undefined;
        }
        counted = 'added';
        return { ...(current ?? {}), entries: [...entries, { runId, costUsd: 0, fixPullRequests: 0 }] };
      });
    } catch (error) {
      // The conditional write may have landed with its answer lost: give back, idempotently.
      await giveBack(key, runId);
      return s3Failed(error, 'usage count');
    }
    if (counted === 'malformed') {
      return s3Failed(new S3StoreError('failed', `The Debug it usage record ${key} is malformed.`, key), 'usage count');
    }
    if (counted === 'cap') return refuse(429, RUN_ERRORS.cap(config.monthlyCap, reset));

    // 9. Create the run record; on failure give the count back.
    const time = at.toISOString();
    const record: RunRecord = {
      runId,
      target: { kind: target.kind, id: target.id },
      requester: { githubUserId: user.githubUserId, login: user.login },
      state: 'waiting',
      createdAt: time,
      updatedAt: time,
      repository: target.repository,
      headRepository: workflowRun.headRepository,
      // Commit and branch come only from the signed webhook record.
      headSha: target.headSha,
      branch: target.branch,
      jobName: target.jobName,
      downloads: [],
      usageKey: key,
      resultCodeHash: null,
      result: null,
      feedback: null,
      fixPullRequests: [],
      failureReason: null,
    };
    try {
      await store().create(runKey(runId), record);
    } catch (error) {
      // The create may have landed with its answer lost: then the run exists and keeps its count.
      let landed = false;
      try {
        const stored = await store().read<Partial<RunRecord>>(runKey(runId));
        landed = stored !== null && stored.value?.runId === runId;
      } catch {
        landed = false;
      }
      if (!landed) {
        await giveBack(key, runId);
        return s3Failed(error, 'run record');
      }
    }

    targets.set(targetKey(target), record);
    remember(record);
    console.log(
      `[AUDIT] Debug it run ${runId} accepted for ${target.kind} ${target.id} in ${target.repository} by GitHub user ${user.githubUserId}`,
    );
    for (const listener of listeners) {
      try {
        listener(copyRecord(record));
      } catch {
        console.error(`[ERROR] Debug it run ${runId}: a run created listener failed.`);
      }
    }
    return { status: 201, body: view(record) };
  }

  function trackRun(record: RunRecord): void {
    const key = targetKey(record.target);
    const current = targets.get(key);
    if (ACTIVE_STATES.has(record.state)) {
      targets.set(key, copyRecord(record));
    } else if (current && current.runId === record.runId) {
      targets.delete(key);
    }
    remember(record);
  }

  function latestRunsOf(githubUserId: number): RunRecord[] {
    const mine: RunRecord[] = [];
    for (const record of latest.values()) {
      if (record.requester?.githubUserId === githubUserId) mine.push(copyRecord(record));
    }
    return mine;
  }

  function forgetRun(runId: string): void {
    for (const [key, record] of latest) {
      if (record.runId === runId) latest.delete(key);
    }
    for (const [key, record] of targets) {
      if (record.runId === runId) targets.delete(key);
    }
  }

  return {
    findTarget,
    view,
    resultView,
    saveFeedback,
    trackRun,
    latestRunsOf,
    forgetRun,
    monthUsage,
    onRunCreated(listener) {
      listeners.push(listener);
    },
    startedRunIds() {
      return started;
    },
    start(target, user) {
      return withLock(targetKey(target), () => startLocked(target, user));
    },
    async load(runId) {
      if (!isRunId(runId)) return { ok: false, status: 404, error: RUN_ERRORS.runNotFound };
      let stored;
      try {
        stored = await store().read<unknown>(runKey(runId));
      } catch (error) {
        console.error(`[ERROR] Debug it run ${runId} could not be read: ${errorText(error)}`);
        return { ok: false, status: 503, error: RUN_ERRORS.s3Read };
      }
      if (!stored) return { ok: false, status: 404, error: RUN_ERRORS.runNotFound };
      if (!isRunRecord(stored.value, runId)) {
        console.error(`[ERROR] Debug it run ${runId} has a malformed record.`);
        return { ok: false, status: 503, error: RUN_ERRORS.s3Read };
      }
      return { ok: true, record: stored.value };
    },
  };
}

let singleton: RunService | undefined;

/** The run service of this process, over getS3Store(), getGitHubApp(), debugItConfig and the isolation gate. */
export function getRunService(env: Env = process.env): RunService {
  if (singleton) return singleton;
  singleton = createRunService({
    store: () => getS3Store(env),
    githubApp: () => getGitHubApp(env),
    config: debugItConfig,
    isolation: getIsolationGate(env),
    organization: env.GITHUB_ORGANIZATION?.trim() ?? '',
    settings: getSettingsService(env),
    ...(env.USE_MOCK_DATA === 'true' ? { mockTargets: mockDebugTarget } : {}),
    personalKeys: () => getPersonalKeyService(env),
  });
  return singleton;
}

/** Test helper: forget the process-wide run service. */
export function resetRunService(): void {
  singleton = undefined;
}
