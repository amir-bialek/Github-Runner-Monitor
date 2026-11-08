// Debug it run lifecycle and queue (story 3.10, AD-4, AD-9). The single
// backend pod owns every run: the queue and the slots live in memory and are
// rebuilt from runs/ at startup. A run moves waiting -> cloning -> analyzing
// -> finished | failed; every move is one conditional write of
// runs/{runId}.json that lands only while the stored state is the expected
// previous one, so finished and failed are never changed.
//
// Leaving waiting: the cloning write (with the result code hash and the
// deadline) lands before the Job is created, so a crash in between leaves a
// cloning record that recovery fails, gives back and whose Job it deletes.
// Then the Job and its Secret (the Anthropic key, upload code, result code),
// the wait for the receiver, the download step (story 3.8) and analyzing.
// The upload and result codes live only in local variables and the Secret.
//
// Finishing: story 3.9's onAccepted (or the monitor, for a lost hook) first
// sets the usage entry's cost, then moves analyzing -> finished | failed.
// The monitor fails runs whose Job is gone or ended without a result, the
// sweep deletes Jobs of ended runs and retention deletes run records over 30
// days old (never one created in the current UTC month). Recovery removes
// current-month usage entries whose run record does not exist. No code, key,
// hash or result text is ever logged.
//
// Cost telemetry (story 6.1): when this process's write moves a run from
// analyzing to finished or failed from a result, its cost and tokens are
// handed to the telemetry adapter, exactly once and never awaited.
//
// Personal key mode (story 5.1): the key is the requester's, read from S3 at
// the moment the run leaves waiting, so a key deleted earlier never reaches a
// Job. Deleting a key cancels the user's waiting runs (failed, not given back).
import net from 'net';
import { getGitHubApp } from '../../adapters/githubApp.ts';
import {
  getKubernetesAdapter,
  KubernetesError,
  RECEIVER_PORT,
  type KubernetesAdapter,
  type RunStatus,
} from '../../adapters/kubernetes.ts';
import { getS3Store, S3StoreError, type S3Store } from '../../adapters/s3Store.ts';
import { getTelemetryAdapter, type TelemetryAdapter } from '../../adapters/telemetry.ts';
import { debugItConfig, type DebugItConfig } from '../debugItConfig.ts';
import { createDownloadStep, type DownloadStep } from './downloads.ts';
import { getIsolationGate, type IsolationStatus } from './isolation.ts';
import { hashResultCode, newResultCode, type RunHook } from './results.ts';
import {
  ACTIVE_STATES,
  getRunService,
  isRunId,
  isRunRecord,
  isUsageRecord,
  runKey,
  usageMonth,
  type RunRecord,
  type RunService,
  type RunState,
  type UsageRecord,
} from './runs.ts';
import { getSettingsService } from './settings.ts';
import { getPersonalKeyService, type PersonalKeyService } from './personalKeys.ts';

type Env = Record<string, string | undefined>;

/** Every reason the lifecycle ends a run with: fixed sentences only. */
export const LIFECYCLE_ERRORS = {
  noKey: 'The organization Anthropic API key is not set, so the Debug Job could not start.',
  noPersonalKey: 'The requester has no readable personal Anthropic API key, so the Debug Job could not start.',
  personalKeyDeleted: 'The requester deleted their personal Anthropic API key, so this waiting debug run was cancelled.',
  jobCreate: 'The Debug Job could not be created.',
  receiverTimeout: 'The Debug Job was not ready to receive the log and code within 5 minutes.',
  receiverEnded: 'The Debug Job ended before it received the log and code.',
  downloadStep: 'The log and code of this run could not be fetched.',
  unexpected: 'An unexpected error stopped this debug run from starting.',
  s3: 'S3 could not be reached while this debug run was being started.',
  restarted: 'The backend restarted while this debug run was fetching its log and code.',
  jobGone: 'The Debug Job of this run no longer exists.',
  noResult: 'The Debug Job ended without sending a result.',
  deadline: 'The Debug Job reached its time limit without sending a result.',
  timeLimit: 'The analysis stopped at the time limit.',
  spendLimit: 'The analysis stopped at the spend limit.',
  error: 'The analysis stopped because of an error.',
} as const;

/** How long the backend waits for a run's receiver. */
export const RECEIVER_WAIT_MS = 5 * 60_000;
export const RECEIVER_POLL_MS = 2_000;
export const MONITOR_INTERVAL_MS = 10_000;
/** How long after the Job failed or the pod ended a run may still send its result. */
export const NO_RESULT_GRACE_MS = 30_000;
export const SWEEP_INTERVAL_MS = 5 * 60_000;
export const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
export const RETENTION_AGE_MS = 30 * 24 * 60 * 60_000;
/** An active run this long past its deadline logs one [WARN]. */
export const STUCK_GRACE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 2_000;

const FINAL_STATES: ReadonlySet<RunState> = new Set<RunState>(['finished', 'failed']);
const RUN_KEY = /^runs\/(.+)\.json$/;

export interface RunLifecycleDeps {
  store: S3Store | (() => S3Store);
  kubernetes: KubernetesAdapter | (() => KubernetesAdapter);
  downloads: Pick<DownloadStep, 'fetchRunInputs'> | (() => Pick<DownloadStep, 'fetchRunInputs'>);
  isolation: { status(): IsolationStatus };
  runs: Pick<RunService, 'trackRun' | 'forgetRun' | 'onRunCreated' | 'startedRunIds'>;
  config: Pick<DebugItConfig, 'limits'> & Partial<Pick<DebugItConfig, 'credentialsMode'>>;
  /**
   * The Anthropic key a run of this requester uses (the organization key, or
   * in personal key mode the requester's decrypted key), or null when there is
   * none. May throw when it cannot be read.
   */
  apiKeyFor: (githubUserId: number) => Promise<string | null>;
  /** Personal key mode: deleting a key cancels the user's waiting runs. */
  personalKeys?: Pick<PersonalKeyService, 'onDeleted'>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a TCP connect to host:port succeeds. */
  probe?: (host: string, port: number) => Promise<boolean>;
  /** Story 6.1: cost telemetry; told about each run that ends from a result. */
  telemetry?: Pick<TelemetryAdapter, 'recordRun'>;
}

export interface RunLifecycle {
  /** Listens for new runs, recovers, and starts the monitor, sweep and retention timers. */
  start(): void;
  /** Stops the timers; runs in flight are left to the next start's recovery. */
  stop(): void;
  /** Rebuilds the queue and slots from runs/ once; true when recovery has succeeded. */
  recover(): Promise<boolean>;
  /** Starts every waiting run that fits the limits. */
  pump(): void;
  /** One monitor tick: recovery until it succeeds, analyzing runs, stuck runs, then pump. */
  monitor(): Promise<void>;
  /** Deletes the Jobs of runs that ended or have no record. */
  sweep(): Promise<void>;
  /** Deletes final run records over 30 days old. */
  retention(): Promise<void>;
  /** Story 3.9's onAccepted: finishes the run. */
  onResultAccepted: RunHook;
  /** Story 3.9's onFailed (5 wrong codes): deletes the Job and frees the slot. */
  onRunFailed: RunHook;
  /**
   * Fails every queued (waiting) run of this user with the reason, without
   * giving back usage; answers how many were cancelled.
   */
  cancelWaitingRuns(githubUserId: number, reason: string): Promise<number>;
  /** The queued and active run IDs, for tests and diagnostics. */
  snapshot(): { queued: string[]; active: string[] };
}

interface Slot {
  runId: string;
  githubUserId: number;
  createdAt: string;
  state: 'cloning' | 'analyzing';
  /** Milliseconds since the epoch, or null when not known. */
  deadlineAt: number | null;
  /** A failure from cloning whose write did not land; retried each monitor tick. */
  pendingFail: string | null;
}

interface QueuedRun {
  runId: string;
  githubUserId: number;
  createdAt: string;
}

interface TransitionOptions {
  reason?: string;
  /** Fields to set besides state and updatedAt. */
  patch?: (current: RunRecord) => Partial<RunRecord>;
  /** An extra condition on the stored record. */
  guard?: (current: RunRecord) => boolean;
}

interface TransitionOutcome {
  written: RunRecord | null;
  /** The stored record the write was decided on (null when missing or malformed). */
  current: RunRecord | null;
}

function errorText(error: unknown): string {
  return error instanceof S3StoreError || error instanceof KubernetesError ? error.message : 'unknown error';
}

function hasResult(record: RunRecord): boolean {
  return record.result !== null && record.result !== undefined;
}

function deadlineMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function receiverUrl(ip: string): string {
  return net.isIP(ip) === 6 ? `http://[${ip}]:${RECEIVER_PORT}` : `http://${ip}:${RECEIVER_PORT}`;
}

/** Whether a TCP connection to host:port opens within 2 seconds. */
export function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: net.Socket;
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    try {
      socket = net.connect({ host, port });
    } catch {
      resolve(false);
      return;
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The cost, token counts and failure reason of a stored result, read defensively. */
function readResult(value: unknown): { costUsd: number; inputTokens: number; outputTokens: number; failureReason: string } {
  const result = (value && typeof value === 'object' ? value : {}) as {
    costUsd?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    failureReason?: unknown;
  };
  const reason = typeof result.failureReason === 'string' ? result.failureReason : 'error';
  return {
    costUsd: nonNegative(result.costUsd),
    inputTokens: nonNegative(result.inputTokens),
    outputTokens: nonNegative(result.outputTokens),
    failureReason: reason,
  };
}

function failureSentence(failureReason: string): string {
  if (failureReason === 'time-limit') return LIFECYCLE_ERRORS.timeLimit;
  if (failureReason === 'spend-limit') return LIFECYCLE_ERRORS.spendLimit;
  return LIFECYCLE_ERRORS.error;
}

export function createRunLifecycle(deps: RunLifecycleDeps): RunLifecycle {
  const { isolation, runs, config } = deps;
  const store = (): S3Store => (typeof deps.store === 'function' ? deps.store() : deps.store);
  const kube = (): KubernetesAdapter => (typeof deps.kubernetes === 'function' ? deps.kubernetes() : deps.kubernetes);
  const downloads = (): Pick<DownloadStep, 'fetchRunInputs'> =>
    typeof deps.downloads === 'function' ? deps.downloads() : deps.downloads;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const probe = deps.probe ?? tcpProbe;

  const queue = new Map<string, QueuedRun>();
  const slots = new Map<string, Slot>();
  const finishing = new Set<string>();
  // Run ID to when its Job failure or pod end was first seen (by now()).
  const endedSeen = new Map<string, number>();
  const warned = new Set<string>();
  // Run ID to the usage key whose entry could not be given back yet.
  const pendingGiveBacks = new Map<string, string>();
  const timers: NodeJS.Timeout[] = [];
  let recovered = false;
  let recovering: Promise<boolean> | null = null;
  let started = false;
  let stopped = false;
  let ticking = false;

  // --- the one door for state changes ---

  async function transition(
    runId: string,
    from: 'waiting' | 'cloning' | 'analyzing',
    to: RunState,
    options: TransitionOptions = {},
  ): Promise<TransitionOutcome> {
    let written: RunRecord | null = null;
    let current: RunRecord | null = null;
    await store().modify<RunRecord>(runKey(runId), (value) => {
      written = null;
      current = isRunRecord(value, runId) ? value : null;
      if (!current || current.state !== from || FINAL_STATES.has(current.state)) return undefined;
      if (options.guard && !options.guard(current)) return undefined;
      const next: RunRecord = {
        ...current,
        ...(options.patch ? options.patch(current) : {}),
        state: to,
        updatedAt: now().toISOString(),
      };
      if (to === 'failed') next.failureReason = options.reason ?? null;
      written = next;
      return next;
    });
    const record = written as RunRecord | null;
    if (record) {
      auditTransition(runId, from, to, to === 'failed' ? (options.reason ?? null) : null);
      runs.trackRun(record);
    }
    return { written: record, current: current as RunRecord | null };
  }

  function auditTransition(runId: string, from: RunState, to: RunState, reason: string | null): void {
    console.log(`[AUDIT] Debug it run ${runId} ${from} -> ${to}${reason ? `: ${reason}` : ''}`);
  }

  // --- slots, Jobs and usage ---

  function freeSlot(runId: string): void {
    slots.delete(runId);
    endedSeen.delete(runId);
    warned.delete(runId);
  }

  async function deleteJob(runId: string): Promise<void> {
    try {
      await kube().deleteRun(runId);
    } catch (error) {
      console.warn(`[WARN] Debug it run ${runId}: the Debug Job could not be deleted (${errorText(error)}); the sweep retries.`);
    }
  }

  // Removes the run's usage entry, idempotently. Only for runs ending from cloning.
  async function giveBack(key: unknown, runId: string): Promise<void> {
    if (typeof key !== 'string' || key === '') return;
    try {
      await store().modify<UsageRecord>(key, (current) => {
        if (!isUsageRecord(current) || !current.entries.some((e) => e.runId === runId)) return undefined;
        return { ...current, entries: current.entries.filter((e) => e.runId !== runId) };
      });
      pendingGiveBacks.delete(runId);
    } catch (error) {
      pendingGiveBacks.set(runId, key);
      console.error(`[ERROR] Debug it usage entry of run ${runId} could not be given back: ${errorText(error)}; it is retried.`);
    }
  }

  // Sets (not adds) the usage entry's cost, so a retry is safe. Throws on an S3 failure.
  async function setCost(key: unknown, runId: string, costUsd: number): Promise<void> {
    if (typeof key !== 'string' || key === '') return;
    await store().modify<UsageRecord>(key, (current) => {
      if (!isUsageRecord(current)) return undefined;
      const entry = current.entries.find((e) => e.runId === runId);
      if (!entry || entry.costUsd === costUsd) return undefined;
      return { ...current, entries: current.entries.map((e) => (e.runId === runId ? { ...e, costUsd } : e)) };
    });
  }

  // --- the queue ---

  function compareQueued(a: QueuedRun, b: QueuedRun): number {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
    return 0;
  }

  function enqueue(record: RunRecord): void {
    if (slots.has(record.runId)) return;
    queue.set(record.runId, {
      runId: record.runId,
      githubUserId: record.requester?.githubUserId,
      createdAt: record.createdAt,
    });
  }

  function pump(): void {
    if (!recovered || stopped) return;
    if (isolation.status().state !== 'on') return;
    const { maxConcurrentRuns, maxRunsPerUser } = config.limits;
    for (const run of [...queue.values()].sort(compareQueued)) {
      if (slots.size >= maxConcurrentRuns) break;
      let mine = 0;
      for (const slot of slots.values()) if (slot.githubUserId === run.githubUserId) mine += 1;
      if (mine >= maxRunsPerUser) continue;
      queue.delete(run.runId);
      const slot: Slot = {
        runId: run.runId,
        githubUserId: run.githubUserId,
        createdAt: run.createdAt,
        state: 'cloning',
        deadlineAt: null,
        pendingFail: null,
      };
      slots.set(run.runId, slot);
      void startRun(slot);
    }
  }

  // --- leaving waiting ---

  async function startRun(slot: Slot): Promise<void> {
    try {
      await leaveWaiting(slot);
    } catch (error) {
      console.error(`[ERROR] Debug it run ${slot.runId} could not be started: ${errorText(error)}`);
      if (slots.get(slot.runId) === slot && slot.state === 'cloning') {
        await failCloning(slot, LIFECYCLE_ERRORS.unexpected).catch(() => undefined);
      }
    }
  }

  async function leaveWaiting(slot: Slot): Promise<void> {
    const { runId } = slot;
    const uploadCode = newResultCode();
    const resultCode = newResultCode();
    const resultCodeHash = hashResultCode(resultCode);
    const { timeLimitMinutes, spendLimitUsd } = config.limits;
    const deadlineAt = new Date(now().getTime() + timeLimitMinutes * 60_000);

    // 1. waiting -> cloning, with the hash and the deadline.
    let moved: boolean;
    let current: RunRecord | null = null;
    try {
      const outcome = await transition(runId, 'waiting', 'cloning', {
        patch: () => ({ resultCodeHash, deadlineAt: deadlineAt.toISOString() }),
      });
      moved = outcome.written !== null;
      current = outcome.current;
    } catch (error) {
      // The write may have landed with its answer lost.
      moved = false;
      let landed: RunRecord | null = null;
      try {
        const stored = await store().read<unknown>(runKey(runId));
        if (stored && isRunRecord(stored.value, runId) && stored.value.state === 'cloning' && stored.value.resultCodeHash === resultCodeHash) {
          landed = stored.value;
        }
      } catch {
        landed = null;
      }
      if (landed) {
        moved = true;
        auditTransition(runId, 'waiting', 'cloning', null);
        runs.trackRun(landed);
      } else {
        // Still waiting: back in the queue, tried again on the next monitor tick.
        console.error(`[ERROR] Debug it run ${runId} could not leave waiting: ${errorText(error)}; it is retried.`);
        freeSlot(runId);
        queue.set(runId, { runId, githubUserId: slot.githubUserId, createdAt: slot.createdAt });
        return;
      }
    }
    if (!moved) {
      if (current?.state === 'cloning') {
        // An earlier attempt's write landed with its answer and read-back lost:
        // end it from cloning (Job deleted, usage given back, slot freed).
        await failCloning(slot, LIFECYCLE_ERRORS.s3);
        return;
      }
      // No longer waiting (or gone): nothing to start.
      freeSlot(runId);
      pump();
      return;
    }
    slot.deadlineAt = deadlineAt.getTime();

    // 2. The Job and its Secret, with the requester's or the organization key.
    let anthropicApiKey: string;
    try {
      anthropicApiKey = (await deps.apiKeyFor(slot.githubUserId))?.trim() ?? '';
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId}: the Anthropic key could not be read: ${errorText(error)}`);
      await failCloning(slot, LIFECYCLE_ERRORS.s3);
      return;
    }
    if (anthropicApiKey === '') {
      await failCloning(slot, config.credentialsMode === 'personal' ? LIFECYCLE_ERRORS.noPersonalKey : LIFECYCLE_ERRORS.noKey);
      return;
    }
    try {
      await kube().startRun({
        runId,
        timeLimitSeconds: timeLimitMinutes * 60,
        deadlineAt,
        spendLimitUsd,
        anthropicApiKey,
        uploadCode,
        resultCode,
      });
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId}: ${errorText(error)}`);
      await failCloning(slot, LIFECYCLE_ERRORS.jobCreate);
      return;
    }

    // 3. The receiver.
    const receiver = await waitForReceiver(runId);
    if (!receiver.ok) {
      if (receiver.reason !== null) await failCloning(slot, receiver.reason);
      return;
    }

    // 4. The log and code.
    let step: Pick<DownloadStep, 'fetchRunInputs'>;
    try {
      step = downloads();
    } catch {
      console.error(`[ERROR] Debug it run ${runId}: the download step could not be built.`);
      await failCloning(slot, LIFECYCLE_ERRORS.downloadStep);
      return;
    }
    const fetched = await step.fetchRunInputs(runId, { baseUrl: receiver.baseUrl, uploadCode });
    if (!fetched.ok) {
      await failCloning(slot, fetched.reason);
      return;
    }

    // 5. cloning -> analyzing.
    let outcome: TransitionOutcome;
    try {
      outcome = await transition(runId, 'cloning', 'analyzing');
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId} could not move to analyzing: ${errorText(error)}`);
      await failCloning(slot, LIFECYCLE_ERRORS.s3);
      return;
    }
    if (outcome.written || outcome.current?.state === 'analyzing') {
      slot.state = 'analyzing';
      return;
    }
    // The record left cloning some other way, or is gone.
    await deleteJob(runId);
    freeSlot(runId);
    pump();
  }

  type ReceiverOutcome = { ok: true; baseUrl: string } | { ok: false; reason: string | null };

  async function waitForReceiver(runId: string): Promise<ReceiverOutcome> {
    const startedAt = now().getTime();
    for (;;) {
      if (stopped) return { ok: false, reason: null };
      let status: RunStatus | null = null;
      try {
        status = await kube().runStatus(runId);
      } catch {
        status = null;
      }
      if (status) {
        if (!status.exists || status.failed || status.podEndedAt !== null) {
          return { ok: false, reason: LIFECYCLE_ERRORS.receiverEnded };
        }
        const ip = status.podIp;
        if (ip !== null && net.isIP(ip) !== 0 && status.receiverRunning) {
          let open = false;
          try {
            open = await probe(ip, RECEIVER_PORT);
          } catch {
            open = false;
          }
          if (open) return { ok: true, baseUrl: receiverUrl(ip) };
        }
      }
      if (now().getTime() - startedAt >= RECEIVER_WAIT_MS) return { ok: false, reason: LIFECYCLE_ERRORS.receiverTimeout };
      await sleep(RECEIVER_POLL_MS);
    }
  }

  // Ends a run from cloning: failed, Job deleted, usage given back, slot freed.
  async function failCloning(slot: Slot, reason: string): Promise<void> {
    const { runId } = slot;
    let outcome: TransitionOutcome;
    try {
      outcome = await transition(runId, 'cloning', 'failed', { reason, patch: () => ({ resultCodeHash: null }) });
    } catch (error) {
      slot.pendingFail = reason;
      console.error(`[ERROR] Debug it run ${runId} could not be marked failed: ${errorText(error)}; it is retried.`);
      return;
    }
    slot.pendingFail = null;
    if (!outcome.written && outcome.current?.state === 'analyzing') {
      slot.state = 'analyzing';
      return;
    }
    await deleteJob(runId);
    if (outcome.written) await giveBack(outcome.written.usageKey, runId);
    freeSlot(runId);
    pump();
  }

  // --- finishing ---

  async function finishRun(runId: string, record: RunRecord): Promise<void> {
    if (finishing.has(runId)) return;
    finishing.add(runId);
    try {
      const { costUsd, failureReason } = readResult(record.result);
      // 1. The cost, before the final state, so a failed write is retried while analyzing.
      try {
        await setCost(record.usageKey, runId, costUsd);
      } catch (error) {
        console.error(`[ERROR] Debug it run ${runId}: the usage cost could not be written: ${errorText(error)}; it is retried.`);
        return;
      }
      // 2. analyzing -> finished | failed, keeping the result.
      const to: RunState = failureReason === 'none' ? 'finished' : 'failed';
      let outcome: TransitionOutcome;
      try {
        outcome = await transition(runId, 'analyzing', to, {
          reason: failureSentence(failureReason),
          guard: hasResult,
          patch: () => ({ resultCodeHash: null }),
        });
      } catch (error) {
        console.error(`[ERROR] Debug it run ${runId} could not be finished: ${errorText(error)}; it is retried.`);
        return;
      }
      if (!outcome.written && outcome.current?.state === 'analyzing') return;
      if (outcome.written) recordTelemetry(outcome.written);
      if (!outcome.written && outcome.current) runs.trackRun(outcome.current);
      await deleteJob(runId);
      freeSlot(runId);
      pump();
    } finally {
      finishing.delete(runId);
    }
  }

  // Story 6.1: hands a run that this process just ended from a result to the
  // telemetry adapter. Never awaited; nothing it does can change the run.
  function recordTelemetry(written: RunRecord): void {
    if (!deps.telemetry) return;
    try {
      const { costUsd, inputTokens, outputTokens } = readResult(written.result);
      deps.telemetry.recordRun({
        runId: written.runId,
        repository: written.repository,
        login: written.requester?.login,
        costUsd,
        inputTokens,
        outputTokens,
      });
    } catch {
      // Telemetry never affects a run.
    }
  }

  // Ends an analyzing run with no result: failed, Job deleted, slot freed.
  async function failAnalyzing(runId: string, reason: string): Promise<void> {
    let outcome: TransitionOutcome;
    try {
      outcome = await transition(runId, 'analyzing', 'failed', {
        reason,
        guard: (r) => !hasResult(r),
        patch: () => ({ resultCodeHash: null }),
      });
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId} could not be marked failed: ${errorText(error)}; it is retried.`);
      return;
    }
    const current = outcome.current;
    if (!outcome.written && current?.state === 'analyzing') {
      // A result landed meanwhile.
      if (hasResult(current)) await finishRun(runId, current);
      return;
    }
    if (!outcome.written && current) runs.trackRun(current);
    await deleteJob(runId);
    freeSlot(runId);
    pump();
  }

  // --- the monitor ---

  async function checkAnalyzing(slot: Slot): Promise<void> {
    const { runId } = slot;
    if (finishing.has(runId)) return;
    let stored;
    try {
      stored = await store().read<unknown>(runKey(runId));
    } catch {
      return;
    }
    if (!stored) {
      await deleteJob(runId);
      freeSlot(runId);
      return;
    }
    if (!isRunRecord(stored.value, runId)) return;
    const record = stored.value;
    if (record.state !== 'analyzing') {
      runs.trackRun(record);
      await deleteJob(runId);
      freeSlot(runId);
      return;
    }
    if (hasResult(record)) {
      await finishRun(runId, record);
      return;
    }
    let status: RunStatus;
    try {
      status = await kube().runStatus(runId);
    } catch {
      return;
    }
    if (!status.exists) {
      await failAnalyzing(runId, LIFECYCLE_ERRORS.jobGone);
      return;
    }
    if (status.failed || status.podEndedAt !== null) {
      const at = now().getTime();
      const seen = endedSeen.get(runId);
      if (seen === undefined) {
        endedSeen.set(runId, at);
        return;
      }
      if (at - seen < NO_RESULT_GRACE_MS) return;
      await failAnalyzing(runId, status.deadlineExceeded ? LIFECYCLE_ERRORS.deadline : LIFECYCLE_ERRORS.noResult);
    }
  }

  function warnStuck(): void {
    const at = now().getTime();
    for (const slot of slots.values()) {
      if (slot.deadlineAt === null || warned.has(slot.runId)) continue;
      if (at > slot.deadlineAt + STUCK_GRACE_MS) {
        warned.add(slot.runId);
        console.warn(`[WARN] Debug it run ${slot.runId} is still ${slot.state} more than 5 minutes past its deadline.`);
      }
    }
  }

  async function monitor(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      if (!recovered && !(await recover())) return;
      for (const [runId, key] of [...pendingGiveBacks]) await giveBack(key, runId);
      for (const slot of [...slots.values()]) {
        if (slots.get(slot.runId) !== slot) continue;
        if (slot.pendingFail !== null) {
          await failCloning(slot, slot.pendingFail);
        } else if (slot.state === 'analyzing') {
          await checkAnalyzing(slot);
        }
      }
      warnStuck();
      pump();
    } catch (error) {
      console.error(`[ERROR] Debug it run monitor failed: ${errorText(error)}`);
    } finally {
      ticking = false;
    }
  }

  // --- recovery ---

  function adoptAnalyzing(record: RunRecord): void {
    if (slots.has(record.runId)) return;
    slots.set(record.runId, {
      runId: record.runId,
      githubUserId: record.requester?.githubUserId,
      createdAt: record.createdAt,
      state: 'analyzing',
      deadlineAt: deadlineMs(record.deadlineAt),
      pendingFail: null,
    });
  }

  async function recoverRun(record: RunRecord): Promise<void> {
    const { runId } = record;
    switch (record.state) {
      case 'waiting':
        enqueue(record);
        runs.trackRun(record);
        return;
      case 'cloning': {
        const outcome = await transition(runId, 'cloning', 'failed', {
          reason: LIFECYCLE_ERRORS.restarted,
          patch: () => ({ resultCodeHash: null }),
        });
        if (outcome.written) {
          await deleteJob(runId);
          await giveBack(outcome.written.usageKey, runId);
        }
        return;
      }
      case 'analyzing': {
        adoptAnalyzing(record);
        runs.trackRun(record);
        if (hasResult(record)) {
          await finishRun(runId, record);
          return;
        }
        let status: RunStatus | null = null;
        try {
          status = await kube().runStatus(runId);
        } catch {
          // Kubernetes cannot be reached: keep the run and let the monitor decide.
          status = null;
        }
        if (status && !status.exists) await failAnalyzing(runId, LIFECYCLE_ERRORS.jobGone);
        return;
      }
      default:
        // Final runs feed the latest-run-per-target map (story 3.11).
        runs.trackRun(record);
        return;
    }
  }

  // Only the current UTC month: retention never deletes a record created this
  // month, so a current-month entry without a record is a true orphan. Past
  // months keep their entries (and cost history) after retention.
  async function removeOrphanUsage(existing: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    for (const key of await store().list(`usage/${usageMonth(now())}/`)) {
      let dropped = 0;
      await store().modify<UsageRecord>(key, (current) => {
        dropped = 0;
        if (!isUsageRecord(current)) return undefined;
        const started = runs.startedRunIds();
        const kept = current.entries.filter((e) => existing.has(e.runId) || started.has(e.runId));
        if (kept.length === current.entries.length) return undefined;
        dropped = current.entries.length - kept.length;
        return { ...current, entries: kept };
      });
      removed += dropped;
    }
    return removed;
  }

  async function runRecovery(): Promise<boolean> {
    try {
      const existing = new Set<string>();
      let count = 0;
      for (const key of await store().list('runs/')) {
        const runId = RUN_KEY.exec(key)?.[1];
        if (!runId || !isRunId(runId)) continue;
        existing.add(runId);
        const stored = await store().read<unknown>(key);
        if (!stored) continue;
        if (!isRunRecord(stored.value, runId)) {
          console.error(`[ERROR] Debug it run ${runId} has a malformed record; recovery skips it.`);
          continue;
        }
        if (ACTIVE_STATES.has(stored.value.state)) count += 1;
        await recoverRun(stored.value);
      }
      const removed = await removeOrphanUsage(existing);
      recovered = true;
      console.log(
        `[INFO] Debug it run lifecycle recovered ${count} active runs and removed ${removed} orphan usage entries`,
      );
    } catch (error) {
      console.error(`[ERROR] Debug it run lifecycle could not recover its runs: ${errorText(error)}; it is retried.`);
    }
    return recovered;
  }

  async function recover(): Promise<boolean> {
    if (recovered) return true;
    if (!recovering) {
      recovering = runRecovery().finally(() => {
        recovering = null;
      });
    }
    const ok = await recovering;
    if (ok) pump();
    return ok;
  }

  // --- sweep and retention ---

  async function sweep(): Promise<void> {
    let ids: string[];
    try {
      ids = await kube().listRunJobs();
    } catch (error) {
      console.warn(`[WARN] Debug it sweep could not list the Debug Jobs: ${errorText(error)}`);
      return;
    }
    for (const runId of ids) {
      let stored;
      try {
        stored = await store().read<unknown>(runKey(runId));
      } catch {
        continue;
      }
      if (stored) {
        if (!isRunRecord(stored.value, runId)) continue;
        if (!FINAL_STATES.has(stored.value.state)) continue;
      }
      try {
        await kube().deleteRun(runId);
        console.log(`[INFO] Debug it sweep deleted the Debug Job of run ${runId}`);
      } catch (error) {
        console.warn(`[WARN] Debug it sweep could not delete the Debug Job of run ${runId}: ${errorText(error)}`);
      }
    }
  }

  async function retention(): Promise<void> {
    let keys: string[];
    try {
      keys = await store().list('runs/');
    } catch (error) {
      console.error(`[ERROR] Debug it retention could not list the run records: ${errorText(error)}`);
      return;
    }
    const at = now();
    const cutoff = at.getTime() - RETENTION_AGE_MS;
    const month = usageMonth(at);
    for (const key of keys) {
      const runId = RUN_KEY.exec(key)?.[1];
      if (!runId || !isRunId(runId)) continue;
      let stored;
      try {
        stored = await store().read<unknown>(key);
      } catch {
        continue;
      }
      if (!stored || !isRunRecord(stored.value, runId)) continue;
      const record = stored.value;
      if (!FINAL_STATES.has(record.state)) continue;
      const created = Date.parse(record.createdAt);
      if (!Number.isFinite(created) || created >= cutoff) continue;
      // A record of the current UTC month is kept, so its usage entry never loses it.
      if (usageMonth(new Date(created)) === month) continue;
      try {
        await store().deleteAllVersions(key);
        console.log(`[AUDIT] Debug it run ${runId} record deleted after 30 days`);
        runs.forgetRun(runId);
      } catch (error) {
        console.error(`[ERROR] Debug it run ${runId} record could not be deleted: ${errorText(error)}`);
      }
    }
  }

  // --- hooks ---

  const onResultAccepted: RunHook = async (record) => {
    try {
      await finishRun(record.runId, record);
    } catch (error) {
      console.error(`[ERROR] Debug it run ${record.runId} could not be finished: ${errorText(error)}`);
    }
  };

  const onRunFailed: RunHook = async (record) => {
    try {
      runs.trackRun(record);
      await deleteJob(record.runId);
      freeSlot(record.runId);
      pump();
    } catch (error) {
      console.error(`[ERROR] Debug it run ${record.runId}: its failure could not be handled: ${errorText(error)}`);
    }
  };

  // --- personal keys ---

  async function cancelWaitingRuns(githubUserId: number, reason: string): Promise<number> {
    let cancelled = 0;
    // Out of the queue first, so pump() cannot start one while the writes run.
    const mine = [...queue.values()].filter((run) => run.githubUserId === githubUserId);
    for (const run of mine) queue.delete(run.runId);
    for (const run of mine) {
      try {
        const outcome = await transition(run.runId, 'waiting', 'failed', { reason });
        if (outcome.written) cancelled += 1;
      } catch (error) {
        // Still waiting: it leaves waiting later, finds no key and fails from cloning.
        console.error(`[ERROR] Debug it run ${run.runId} could not be cancelled: ${errorText(error)}`);
        if (!slots.has(run.runId)) queue.set(run.runId, run);
      }
    }
    return cancelled;
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      runs.onRunCreated((record) => {
        if (stopped || record.state !== 'waiting') return;
        enqueue(record);
        pump();
      });
      deps.personalKeys?.onDeleted((githubUserId) =>
        cancelWaitingRuns(githubUserId, LIFECYCLE_ERRORS.personalKeyDeleted),
      );
      void monitor();
      void retention();
      const every = (fn: () => Promise<void>, ms: number): void => {
        const timer = setInterval(() => void fn(), ms);
        timer.unref?.();
        timers.push(timer);
      };
      every(monitor, MONITOR_INTERVAL_MS);
      every(sweep, SWEEP_INTERVAL_MS);
      every(retention, RETENTION_INTERVAL_MS);
    },
    stop() {
      stopped = true;
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
    recover,
    pump,
    monitor,
    sweep,
    retention,
    onResultAccepted,
    onRunFailed,
    cancelWaitingRuns,
    snapshot() {
      return { queued: [...queue.values()].sort(compareQueued).map((q) => q.runId), active: [...slots.keys()].sort() };
    },
  };
}

let singleton: RunLifecycle | undefined;

/** The run lifecycle of this process, over the process-wide store, adapter, download step, gate and run service. */
export function getRunLifecycle(env: Env = process.env): RunLifecycle {
  if (singleton) return singleton;
  let step: DownloadStep | undefined;
  singleton = createRunLifecycle({
    store: () => getS3Store(env),
    kubernetes: () => getKubernetesAdapter(env),
    downloads: () =>
      (step ??= createDownloadStep({
        store: getS3Store(env),
        githubApp: getGitHubApp(env),
        settings: getSettingsService(env),
        organization: env.GITHUB_ORGANIZATION?.trim() ?? '',
        logLimitBytes: debugItConfig.limits.logLimitBytes,
      })),
    isolation: getIsolationGate(env),
    runs: getRunService(env),
    config: debugItConfig,
    telemetry: getTelemetryAdapter(env, debugItConfig.costTelemetry),
    ...(debugItConfig.credentialsMode === 'personal'
      ? {
          // Read from S3 each time a run leaves waiting; never kept.
          apiKeyFor: async (githubUserId: number) => {
            const found = await getPersonalKeyService(env).keyFor(githubUserId);
            return found.status === 'saved' ? found.key : null;
          },
          personalKeys: getPersonalKeyService(env),
        }
      : {
          apiKeyFor: async () => {
            const key = env.DEBUG_IT_ANTHROPIC_API_KEY?.trim();
            return key ? key : null;
          },
        }),
  });
  return singleton;
}

/** Test helper: forget the process-wide lifecycle. */
export function resetRunLifecycle(): void {
  singleton?.stop();
  singleton = undefined;
}
