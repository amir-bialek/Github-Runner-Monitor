// Debug it demo lifecycle (story 3.14, AD-16). Mock mode only: it replaces
// the real run lifecycle (lifecycle.ts), which stays off in mock mode. Each
// run that start() creates moves waiting -> cloning -> analyzing -> finished,
// one step delay apart, and ends with a fixed invented result. No Kubernetes
// Job, Secret, Anthropic call or GitHub call happens: the only dependency is
// the injected store (the in-memory s3Store in mock mode).
//
// Every move is one conditional write that lands only while the stored state
// is the expected previous one, as in the real lifecycle; a write that does
// not land (the record is gone or moved on) stops that run's flow. A thrown
// S3 error logs one [ERROR] line and ends the run failed with a fixed
// sentence when it can. The result text is never logged.
//
// start() also seeds invented usage objects for the current UTC month, so the
// usage view shows more than one user.
import { MOCK_TARBALL_SHA } from '../../adapters/githubApp.ts';
import { getS3Store, S3StoreError, type S3Store } from '../../adapters/s3Store.ts';
import { debugItConfig, type DebugItConfig } from '../debugItConfig.ts';
import type { DebugResult } from './resultSchema.ts';
import {
  getRunService,
  isRunRecord,
  isUsageRecord,
  runKey,
  usageKey,
  type RunRecord,
  type RunService,
  type RunState,
  type UsageRecord,
} from './runs.ts';

type Env = Record<string, string | undefined>;

/** The invented cost of every demo run, in US dollars. */
export const DEMO_COST_USD = 0.42;
/** The default delay before each demo step. */
export const DEMO_STEP_MS = 3000;

export const DEMO_ERRORS = {
  s3: 'S3 could not be reached while this demo debug run was moving on.',
} as const;

/** Invented usage seeded for the current UTC month: user ID to entries. */
export const DEMO_USAGE_SEED: ReadonlyArray<{ githubUserId: number; entries: UsageRecord['entries'] }> = [
  {
    githubUserId: 1000002,
    entries: [
      { runId: '00000000-0000-4000-8000-00000000d001', costUsd: 0.37, fixPullRequests: 0 },
      { runId: '00000000-0000-4000-8000-00000000d002', costUsd: 0.55, fixPullRequests: 0 },
    ],
  },
  {
    githubUserId: 1000003,
    entries: [{ runId: '00000000-0000-4000-8000-00000000d003', costUsd: 0.29, fixPullRequests: 0 }],
  },
];

export type DemoStore = Pick<S3Store, 'modify' | 'create'>;

export interface DemoRunLifecycleDeps {
  store: DemoStore | (() => DemoStore);
  runs: Pick<RunService, 'trackRun' | 'onRunCreated'>;
  config?: Pick<DebugItConfig, 'limits'>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The delay before each step, in milliseconds; default 3000. */
  stepMs?: number;
}

export interface DemoRunLifecycle {
  /**
   * Listens for new runs and seeds the invented usage. One-shot: later calls
   * do nothing, and a stopped lifecycle is not started again.
   */
  start(): void;
  /** Stops every flow at its next step. */
  stop(): void;
  /** Moves one waiting run to finished, step by step. Never rejects. */
  advance(record: RunRecord): Promise<void>;
}

/** The fixed invented result of every demo run; `folder` is the repository name. */
export function demoResult(folder: string): DebugResult {
  return {
    schemaVersion: 1,
    explanation:
      'The integration tests connect to PostgreSQL on 127.0.0.1:5432, but the test job starts no database, ' +
      'so every connection is refused (ECONNREFUSED) and the step exits with code 1. ' +
      'Add a postgres service container to the test job in .github/workflows/ci.yml.',
    causeLocation: { kind: 'this-repository' },
    patch: [
      `--- a/${folder}/.github/workflows/ci.yml`,
      `+++ b/${folder}/.github/workflows/ci.yml`,
      '@@ -4,6 +4,13 @@ jobs:',
      '   test:',
      '     runs-on: [self-hosted, linux-large]',
      '+    services:',
      '+      postgres:',
      '+        image: postgres:16',
      '+        env:',
      '+          POSTGRES_PASSWORD: postgres',
      '+        ports:',
      '+          - 5432:5432',
      '     steps:',
      '       - uses: actions/checkout@v4',
      '       - run: npm ci',
      '       - run: npm run test:integration',
      '',
    ].join('\n'),
    costUsd: DEMO_COST_USD,
    inputTokens: 18250,
    outputTokens: 1430,
    durationMs: 9000,
    logTruncated: false,
    failureReason: 'none',
  };
}

function folderOf(repository: string): string {
  const name = repository.split('/')[1];
  return name && name !== '' ? name : repository;
}

function errorText(error: unknown): string {
  return error instanceof S3StoreError ? error.message : 'unknown error';
}

export function createDemoRunLifecycle(deps: DemoRunLifecycleDeps): DemoRunLifecycle {
  const store = (): DemoStore => (typeof deps.store === 'function' ? deps.store() : deps.store);
  const runs = deps.runs;
  const config = deps.config ?? debugItConfig;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const stepMs = deps.stepMs ?? DEMO_STEP_MS;
  let started = false;
  let stopped = false;

  // One conditional write from `from` to `to`; the written record, or null when it did not land.
  async function transition(
    runId: string,
    from: 'waiting' | 'cloning' | 'analyzing',
    to: RunState,
    patch: (current: RunRecord) => Partial<RunRecord> = () => ({}),
  ): Promise<RunRecord | null> {
    let written: RunRecord | null = null;
    await store().modify<RunRecord>(runKey(runId), (value) => {
      written = null;
      if (!isRunRecord(value, runId) || value.state !== from) return undefined;
      const next: RunRecord = { ...value, ...patch(value), state: to, updatedAt: now().toISOString() };
      written = next;
      return next;
    });
    const record = written as RunRecord | null;
    if (record) {
      const reason = to === 'failed' && record.failureReason ? `: ${record.failureReason}` : '';
      console.log(`[AUDIT] Debug it demo run ${runId} ${from} -> ${to}${reason}`);
      runs.trackRun(record);
    }
    return record;
  }

  // Sets the run's usage entry cost; throws on an S3 failure.
  async function setCost(key: unknown, runId: string, costUsd: number): Promise<void> {
    if (typeof key !== 'string' || key === '') return;
    await store().modify<UsageRecord>(key, (current) => {
      if (!isUsageRecord(current)) return undefined;
      const entry = current.entries.find((e) => e.runId === runId);
      if (!entry || entry.costUsd === costUsd) return undefined;
      return { ...current, entries: current.entries.map((e) => (e.runId === runId ? { ...e, costUsd } : e)) };
    });
  }

  async function advance(record: RunRecord): Promise<void> {
    if (record.state !== 'waiting') return;
    const runId = record.runId;
    let state: 'waiting' | 'cloning' | 'analyzing' = 'waiting';
    try {
      await sleep(stepMs);
      if (stopped) return;
      const deadlineAt = new Date(now().getTime() + config.limits.timeLimitMinutes * 60_000).toISOString();
      const cloning = await transition(runId, 'waiting', 'cloning', (current) => ({
        downloads: [{ repository: current.repository, commitSha: MOCK_TARBALL_SHA, folder: folderOf(current.repository) }],
        deadlineAt,
      }));
      if (!cloning) return;
      state = 'cloning';

      await sleep(stepMs);
      if (stopped) return;
      if (!(await transition(runId, 'cloning', 'analyzing'))) return;
      state = 'analyzing';

      await sleep(stepMs);
      if (stopped) return;
      const finished = await transition(runId, 'analyzing', 'finished', (current) => ({
        result: demoResult(current.downloads[0]?.folder || folderOf(current.repository)),
        resultCodeHash: null,
        failureReason: null,
      }));
      if (!finished) return;
      try {
        await setCost(finished.usageKey, runId, DEMO_COST_USD);
      } catch (error) {
        console.error(`[ERROR] Debug it demo run ${runId}: the usage cost could not be written: ${errorText(error)}`);
      }
      return;
    } catch (error) {
      console.error(`[ERROR] Debug it demo run ${runId} could not move on: ${errorText(error)}`);
      if (state === 'analyzing' || state === 'cloning' || state === 'waiting') {
        try {
          await transition(runId, state, 'failed', () => ({ failureReason: DEMO_ERRORS.s3 }));
        } catch (second) {
          console.error(`[ERROR] Debug it demo run ${runId} could not be ended: ${errorText(second)}`);
        }
      }
    }
  }

  async function seedUsage(): Promise<void> {
    const at = now();
    for (const seed of DEMO_USAGE_SEED) {
      const key = usageKey(at, seed.githubUserId);
      try {
        await store().create(key, { entries: seed.entries.map((e) => ({ ...e })) });
      } catch (error) {
        if (error instanceof S3StoreError && error.kind === 'exists') continue;
        console.error(`[ERROR] Debug it demo usage ${key} could not be seeded: ${errorText(error)}`);
      }
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      runs.onRunCreated((record) => {
        void advance(record);
      });
      void seedUsage();
      console.log('[AUDIT] Debug it demo lifecycle started (mock mode)');
    },
    stop() {
      stopped = true;
    },
    advance,
  };
}

let singleton: DemoRunLifecycle | undefined;

/** The demo lifecycle of this process, over the process-wide store and run service. */
export function getDemoRunLifecycle(env: Env = process.env): DemoRunLifecycle {
  if (singleton) return singleton;
  singleton = createDemoRunLifecycle({ store: () => getS3Store(env), runs: getRunService(env) });
  return singleton;
}

/** Test helper: forget the process-wide demo lifecycle. */
export function resetDemoRunLifecycle(): void {
  singleton?.stop();
  singleton = undefined;
}
