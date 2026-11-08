import { KubernetesError, type KubernetesAdapter, type RunStatus, type StartRunInput } from '../src/adapters/kubernetes';
import { createMemoryS3Client, createS3Store, type S3Client, type S3Command } from '../src/adapters/s3Store';
import { DEBUG_IT_DEFAULTS, type DebugItLimits } from '../src/services/debugItConfig';
import { DOWNLOAD_ERRORS, type DownloadOutcome } from '../src/services/debugIt/downloads';
import type { IsolationStatus } from '../src/services/debugIt/isolation';
import {
  createRunLifecycle,
  getRunLifecycle,
  LIFECYCLE_ERRORS,
  resetRunLifecycle,
  type RunLifecycle,
} from '../src/services/debugIt/lifecycle';
import * as telemetryModule from '../src/adapters/telemetry';
import { debugItConfig } from '../src/services/debugItConfig';
import { hashResultCode } from '../src/services/debugIt/results';
import type { DebugResult } from '../src/services/debugIt/resultSchema';
import type { RunRecord, UsageRecord } from '../src/services/debugIt/runs';
import type { UploadTarget } from '../src/services/debugIt/upload';
import { createAnthropicAdapter } from '../src/adapters/anthropic';
import { createPersonalKeyService, type PersonalKeyService } from '../src/services/debugIt/personalKeys';
type TelemetryRun = telemetryModule.TelemetryRun;

const log = console.log as jest.Mock;
const warn = console.warn as jest.Mock;
const error = console.error as jest.Mock;

const API_KEY = 'sk-ant-api03-test-key-acme';
const REPO = 'acme/payments-api';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const DANA = { githubUserId: 1000001, login: 'dana' };
const START = Date.parse('2026-11-05T10:00:00.000Z');
const ON: IsolationStatus = { state: 'on', reason: null, checkedAt: '2026-11-05T09:00:00.000Z' };
const CHECKING: IsolationStatus = { state: 'checking', reason: 'checking', checkedAt: null };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function runId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function user(n: number): { githubUserId: number; login: string } {
  return n === 1 ? DANA : { githubUserId: 1000000 + n, login: `user${n}` };
}

function usageKeyOf(githubUserId: number, month = '2026-11'): string {
  return `usage/${month}/${githubUserId}.json`;
}

function result(overrides: Partial<DebugResult> = {}): DebugResult {
  return {
    schemaVersion: 1,
    explanation: 'The refunds test expects a currency field that the fixture lacks.',
    causeLocation: { kind: 'this-repository' },
    patch: '',
    costUsd: 0.42,
    inputTokens: 1200,
    outputTokens: 300,
    durationMs: 61000,
    logTruncated: false,
    failureReason: 'none',
    ...overrides,
  } as DebugResult;
}

function record(n: number, overrides: Partial<RunRecord> = {}): RunRecord {
  const requester = overrides.requester ?? DANA;
  const createdAt = new Date(START + n * 1000).toISOString();
  return {
    runId: runId(n),
    target: { kind: 'job', id: 900000 + n },
    requester,
    state: 'waiting',
    createdAt,
    updatedAt: createdAt,
    repository: REPO,
    headRepository: REPO,
    headSha: SHA,
    branch: 'main',
    jobName: 'test',
    downloads: [],
    usageKey: usageKeyOf(requester.githubUserId),
    resultCodeHash: null,
    result: null,
    feedback: null,
    fixPullRequests: [],
    failureReason: null,
    ...overrides,
  };
}

interface Harness {
  lifecycle: RunLifecycle;
  memory: ReturnType<typeof createS3Store>;
  commands: S3Command[];
  setFail: (fail: (c: S3Command) => boolean) => void;
  /** Commands matching this are stored, then answered with a failure (a lost answer). */
  setFailAfter: (fail: (c: S3Command) => boolean) => void;
  adapter: KubernetesAdapter & {
    started: StartRunInput[];
    deleted: string[];
    statuses: Map<string, RunStatus | 'error'>;
    jobs: string[];
    startFails: boolean;
  };
  step: jest.Mock<Promise<DownloadOutcome>, [string, UploadTarget]>;
  probe: jest.Mock<Promise<boolean>, [string, number]>;
  tracked: RunRecord[];
  forgotten: string[];
  started: Set<string>;
  emit: (r: RunRecord) => void;
  setGate: (s: IsolationStatus) => void;
  setKey: (k: string | null) => void;
  clock: { ms: number };
  seed: (r: RunRecord, usage?: boolean) => Promise<void>;
  read: (n: number) => Promise<RunRecord | null>;
  usage: (key: string) => Promise<UsageRecord | null>;
  /** Personal key mode only: the key store over the same bucket. */
  keys: PersonalKeyService | null;
}

function readyStatus(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    exists: true,
    failed: false,
    deadlineExceeded: false,
    podIp: '10.0.0.12',
    receiverRunning: true,
    podEndedAt: null,
    ...overrides,
  };
}

function okOutcome(): DownloadOutcome {
  return { ok: true, downloads: [], skippedRepositories: [], logTruncated: false };
}

function harness(
  options: {
    limits?: Partial<DebugItLimits>;
    gate?: IsolationStatus;
    personal?: boolean;
    telemetry?: { recordRun: (run: TelemetryRun) => void };
  } = {},
): Harness {
  const inner = createMemoryS3Client();
  const commands: S3Command[] = [];
  let fail: (c: S3Command) => boolean = () => false;
  let failAfter: (c: S3Command) => boolean = () => false;
  const timeout = (): Error => {
    const e = new Error('TimeoutError') as Error & { $metadata: object };
    e.name = 'TimeoutError';
    e.$metadata = {};
    return e;
  };
  const client: S3Client = {
    async send(command) {
      commands.push(command);
      if (fail(command)) throw timeout();
      const answer = await inner.send(command);
      if (failAfter(command)) throw timeout();
      return answer;
    },
  };
  const store = createS3Store({ bucket: 'acme-bucket', client });
  const memory = createS3Store({ bucket: 'acme-bucket', client: inner });
  const clock = { ms: START + 60_000 };
  const adapter: Harness['adapter'] = {
    started: [],
    deleted: [],
    statuses: new Map(),
    jobs: [],
    startFails: false,
    async startRun(input) {
      adapter.started.push(input);
      if (adapter.startFails) throw new KubernetesError('The Debug Job could not be created.');
      if (!adapter.statuses.has(input.runId)) adapter.statuses.set(input.runId, readyStatus());
      return { jobName: `debug-it-${input.runId}`, secretName: `debug-it-${input.runId}` };
    },
    async deleteRun(id) {
      adapter.deleted.push(id);
    },
    async runStatus(id) {
      const status = adapter.statuses.get(id);
      if (status === 'error') throw new KubernetesError('The Debug Job could not be read.');
      return status ?? readyStatus({ exists: false, podIp: null, receiverRunning: false });
    },
    async listRunJobs() {
      return [...adapter.jobs];
    },
  };
  const step = jest.fn(async (_id: string, _target: UploadTarget): Promise<DownloadOutcome> => okOutcome());
  const probe = jest.fn(async (_host: string, _port: number) => true);
  const tracked: RunRecord[] = [];
  const forgotten: string[] = [];
  const started = new Set<string>();
  let listener: ((r: RunRecord) => void) | undefined;
  let gate = options.gate ?? ON;
  let key: string | null = API_KEY;
  const keys = options.personal
    ? createPersonalKeyService({
        store,
        adapter: createAnthropicAdapter({ mock: true }),
        encryptionKey: Buffer.alloc(32, 9),
        credentialsMode: 'personal',
      })
    : null;
  const lifecycle = createRunLifecycle({
    store,
    kubernetes: adapter,
    downloads: { fetchRunInputs: step },
    isolation: { status: () => gate },
    runs: {
      trackRun: (r) => tracked.push(JSON.parse(JSON.stringify(r))),
      forgetRun: (id) => forgotten.push(id),
      onRunCreated: (l) => {
        listener = l;
      },
      startedRunIds: () => started,
    },
    config: {
      limits: { ...DEBUG_IT_DEFAULTS.limits, ...options.limits },
      credentialsMode: options.personal ? 'personal' : 'organization',
    },
    ...(keys
      ? {
          apiKeyFor: async (githubUserId: number) => {
            const found = await keys.keyFor(githubUserId);
            return found.status === 'saved' ? found.key : null;
          },
          personalKeys: keys,
        }
      : { apiKeyFor: async () => key }),
    now: () => new Date(clock.ms),
    sleep: async (ms) => {
      clock.ms += ms;
    },
    probe,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  });
  return {
    lifecycle,
    memory,
    commands,
    setFail: (f) => {
      fail = f;
    },
    setFailAfter: (f) => {
      failAfter = f;
    },
    adapter,
    step,
    probe,
    tracked,
    forgotten,
    started,
    emit: (r) => listener?.(r),
    setGate: (s) => {
      gate = s;
    },
    setKey: (k) => {
      key = k;
    },
    clock,
    async seed(r, usage = true) {
      await memory.create(`runs/${r.runId}.json`, r);
      if (usage) {
        await memory.modify<UsageRecord>(r.usageKey, (current) => ({
          entries: [...(current?.entries ?? []), { runId: r.runId, costUsd: 0, fixPullRequests: 0 }],
        }));
      }
    },
    async read(n) {
      return (await memory.read<RunRecord>(`runs/${runId(n)}.json`))?.value ?? null;
    },
    async usage(key) {
      return (await memory.read<UsageRecord>(key))?.value ?? null;
    },
    keys,
  };
}

/** A predicate that matches only its first matching command. */
function once(match: (c: S3Command) => boolean): (c: S3Command) => boolean {
  let used = false;
  return (c) => {
    if (used || !match(c)) return false;
    used = true;
    return true;
  };
}

function runPut(n: number, state?: string): (c: S3Command) => boolean {
  return (c) =>
    c.name === 'PutObjectCommand' &&
    c.input.Key === `debug-it/runs/${runId(n)}.json` &&
    (state === undefined || String(c.input.Body).includes(`"state":"${state}"`));
}

function usagePut(c: S3Command): boolean {
  return c.name === 'PutObjectCommand' && String(c.input.Key).includes('usage/');
}

async function flush(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((done) => setImmediate(done));
}

function allLogs(): string {
  return [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

function audits(): string[] {
  return log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT]'));
}

let current: Harness | undefined;

function build(options: Parameters<typeof harness>[0] = {}): Harness {
  current = harness(options);
  return current;
}

beforeEach(() => {
  log.mockClear();
  warn.mockClear();
  error.mockClear();
});

afterEach(() => {
  current?.lifecycle.stop();
  current = undefined;
});

describe('queue', () => {
  test('4 waiting runs of 4 users, limit 3: the oldest 3 start, the 4th when one ends', async () => {
    const h = build();
    const gates: Array<(o: DownloadOutcome) => void> = [];
    h.step.mockImplementation(() => new Promise((done) => gates.push(done)));
    // Seeded newest first, so order comes from createdAt, not from S3 order.
    for (const n of [4, 3, 2, 1]) await h.seed(record(n, { requester: user(n), usageKey: usageKeyOf(user(n).githubUserId) }));
    await h.lifecycle.recover();
    await flush();
    expect(h.adapter.started.map((s) => s.runId)).toEqual([runId(1), runId(2), runId(3)]);
    expect((await h.read(4))!.state).toBe('waiting');
    expect(h.lifecycle.snapshot()).toEqual({ queued: [runId(4)], active: [runId(1), runId(2), runId(3)] });

    // Run 2's download fails: it ends, and run 4 starts.
    gates[1]!({ ok: false, reason: DOWNLOAD_ERRORS.log });
    await flush();
    expect((await h.read(2))!.state).toBe('failed');
    expect(h.adapter.started.map((s) => s.runId)).toEqual([runId(1), runId(2), runId(3), runId(4)]);
    expect((await h.read(4))!.state).toBe('cloning');
  });

  test('ties in createdAt start by run ID', async () => {
    const h = build({ limits: { maxConcurrentRuns: 1 } });
    const at = new Date(START).toISOString();
    for (const n of [3, 2]) await h.seed(record(n, { requester: user(n), usageKey: usageKeyOf(user(n).githubUserId), createdAt: at }));
    h.step.mockImplementation(() => new Promise(() => undefined));
    await h.lifecycle.recover();
    await flush();
    expect(h.adapter.started.map((s) => s.runId)).toEqual([runId(2)]);
  });

  test('per user limit 1: dana waits, another user\'s later run starts', async () => {
    const h = build();
    const gates: Array<(o: DownloadOutcome) => void> = [];
    h.step.mockImplementation(() => new Promise((done) => gates.push(done)));
    await h.seed(record(1));
    await h.seed(record(2));
    await h.seed(record(3, { requester: user(3), usageKey: usageKeyOf(user(3).githubUserId) }));
    await h.lifecycle.recover();
    await flush();
    expect(h.adapter.started.map((s) => s.runId)).toEqual([runId(1), runId(3)]);
    expect((await h.read(2))!.state).toBe('waiting');

    gates[0]!({ ok: false, reason: DOWNLOAD_ERRORS.log });
    await flush();
    expect(h.adapter.started.map((s) => s.runId)).toEqual([runId(1), runId(3), runId(2)]);
  });

  test('gate off: the run stays waiting until the gate is on', async () => {
    const h = build({ gate: CHECKING });
    await h.seed(record(1));
    await h.lifecycle.recover();
    await flush();
    expect((await h.read(1))!.state).toBe('waiting');
    expect(h.adapter.started).toEqual([]);
    h.setGate(ON);
    await h.lifecycle.monitor();
    await flush();
    expect((await h.read(1))!.state).toBe('analyzing');
  });

  test('nothing starts before recovery', async () => {
    const h = build();
    await h.seed(record(1));
    h.lifecycle.pump();
    await flush();
    expect(h.adapter.started).toEqual([]);
  });

  test('10 simultaneous onRunCreated events with limit 3: never more than 3 active', async () => {
    const h = build({ limits: { maxRunsPerUser: 10 } });
    let active = 0;
    let max = 0;
    h.step.mockImplementation(async () => {
      active += 1;
      max = Math.max(max, active);
      // Check the store too: at most 3 records in cloning/analyzing.
      const states = await Promise.all(Array.from({ length: 10 }, (_v, i) => h.read(i + 1)));
      const busy = states.filter((s) => s && (s.state === 'cloning' || s.state === 'analyzing')).length;
      expect(busy).toBeLessThanOrEqual(3);
      await flush(5);
      active -= 1;
      return { ok: false, reason: DOWNLOAD_ERRORS.log };
    });
    const records = Array.from({ length: 10 }, (_v, i) => record(i + 1));
    for (const r of records) await h.seed(r);
    h.lifecycle.start();
    await flush(50);
    for (const r of records) {
      h.emit(r);
      h.lifecycle.pump();
    }
    await flush(2000);
    expect(max).toBeLessThanOrEqual(3);
    expect(h.adapter.started).toHaveLength(10);
    for (let n = 1; n <= 10; n += 1) expect((await h.read(n))!.state).toBe('failed');
  });
});

describe('leaving waiting', () => {
  test('happy path: cloning with hash and deadline, Job with the org key, upload, analyzing', async () => {
    const h = build();
    // The pod gets its IP and running receiver on the third poll.
    let polls = 0;
    h.adapter.runStatus = async () => {
      polls += 1;
      return polls < 3 ? readyStatus({ podIp: null, receiverRunning: false }) : readyStatus();
    };
    let cloningSeen: RunRecord | null = null;
    h.step.mockImplementation(async (id) => {
      cloningSeen = (await h.memory.read<RunRecord>(`runs/${id}.json`))!.value;
      return okOutcome();
    });
    h.lifecycle.start();
    await flush(20);
    await h.seed(record(1));
    h.emit(record(1));
    await flush();

    const input = h.adapter.started[0]!;
    expect(input.anthropicApiKey).toBe(API_KEY);
    expect(input.timeLimitSeconds).toBe(900);
    expect(input.spendLimitUsd).toBe(2);
    expect(input.uploadCode).toHaveLength(43);
    expect(input.resultCode).toHaveLength(43);
    expect(input.uploadCode).not.toBe(input.resultCode);
    const seen = cloningSeen as RunRecord | null;
    expect(seen!.state).toBe('cloning');
    expect(seen!.resultCodeHash).toBe(hashResultCode(input.resultCode));
    expect(seen!.deadlineAt).toBe(input.deadlineAt.toISOString());
    expect(input.deadlineAt.getTime()).toBe(START + 60_000 + 15 * MINUTE);

    expect(h.step).toHaveBeenCalledWith(runId(1), { baseUrl: 'http://10.0.0.12:8080', uploadCode: input.uploadCode });
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledWith('10.0.0.12', 8080);
    expect(polls).toBe(3);
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('analyzing');
    expect(audits()).toEqual([
      `[AUDIT] Debug it run ${runId(1)} waiting -> cloning`,
      `[AUDIT] Debug it run ${runId(1)} cloning -> analyzing`,
    ]);
    expect(h.tracked.map((r) => r.state)).toEqual(['cloning', 'analyzing']);
    for (const secret of [input.uploadCode, input.resultCode, API_KEY, stored.resultCodeHash as string]) {
      expect(allLogs()).not.toContain(secret);
    }
    expect(JSON.stringify(stored)).not.toContain(input.uploadCode);
    expect(JSON.stringify(stored)).not.toContain(input.resultCode);
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
  });

  test('an IPv6 pod address is put in brackets', async () => {
    const h = build();
    await h.seed(record(1));
    h.adapter.statuses.set(runId(1), readyStatus({ podIp: 'fd00::12' }));
    await h.lifecycle.recover();
    await flush();
    expect(h.probe).toHaveBeenCalledWith('fd00::12', 8080);
    expect(h.step.mock.calls[0]![1].baseUrl).toBe('http://[fd00::12]:8080');
  });

  test('download failure: failed with its reason, usage given back, Job deleted', async () => {
    const h = build();
    await h.seed(record(1));
    await h.memory.create(usageKeyOf(1000099), { entries: [] });
    await h.memory.modify<UsageRecord>(usageKeyOf(DANA.githubUserId), (c) => ({
      entries: [...c!.entries, { runId: 'other-run', costUsd: 0.1, fixPullRequests: 0 }],
    }));
    // A run of another process start in flight: orphan removal keeps it.
    h.started.add('other-run');
    h.step.mockResolvedValue({ ok: false, reason: DOWNLOAD_ERRORS.log });
    await h.lifecycle.recover();
    await flush();
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(DOWNLOAD_ERRORS.log);
    expect(stored.resultCodeHash).toBeNull();
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries.map((e) => e.runId)).toEqual(['other-run']);
    expect(h.adapter.deleted).toEqual([runId(1)]);
    expect(audits()).toContain(`[AUDIT] Debug it run ${runId(1)} cloning -> failed: ${DOWNLOAD_ERRORS.log}`);
    expect(h.lifecycle.snapshot().active).toEqual([]);
  });

  test('a repeated give-back is a no-op', async () => {
    const h = build();
    // The entry was already given back (an earlier answer was lost).
    await h.seed(record(1), false);
    await h.memory.create(usageKeyOf(DANA.githubUserId), { entries: [{ runId: 'other-run', costUsd: 0, fixPullRequests: 0 }] });
    h.started.add('other-run');
    h.step.mockResolvedValue({ ok: false, reason: DOWNLOAD_ERRORS.log });
    await h.lifecycle.recover();
    await flush();
    expect((await h.read(1))!.state).toBe('failed');
    const usagePuts = h.commands.filter((c) => c.name === 'PutObjectCommand' && String(c.input.Key).includes('usage/'));
    expect(usagePuts).toEqual([]);
  });

  test('no key: failed, given back, no Job', async () => {
    const h = build();
    h.setKey(null);
    await h.seed(record(1));
    await h.lifecycle.recover();
    await flush();
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(LIFECYCLE_ERRORS.noKey);
    expect(h.adapter.started).toEqual([]);
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([]);
  });

  test('a Job create error: failed, given back', async () => {
    const h = build();
    h.adapter.startFails = true;
    await h.seed(record(1));
    await h.lifecycle.recover();
    await flush();
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(LIFECYCLE_ERRORS.jobCreate);
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([]);
    expect(h.adapter.deleted).toEqual([runId(1)]);
  });

  test('the receiver never gets ready: failed after 5 minutes', async () => {
    const h = build();
    await h.seed(record(1));
    h.adapter.statuses.set(runId(1), readyStatus({ podIp: null, receiverRunning: false }));
    await h.lifecycle.recover();
    await flush(2000);
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(LIFECYCLE_ERRORS.receiverTimeout);
    expect(h.clock.ms - (START + 60_000)).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(h.clock.ms - (START + 60_000)).toBeLessThan(5 * MINUTE + 5_000);
    expect(h.step).not.toHaveBeenCalled();
  });

  test('the receiver port never opens: failed after 5 minutes', async () => {
    const h = build();
    h.probe.mockResolvedValue(false);
    await h.seed(record(1));
    await h.lifecycle.recover();
    await flush(2000);
    expect((await h.read(1))!.failureReason).toBe(LIFECYCLE_ERRORS.receiverTimeout);
  });

  test('the Job ends before the receiver is ready: failed', async () => {
    const h = build();
    await h.seed(record(1));
    h.adapter.statuses.set(runId(1), readyStatus({ failed: true, podIp: null }));
    await h.lifecycle.recover();
    await flush();
    expect((await h.read(1))!.failureReason).toBe(LIFECYCLE_ERRORS.receiverEnded);
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([]);
  });

  test('a run that is no longer waiting is not started', async () => {
    const h = build();
    await h.seed(record(1));
    h.lifecycle.start();
    await flush();
    await h.memory.modify<RunRecord>(`runs/${runId(2)}.json`, () => record(2, { state: 'finished' }));
    h.emit(record(2));
    await flush();
    expect(h.adapter.started.map((s) => s.runId)).toEqual([runId(1)]);
    expect((await h.read(2))!.state).toBe('finished');
  });
});

describe('S3 failures while starting', () => {
  test('the cloning write lands but its answer is lost: the run still reaches analyzing, one Job', async () => {
    const h = build();
    await h.seed(record(1));
    h.setFailAfter(once(runPut(1, 'cloning')));
    await h.lifecycle.recover();
    await flush();
    expect((await h.read(1))!.state).toBe('analyzing');
    expect(h.adapter.started).toHaveLength(1);
    expect(audits()).toContain(`[AUDIT] Debug it run ${runId(1)} waiting -> cloning`);
  });

  test('the cloning write fails without storing: back in the queue, started on the next monitor tick', async () => {
    const h = build();
    await h.seed(record(1));
    h.setFail(once(runPut(1, 'cloning')));
    await h.lifecycle.recover();
    await flush();
    expect((await h.read(1))!.state).toBe('waiting');
    expect(h.lifecycle.snapshot()).toEqual({ queued: [runId(1)], active: [] });
    expect(h.adapter.started).toEqual([]);
    await h.lifecycle.monitor();
    await flush();
    expect((await h.read(1))!.state).toBe('analyzing');
    expect(h.adapter.started).toHaveLength(1);
  });

  test('the cloning write lands and the read-back fails: on the next tick it ends failed and given back', async () => {
    const h = build();
    await h.seed(record(1));
    let lost = false;
    const cloningPut = once(runPut(1, 'cloning'));
    h.setFailAfter((c) => {
      const hit = cloningPut(c);
      if (hit) lost = true;
      return hit;
    });
    const readBack = once((c) => lost && c.name === 'GetObjectCommand' && c.input.Key === `debug-it/runs/${runId(1)}.json`);
    h.setFail(readBack);
    await h.lifecycle.recover();
    await flush();
    expect((await h.read(1))!.state).toBe('cloning');
    expect(h.lifecycle.snapshot().queued).toEqual([runId(1)]);
    await h.lifecycle.monitor();
    await flush();
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(LIFECYCLE_ERRORS.s3);
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([]);
    expect(h.adapter.started).toEqual([]);
    expect(h.adapter.deleted).toEqual([runId(1)]);
    expect(h.lifecycle.snapshot()).toEqual({ queued: [], active: [] });
  });

  test('the cloning -> failed write fails once: kept active, the monitor fails it with the original reason', async () => {
    const h = build();
    await h.seed(record(1));
    h.step.mockResolvedValue({ ok: false, reason: DOWNLOAD_ERRORS.log });
    h.setFail(runPut(1, 'failed'));
    await h.lifecycle.recover();
    await flush();
    expect((await h.read(1))!.state).toBe('cloning');
    expect(h.lifecycle.snapshot().active).toEqual([runId(1)]);
    expect(h.adapter.deleted).toEqual([]);
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toHaveLength(1);
    h.setFail(() => false);
    await h.lifecycle.monitor();
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(DOWNLOAD_ERRORS.log);
    expect(h.adapter.deleted).toEqual([runId(1)]);
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([]);
    expect(h.lifecycle.snapshot().active).toEqual([]);
  });

  test('the give-back write fails: the entry stays, the monitor removes it', async () => {
    const h = build();
    await h.seed(record(1));
    h.step.mockResolvedValue({ ok: false, reason: DOWNLOAD_ERRORS.log });
    h.setFail(usagePut);
    await h.lifecycle.recover();
    await flush();
    expect((await h.read(1))!.state).toBe('failed');
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries.map((e) => e.runId)).toEqual([runId(1)]);
    h.setFail(() => false);
    await h.lifecycle.monitor();
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([]);
  });
});

describe('finishing', () => {
  async function analyzing(h: Harness, overrides: Partial<RunRecord> = {}): Promise<RunRecord> {
    const r = record(1, { state: 'analyzing', resultCodeHash: 'a'.repeat(64), ...overrides });
    await h.seed(r);
    h.adapter.statuses.set(r.runId, readyStatus());
    await h.lifecycle.recover();
    await flush();
    return r;
  }

  test('result none: usage cost set, finished, one audit line, Job deleted', async () => {
    const h = build();
    await analyzing(h);
    expect(h.lifecycle.snapshot().active).toEqual([runId(1)]);
    const accepted = { ...(await h.read(1))!, result: result(), resultCodeHash: null };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => accepted);
    log.mockClear();
    await h.lifecycle.onResultAccepted(accepted);
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('finished');
    expect(stored.result).toEqual(result());
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([
      { runId: runId(1), costUsd: 0.42, fixPullRequests: 0 },
    ]);
    expect(audits()).toEqual([`[AUDIT] Debug it run ${runId(1)} analyzing -> finished`]);
    expect(h.adapter.deleted).toEqual([runId(1)]);
    expect(h.lifecycle.snapshot().active).toEqual([]);
    expect(allLogs()).not.toContain(API_KEY);
    expect(allLogs()).not.toContain(result().explanation);
  });

  test('the usage write fails: stays analyzing, the monitor retries', async () => {
    const h = build();
    await analyzing(h);
    const accepted = { ...(await h.read(1))!, result: result() };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => accepted);
    h.setFail((c) => c.name === 'PutObjectCommand' && String(c.input.Key).includes('usage/'));
    await h.lifecycle.onResultAccepted(accepted);
    expect((await h.read(1))!.state).toBe('analyzing');
    expect(h.adapter.deleted).toEqual([]);
    h.setFail(() => false);
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('finished');
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries[0]!.costUsd).toBe(0.42);
  });

  test.each([
    ['time-limit', LIFECYCLE_ERRORS.timeLimit],
    ['spend-limit', LIFECYCLE_ERRORS.spendLimit],
    ['error', LIFECYCLE_ERRORS.error],
  ] as const)('result %s: failed with its sentence, result kept', async (reason, sentence) => {
    const h = build();
    await analyzing(h);
    const accepted = { ...(await h.read(1))!, result: result({ failureReason: reason, costUsd: 2 }) };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => accepted);
    await h.lifecycle.onResultAccepted(accepted);
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(sentence);
    expect(stored.result).toEqual(result({ failureReason: reason, costUsd: 2 }));
    expect(audits()).toContain(`[AUDIT] Debug it run ${runId(1)} analyzing -> failed: ${sentence}`);
    // Give-back happens only for runs ending from cloning.
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([
      { runId: runId(1), costUsd: 2, fixPullRequests: 0 },
    ]);
  });

  test('an accepted result: no log line or record field holds the upload code, result code or key', async () => {
    const h = build();
    await h.seed(record(1));
    await h.lifecycle.recover();
    await flush();
    const input = h.adapter.started[0]!;
    const accepted = { ...(await h.read(1))!, result: result(), resultCodeHash: null };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => accepted);
    await h.lifecycle.onResultAccepted(accepted);
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('finished');
    const objects = await Promise.all(
      [...(await h.memory.list('runs/')), ...(await h.memory.list('usage/'))].map(async (k) => JSON.stringify((await h.memory.read(k))!.value)),
    );
    const everything = `${allLogs()}\n${objects.join('\n')}\n${JSON.stringify(h.tracked)}`;
    for (const secret of [input.uploadCode, input.resultCode, API_KEY, hashResultCode(input.uploadCode)]) {
      expect(everything).not.toContain(secret);
    }
    // The hash was in the record only while the run waited for its result.
    expect(allLogs()).not.toContain(hashResultCode(input.resultCode));
    expect(stored.resultCodeHash).toBeNull();
  });

  test('a final run is never changed by a stale transition', async () => {
    const h = build();
    const finished = record(1, { state: 'finished', result: result() });
    await h.seed(finished);
    await h.lifecycle.recover();
    const runPuts = (): number =>
      h.commands.filter((c) => c.name === 'PutObjectCommand' && String(c.input.Key).includes('runs/')).length;
    const before = runPuts();
    await h.lifecycle.onResultAccepted({ ...finished, state: 'analyzing', result: result({ failureReason: 'error' }) });
    expect(runPuts()).toBe(before);
    expect((await h.read(1))!.state).toBe('finished');
  });

  test('story 6.1: a run ending from a result is recorded once for telemetry with the result numbers', async () => {
    const recordRun = jest.fn((_run: TelemetryRun) => undefined);
    const h = build({ telemetry: { recordRun } });
    await analyzing(h);
    const accepted = { ...(await h.read(1))!, result: result(), resultCodeHash: null };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => accepted);
    await h.lifecycle.onResultAccepted(accepted);
    // A repeated hook and a monitor tick change nothing.
    await h.lifecycle.onResultAccepted(accepted);
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('finished');
    expect(recordRun.mock.calls).toEqual([
      [{ runId: runId(1), repository: REPO, login: 'dana', costUsd: 0.42, inputTokens: 1200, outputTokens: 300 }],
    ]);
    expect(JSON.stringify(recordRun.mock.calls)).not.toContain(result().explanation);
  });

  test('story 6.1: a result with a failure reason is recorded too', async () => {
    const recordRun = jest.fn((_run: TelemetryRun) => undefined);
    const h = build({ telemetry: { recordRun } });
    await analyzing(h);
    const accepted = { ...(await h.read(1))!, result: result({ failureReason: 'spend-limit', costUsd: 2 }) };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => accepted);
    await h.lifecycle.onResultAccepted(accepted);
    expect((await h.read(1))!.state).toBe('failed');
    expect(recordRun).toHaveBeenCalledTimes(1);
    expect(recordRun.mock.calls[0]![0]).toMatchObject({ costUsd: 2 });
  });

  test('story 6.1: telemetry that throws leaves the run finished, the usage set and the slot freed', async () => {
    const recordRun = jest.fn((_run: TelemetryRun) => {
      throw new Error('collector down');
    });
    const h = build({ telemetry: { recordRun } });
    await analyzing(h);
    const accepted = { ...(await h.read(1))!, result: result(), resultCodeHash: null };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => accepted);
    await h.lifecycle.onResultAccepted(accepted);
    expect(recordRun).toHaveBeenCalledTimes(1);
    expect((await h.read(1))!.state).toBe('finished');
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries[0]!.costUsd).toBe(0.42);
    expect(h.adapter.deleted).toEqual([runId(1)]);
    expect(h.lifecycle.snapshot().active).toEqual([]);
  });

  test('story 6.1: the final write failing records nothing until it lands', async () => {
    const recordRun = jest.fn((_run: TelemetryRun) => undefined);
    const h = build({ telemetry: { recordRun } });
    await analyzing(h);
    const accepted = { ...(await h.read(1))!, result: result() };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => accepted);
    h.setFail(runPut(1, 'finished'));
    await h.lifecycle.onResultAccepted(accepted);
    expect(recordRun).not.toHaveBeenCalled();
    h.setFail(() => false);
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('finished');
    expect(recordRun).toHaveBeenCalledTimes(1);
  });

  test('onRunFailed deletes the Job and frees the slot', async () => {
    const h = build({ limits: { maxConcurrentRuns: 1 } });
    await analyzing(h);
    await h.seed(record(2, { requester: user(2), usageKey: usageKeyOf(user(2).githubUserId) }));
    h.lifecycle.start();
    h.emit(record(2));
    h.lifecycle.pump();
    await flush();
    // The listener queued it, but the one slot is held by run 1.
    expect(h.lifecycle.snapshot()).toEqual({ queued: [runId(2)], active: [runId(1)] });
    expect((await h.read(2))!.state).toBe('waiting');
    const failed = { ...(await h.read(1))!, state: 'failed' as const };
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, () => failed);
    await h.lifecycle.onRunFailed(failed);
    await flush();
    expect(h.adapter.deleted).toContain(runId(1));
    expect((await h.read(2))!.state).toBe('analyzing');
  });
});

describe('monitor', () => {
  async function analyzing(h: Harness): Promise<void> {
    await h.seed(record(1, { state: 'analyzing', resultCodeHash: 'a'.repeat(64), deadlineAt: new Date(START + 15 * MINUTE).toISOString() }));
    h.adapter.statuses.set(runId(1), readyStatus());
    await h.lifecycle.recover();
  }

  test('no result: Job failed and pod ended, failed noResult 30 s later', async () => {
    const h = build();
    await analyzing(h);
    h.adapter.statuses.set(runId(1), readyStatus({ failed: true, podEndedAt: '2026-11-05T10:05:00.000Z' }));
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('analyzing');
    h.clock.ms += 29_000;
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('analyzing');
    h.clock.ms += 1_000;
    await h.lifecycle.monitor();
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(LIFECYCLE_ERRORS.noResult);
    expect(h.adapter.deleted).toEqual([runId(1)]);
    // Not given back: the run ended from analyzing.
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toHaveLength(1);
  });

  test('story 6.1: a run failed without a result, or from cloning, records nothing for telemetry', async () => {
    const recordRun = jest.fn((_run: TelemetryRun) => undefined);
    const h = build({ telemetry: { recordRun } });
    await h.seed(record(2, { requester: user(2), usageKey: usageKeyOf(user(2).githubUserId) }));
    h.step.mockResolvedValue({ ok: false, reason: DOWNLOAD_ERRORS.log });
    await analyzing(h);
    await flush();
    expect((await h.read(2))!.state).toBe('failed');
    h.adapter.statuses.set(runId(1), readyStatus({ exists: false, podIp: null, receiverRunning: false }));
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('failed');
    expect(recordRun).not.toHaveBeenCalled();
  });

  test('no result after the deadline: failed deadline', async () => {
    const h = build();
    await analyzing(h);
    h.adapter.statuses.set(runId(1), readyStatus({ failed: true, deadlineExceeded: true }));
    await h.lifecycle.monitor();
    h.clock.ms += 30_000;
    await h.lifecycle.monitor();
    expect((await h.read(1))!.failureReason).toBe(LIFECYCLE_ERRORS.deadline);
  });

  test('a Kubernetes error skips the run until the next tick', async () => {
    const h = build();
    await analyzing(h);
    h.adapter.statuses.set(runId(1), 'error');
    await h.lifecycle.monitor();
    h.clock.ms += 60_000;
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('analyzing');
    h.adapter.statuses.set(runId(1), readyStatus({ podEndedAt: '2026-11-05T10:05:00.000Z' }));
    await h.lifecycle.monitor();
    h.clock.ms += 30_000;
    await h.lifecycle.monitor();
    expect((await h.read(1))!.failureReason).toBe(LIFECYCLE_ERRORS.noResult);
  });

  test('a result that lands within the 30 s finishes the run', async () => {
    const h = build();
    await analyzing(h);
    h.adapter.statuses.set(runId(1), readyStatus({ podEndedAt: '2026-11-05T10:05:00.000Z' }));
    await h.lifecycle.monitor();
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, (c) => ({ ...c!, result: result(), resultCodeHash: null }));
    h.clock.ms += 30_000;
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('finished');
  });

  test('the Job is gone: failed jobGone', async () => {
    const h = build();
    await analyzing(h);
    h.adapter.statuses.delete(runId(1));
    await h.lifecycle.monitor();
    expect((await h.read(1))!.failureReason).toBe(LIFECYCLE_ERRORS.jobGone);
  });

  test('lost hook: an analyzing run with a result is finished by the monitor', async () => {
    const h = build();
    await analyzing(h);
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, (c) => ({ ...c!, result: result(), resultCodeHash: null }));
    await h.lifecycle.monitor();
    expect((await h.read(1))!.state).toBe('finished');
  });

  test('stuck past deadline + 5 min: one [WARN]', async () => {
    const h = build();
    await analyzing(h);
    h.clock.ms = START + 15 * MINUTE + 5 * MINUTE + 1;
    await h.lifecycle.monitor();
    await h.lifecycle.monitor();
    const lines = warn.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes('past its deadline'));
    expect(lines).toEqual([`[WARN] Debug it run ${runId(1)} is still analyzing more than 5 minutes past its deadline.`]);
  });
});

describe('recover', () => {
  test('restart: cloning / analyzing+Job / analyzing without Job / waiting', async () => {
    const h = build({ gate: CHECKING });
    await h.seed(record(1, { state: 'cloning', resultCodeHash: 'b'.repeat(64) }));
    await h.seed(record(2, { state: 'analyzing', requester: user(2), usageKey: usageKeyOf(user(2).githubUserId) }));
    await h.seed(record(3, { state: 'analyzing', requester: user(3), usageKey: usageKeyOf(user(3).githubUserId) }));
    await h.seed(record(4, { requester: user(4), usageKey: usageKeyOf(user(4).githubUserId) }));
    h.adapter.statuses.set(runId(2), readyStatus());
    expect(await h.lifecycle.recover()).toBe(true);

    const cloning = (await h.read(1))!;
    expect(cloning.state).toBe('failed');
    expect(cloning.failureReason).toBe(LIFECYCLE_ERRORS.restarted);
    expect(cloning.resultCodeHash).toBeNull();
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([]);
    expect(h.adapter.deleted).toContain(runId(1));

    expect((await h.read(2))!.state).toBe('analyzing');
    expect((await h.read(3))!.failureReason).toBe(LIFECYCLE_ERRORS.jobGone);
    // Analyzing runs are not given back.
    expect((await h.usage(usageKeyOf(user(3).githubUserId)))!.entries).toHaveLength(1);
    expect((await h.read(4))!.state).toBe('waiting');
    expect(h.lifecycle.snapshot()).toEqual({ queued: [runId(4)], active: [runId(2)] });
    expect(h.tracked.map((r) => [r.runId, r.state])).toEqual(
      expect.arrayContaining([
        [runId(2), 'analyzing'],
        [runId(4), 'waiting'],
      ]),
    );
  });

  test('final records are tracked at recovery, for the latest run per target (story 3.11)', async () => {
    const h = build();
    await h.seed(record(1, { state: 'finished' }));
    await h.seed(record(2, { state: 'failed', failureReason: LIFECYCLE_ERRORS.jobGone }));
    await h.lifecycle.recover();
    expect(h.tracked.map((r) => [r.runId, r.state])).toEqual(
      expect.arrayContaining([
        [runId(1), 'finished'],
        [runId(2), 'failed'],
      ]),
    );
  });

  test('analyzing with Kubernetes unreachable: kept and monitored', async () => {
    const h = build();
    await h.seed(record(1, { state: 'analyzing' }));
    h.adapter.statuses.set(runId(1), 'error');
    await h.lifecycle.recover();
    expect((await h.read(1))!.state).toBe('analyzing');
    expect(h.lifecycle.snapshot().active).toEqual([runId(1)]);
  });

  test('lost hook: analyzing with a result is finished by recovery', async () => {
    const h = build();
    await h.seed(record(1, { state: 'analyzing', result: result({ costUsd: 0.3 }) }));
    await h.lifecycle.recover();
    expect((await h.read(1))!.state).toBe('finished');
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries[0]!.costUsd).toBe(0.3);
  });

  test('orphan usage entries of the current month are removed; past months and runs started this boot are kept', async () => {
    const h = build();
    await h.seed(record(1, { state: 'finished' }));
    await h.memory.modify<UsageRecord>(usageKeyOf(DANA.githubUserId), (c) => ({
      entries: [
        ...c!.entries,
        { runId: runId(7), costUsd: 0, fixPullRequests: 0 },
        { runId: runId(8), costUsd: 0, fixPullRequests: 0 },
      ],
    }));
    await h.memory.create(usageKeyOf(1000005, '2026-10'), { entries: [{ runId: runId(9), costUsd: 1, fixPullRequests: 0 }] });
    h.started.add(runId(8));
    await h.lifecycle.recover();
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries.map((e) => e.runId)).toEqual([runId(1), runId(8)]);
    // A past month's entry whose record retention deleted keeps its cost history.
    expect((await h.usage(usageKeyOf(1000005, '2026-10')))!.entries).toEqual([
      { runId: runId(9), costUsd: 1, fixPullRequests: 0 },
    ]);
  });

  test('an S3 failure is retried on the next monitor tick; nothing starts before', async () => {
    const h = build();
    await h.seed(record(1));
    h.setFail((c) => c.name === 'ListObjectsV2Command');
    expect(await h.lifecycle.recover()).toBe(false);
    h.lifecycle.pump();
    await flush();
    expect(h.adapter.started).toEqual([]);
    h.setFail(() => false);
    await h.lifecycle.monitor();
    await flush();
    expect((await h.read(1))!.state).toBe('analyzing');
  });
});

describe('sweep and retention', () => {
  test('retention keeps a final record over 30 days old created in the current UTC month', async () => {
    const h = build();
    h.clock.ms = Date.parse('2026-12-31T23:00:00.000Z');
    await h.seed(record(1, { state: 'failed', createdAt: '2026-12-01T00:00:00.000Z' }));
    await h.seed(record(2, { state: 'failed', createdAt: '2026-11-30T23:00:00.000Z' }));
    await h.lifecycle.retention();
    expect((await h.read(1))!.state).toBe('failed');
    expect(await h.read(2)).toBeNull();
  });

  test('sweep deletes Jobs of final runs and of runs with no record', async () => {
    const h = build();
    await h.seed(record(1, { state: 'failed' }));
    await h.seed(record(2, { state: 'analyzing' }));
    h.adapter.jobs = [runId(1), runId(2), runId(3)];
    await h.lifecycle.sweep();
    expect(h.adapter.deleted).toEqual([runId(1), runId(3)]);
  });

  test('retention deletes only final records over 30 days old, every version', async () => {
    const h = build();
    h.clock.ms = START;
    await h.seed(record(1, { state: 'failed', createdAt: new Date(START - 31 * DAY).toISOString() }));
    await h.seed(record(2, { state: 'finished', createdAt: new Date(START - 29 * DAY).toISOString() }));
    await h.seed(record(3, { state: 'analyzing', createdAt: new Date(START - 40 * DAY).toISOString() }));
    await h.memory.modify<RunRecord>(`runs/${runId(1)}.json`, (c) => ({ ...c!, updatedAt: 'x' }));
    await h.lifecycle.retention();
    expect(await h.read(1)).toBeNull();
    expect((await h.read(2))!.state).toBe('finished');
    expect((await h.read(3))!.state).toBe('analyzing');
    const versions = h.commands.filter((c) => c.name === 'DeleteObjectCommand').map((c) => c.input.VersionId);
    expect(versions).toHaveLength(2);
    expect(audits()).toEqual([`[AUDIT] Debug it run ${runId(1)} record deleted after 30 days`]);
    // The run service forgets only the deleted run (story 3.11).
    expect(h.forgotten).toEqual([runId(1)]);
  });
});

describe('personal key mode (story 5.1)', () => {
  const DANA_KEY = 'sk-ant-api03-dana-personal-key-acme-WXYZ';
  const LEE_KEY = 'sk-ant-api03-lee-personal-key-acme-ABCD';
  const LEE = user(2);

  test('the Job gets the requester\'s decrypted key, read when the run leaves waiting', async () => {
    const h = build({ personal: true });
    expect((await h.keys!.save(DANA.githubUserId, { key: DANA_KEY })).ok).toBe(true);
    expect((await h.keys!.save(LEE.githubUserId, { key: LEE_KEY })).ok).toBe(true);
    await h.seed(record(1));
    await h.seed(record(2, { requester: LEE, usageKey: usageKeyOf(LEE.githubUserId) }));
    await h.lifecycle.recover();
    await flush();
    const byRun = new Map(h.adapter.started.map((s) => [s.runId, s.anthropicApiKey]));
    expect(byRun.get(runId(1))).toBe(DANA_KEY);
    expect(byRun.get(runId(2))).toBe(LEE_KEY);
    expect(allLogs()).not.toContain(DANA_KEY);
    expect(JSON.stringify(await h.read(1))).not.toContain(DANA_KEY);
  });

  test('key deleted before the run leaves waiting: failed from cloning with the personal reason, given back, no Job', async () => {
    const h = build({ personal: true });
    await h.keys!.save(DANA.githubUserId, { key: DANA_KEY });
    await h.keys!.remove(DANA.githubUserId);
    await h.seed(record(1));
    await h.lifecycle.recover();
    await flush();
    const stored = (await h.read(1))!;
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe(LIFECYCLE_ERRORS.noPersonalKey);
    expect(h.adapter.started).toEqual([]);
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries).toEqual([]);
  });

  test('an S3 failure reading the key fails the run from cloning, no Job', async () => {
    const h = build({ personal: true });
    await h.keys!.save(DANA.githubUserId, { key: DANA_KEY });
    await h.seed(record(1));
    h.setFail((c) => c.name === 'GetObjectCommand' && String(c.input.Key).includes('personal-keys/'));
    await h.lifecycle.recover();
    await flush();
    h.setFail(() => false);
    await flush();
    expect((await h.read(1))!.failureReason).toBe(LIFECYCLE_ERRORS.s3);
    expect(h.adapter.started).toEqual([]);
  });

  test('deleting a key cancels only that user\'s waiting runs, without giving back usage', async () => {
    const h = build({ personal: true });
    await h.keys!.save(DANA.githubUserId, { key: DANA_KEY });
    await h.keys!.save(LEE.githubUserId, { key: LEE_KEY });
    h.step.mockImplementation(() => new Promise(() => undefined));
    h.lifecycle.start();
    await flush(20);
    // Dana: run 1 starts, runs 2 and 3 wait (1 run per user). Lee: run 4 starts, run 5 waits.
    const lee = { requester: LEE, usageKey: usageKeyOf(LEE.githubUserId) };
    for (const r of [record(1), record(2), record(3), record(4, lee), record(5, lee)]) {
      await h.seed(r);
      h.emit(r);
    }
    await flush();
    expect(h.lifecycle.snapshot()).toEqual({ queued: [runId(2), runId(3), runId(5)], active: [runId(1), runId(4)] });

    const outcome = await h.keys!.remove(DANA.githubUserId);
    expect(outcome).toEqual({
      ok: true,
      body: { credentialsMode: 'personal', saved: false, last4: null, cancelledRuns: 2 },
    });
    for (const n of [2, 3]) {
      const stored = (await h.read(n))!;
      expect(stored.state).toBe('failed');
      expect(stored.failureReason).toBe(LIFECYCLE_ERRORS.personalKeyDeleted);
    }
    expect((await h.read(5))!.state).toBe('waiting');
    expect((await h.read(1))!.state).toBe('cloning');
    // AD-3: only runs ending in cloning are given back.
    expect((await h.usage(usageKeyOf(DANA.githubUserId)))!.entries.map((e) => e.runId)).toEqual(
      [1, 2, 3].map(runId),
    );
    expect(h.lifecycle.snapshot()).toEqual({ queued: [runId(5)], active: [runId(1), runId(4)] });
    expect(audits()).toContain(`[AUDIT] Debug it run ${runId(2)} waiting -> failed: ${LIFECYCLE_ERRORS.personalKeyDeleted}`);
  });

  test('a cancel write that fails leaves the run queued', async () => {
    const h = build({ personal: true, limits: { maxConcurrentRuns: 1 } });
    await h.keys!.save(DANA.githubUserId, { key: DANA_KEY });
    h.step.mockImplementation(() => new Promise(() => undefined));
    await h.seed(record(1));
    await h.seed(record(2));
    await h.lifecycle.recover();
    await flush();
    h.setFail(runPut(2, 'failed'));
    expect(await h.lifecycle.cancelWaitingRuns(DANA.githubUserId, LIFECYCLE_ERRORS.personalKeyDeleted)).toBe(0);
    expect(h.lifecycle.snapshot().queued).toEqual([runId(2)]);
    expect((await h.read(2))!.state).toBe('waiting');
  });
});

describe('getRunLifecycle (story 6.1)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetRunLifecycle();
    telemetryModule.resetTelemetryAdapter();
  });

  test('wires the process telemetry adapter with the cost telemetry settings', () => {
    resetRunLifecycle();
    telemetryModule.resetTelemetryAdapter();
    const fake = { enabled: false, recordRun: jest.fn(), flush: async () => undefined, stop: jest.fn() };
    const spy = jest.spyOn(telemetryModule, 'getTelemetryAdapter').mockReturnValue(fake);
    const env = { USE_MOCK_DATA: 'false' };
    getRunLifecycle(env);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(env, debugItConfig.costTelemetry);
  });
});
