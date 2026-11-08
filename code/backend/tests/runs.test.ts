import { createMemoryS3Client, createS3Store, type S3Client, type S3Command } from '../src/adapters/s3Store';
import {
  createMockGitHubApp,
  GitHubAppError,
  MOCK_CONTEXT_FILE,
  type GitHubApp,
  type GitHubUser,
  type RepositoryPermission,
} from '../src/adapters/githubApp';
import { DEBUG_IT_DEFAULTS, type DebugItConfig } from '../src/services/debugItConfig';
import { clearJobStore, keepFailedRun, upsert } from '../src/services/jobStore';
import { ISOLATION_REASONS, type IsolationStatus } from '../src/services/debugIt/isolation';
import {
  createRunService,
  getRunService,
  isRunId,
  parseFeedback,
  readFixPullRequests,
  readRunResult,
  resetDate,
  resetRunService,
  RUN_ERRORS,
  usageMonth,
  type ResolvedTarget,
  type RunRecord,
} from '../src/services/debugIt/runs';
import type { WorkflowJobEvent, WorkflowRunEvent } from '../src/types/webhook';
import { createSettingsService, type SettingsService } from '../src/services/debugIt/settings';
import { createAnthropicAdapter } from '../src/adapters/anthropic';
import { createPersonalKeyService, personalKeyKey } from '../src/services/debugIt/personalKeys';

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

const REPO = 'acme/payments-api';
const JOB_ID = 900001;
const WORKFLOW_RUN_ID = 700001;
const RUN_ID = 810001;
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const DANA = { githubUserId: 1000001, login: 'dana' };
const FAKE_TOKEN = 'ghs_fakeinstallationtokenfortests000';
const NOVEMBER = new Date('2026-11-05T10:00:00.000Z');
const ON: IsolationStatus = { state: 'on', reason: null, checkedAt: '2026-11-05T09:00:00.000Z' };

function failedJob(id = JOB_ID, options: { conclusion?: string; repository?: string; runId?: number } = {}): void {
  const now = new Date().toISOString();
  upsert({
    action: 'completed',
    workflow_job: {
      id,
      run_id: options.runId ?? WORKFLOW_RUN_ID,
      run_attempt: 1,
      name: 'test',
      status: 'completed',
      conclusion: options.conclusion ?? 'failure',
      head_sha: SHA,
      head_branch: 'feature/refunds',
      workflow_name: 'CI',
      created_at: now,
      started_at: now,
      completed_at: now,
      html_url: `https://github.com/${REPO}/actions/runs/${WORKFLOW_RUN_ID}/job/${id}`,
      run_url: '',
      labels: [],
      steps: [],
    },
    repository: { full_name: options.repository ?? REPO, name: 'payments-api', html_url: '', owner: { login: 'acme' } },
  } as unknown as WorkflowJobEvent);
}

function failedRun(id = RUN_ID, head: { sha: string | null; branch: string | null } = { sha: SHA, branch: 'main' }): void {
  const now = new Date().toISOString();
  keepFailedRun({
    action: 'completed',
    workflow_run: {
      id,
      run_attempt: 1,
      name: 'Deploy',
      head_branch: head.branch,
      head_sha: head.sha,
      html_url: `https://github.com/${REPO}/actions/runs/${id}`,
      created_at: now,
      updated_at: now,
      conclusion: 'startup_failure',
      event: 'push',
      head_repository: { full_name: REPO },
    },
    repository: { full_name: REPO },
  } as unknown as WorkflowRunEvent);
}

function fakeGitHub(overrides: Partial<GitHubApp> = {}) {
  const mock = createMockGitHubApp();
  return {
    ...mock,
    checkPermission: jest.fn(async (_user: GitHubUser, _repository: string): Promise<RepositoryPermission> => 'read'),
    readContextFile: jest.fn(mock.readContextFile),
    readWorkflowRun: jest.fn(async (repository: string, runId: number) => ({
      id: runId,
      headRepository: repository,
      headSha: SHA,
      headBranch: 'feature/refunds',
      path: '.github/workflows/ci.yml',
    })),
    ...overrides,
  };
}

// A memory client whose commands can be made to fail, recording every command.
function recordingClient(fail: (c: S3Command) => Error | undefined = () => undefined) {
  const inner = createMemoryS3Client();
  const commands: S3Command[] = [];
  const client: S3Client & { fail: typeof fail } = {
    fail,
    async send(command) {
      commands.push(command);
      const failure = client.fail(command);
      if (failure) throw failure;
      return inner.send(command);
    },
  };
  return { client, commands, inner };
}

function s3Down(): Error {
  const e = new Error('TimeoutError') as Error & { $metadata: object };
  e.name = 'TimeoutError';
  e.$metadata = {};
  return e;
}

interface BuildOptions {
  github?: ReturnType<typeof fakeGitHub>;
  config?: Partial<DebugItConfig>;
  isolation?: IsolationStatus;
  now?: Date;
  fail?: (c: S3Command) => Error | undefined;
  settings?: Pick<SettingsService, 'load' | 'isRepositoryAllowed'>;
  /** Personal key mode with a key store over the same bucket. */
  personalKeys?: boolean;
}

function build(options: BuildOptions = {}) {
  const { client, commands, inner } = recordingClient(options.fail);
  const store = createS3Store({ bucket: 'acme-bucket', client });
  const memory = createS3Store({ bucket: 'acme-bucket', client: inner });
  const github = options.github ?? fakeGitHub();
  let clock = options.now ?? NOVEMBER;
  let counter = 0;
  const keys = options.personalKeys
    ? createPersonalKeyService({
        store,
        adapter: createAnthropicAdapter({ mock: true }),
        encryptionKey: Buffer.alloc(32, 9),
        credentialsMode: 'personal',
      })
    : null;
  const service = createRunService({
    store,
    githubApp: github,
    config: { ...DEBUG_IT_DEFAULTS, ...options.config },
    isolation: { status: () => options.isolation ?? ON },
    organization: 'acme',
    ...(options.settings ? { settings: options.settings } : {}),
    ...(keys ? { personalKeys: keys } : {}),
    now: () => clock,
    newRunId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
  return {
    service,
    keys,
    inner,
    store,
    memory,
    client,
    commands,
    github,
    setClock: (d: Date) => {
      clock = d;
    },
    target: (kind: 'job' | 'run' = 'job', id: number = kind === 'job' ? JOB_ID : RUN_ID) =>
      service.findTarget(kind, String(id)) as ResolvedTarget,
    objects: async () => [...(await memory.list('usage/')), ...(await memory.list('runs/'))],
  };
}

async function seedUsage(memory: ReturnType<typeof build>['memory'], key: string, costs: number[]): Promise<void> {
  await memory.create(key, {
    entries: costs.map((costUsd, i) => ({ runId: `seed-${i}`, costUsd, fixPullRequests: 0 })),
  });
}

function allLogs(): string {
  return [...log.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

function audits(): string[] {
  return log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT] Debug it run'));
}

beforeEach(() => {
  clearJobStore();
  log.mockClear();
  error.mockClear();
  failedJob();
  failedRun();
});

describe('month helpers', () => {
  test('usage month and reset date are UTC', () => {
    expect(usageMonth(NOVEMBER)).toBe('2026-11');
    expect(resetDate(NOVEMBER)).toBe('2026-12-01');
    expect(resetDate(new Date('2026-12-31T23:59:59.000Z'))).toBe('2027-01-01');
    expect(usageMonth(new Date('2026-11-30T23:30:00.000-02:00'))).toBe('2026-12');
  });

  test('isRunId accepts only lower case UUIDs', () => {
    expect(isRunId('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isRunId('00000000-0000-4000-8000-00000000000A')).toBe(false);
    expect(isRunId('../settings')).toBe(false);
    expect(isRunId(42)).toBe(false);
  });
});

describe('findTarget', () => {
  test('a failed job comes from the webhook store', () => {
    const { service } = build();
    expect(service.findTarget('job', String(JOB_ID))).toEqual({
      kind: 'job',
      id: JOB_ID,
      repository: REPO,
      jobName: 'test',
      headSha: SHA,
      branch: 'feature/refunds',
      workflowRunId: WORKFLOW_RUN_ID,
    });
  });

  test('a failed run without jobs comes from the webhook store', () => {
    const { service } = build();
    expect(service.findTarget('run', String(RUN_ID))).toEqual({
      kind: 'run',
      id: RUN_ID,
      repository: REPO,
      jobName: 'Deploy',
      headSha: SHA,
      branch: 'main',
      workflowRunId: RUN_ID,
    });
  });

  test.each([
    ['job', '123'],
    ['run', String(JOB_ID)],
    ['job', String(RUN_ID)],
    ['jobs', String(JOB_ID)],
    ['job', '0'],
    ['job', '-1'],
    ['job', '1.5'],
    ['job', ' 900001'],
    ['job', '0900001'],
    ['job', '9007199254740993'],
    ['job', 'abc'],
  ])('%s %s is not found', (kind, id) => {
    expect(build().service.findTarget(kind, id)).toBeNull();
  });

  test('a successful job is not found', () => {
    failedJob(900002, { conclusion: 'success' });
    expect(build().service.findTarget('job', '900002')).toBeNull();
  });
});

describe('start: accepted', () => {
  test('a failed job: 201 waiting, one usage entry written before the run record', async () => {
    const { service, target, memory, commands, github } = build();
    const outcome = await service.start(target(), DANA);
    expect(outcome.status).toBe(201);
    const runId = '00000000-0000-4000-8000-000000000001';
    expect(outcome.body).toEqual({
      runId,
      target: { kind: 'job', id: JOB_ID },
      state: 'waiting',
      createdAt: NOVEMBER.toISOString(),
      updatedAt: NOVEMBER.toISOString(),
      elapsedMs: 0,
      repository: REPO,
      jobName: 'test',
      failureReason: null,
    });

    const usage = await memory.read<{ entries: unknown[] }>('usage/2026-11/1000001.json');
    expect(usage!.value).toEqual({ entries: [{ runId, costUsd: 0, fixPullRequests: 0 }] });
    const record = (await memory.read<RunRecord>(`runs/${runId}.json`))!.value;
    expect(record).toEqual({
      runId,
      target: { kind: 'job', id: JOB_ID },
      requester: DANA,
      state: 'waiting',
      createdAt: NOVEMBER.toISOString(),
      updatedAt: NOVEMBER.toISOString(),
      repository: REPO,
      headRepository: REPO,
      headSha: SHA,
      branch: 'feature/refunds',
      jobName: 'test',
      downloads: [],
      usageKey: 'usage/2026-11/1000001.json',
      resultCodeHash: null,
      result: null,
      feedback: null,
      fixPullRequests: [],
      failureReason: null,
    });

    const puts = commands.filter((c) => c.name === 'PutObjectCommand').map((c) => c.input.Key);
    expect(puts).toEqual(['debug-it/usage/2026-11/1000001.json', `debug-it/runs/${runId}.json`]);
    const runPut = commands.find((c) => c.name === 'PutObjectCommand' && String(c.input.Key).startsWith('debug-it/runs/'));
    expect(runPut!.input.IfNoneMatch).toBe('*');
    expect(github.readWorkflowRun).toHaveBeenCalledWith(REPO, WORKFLOW_RUN_ID);
    expect(audits()).toEqual([
      `[AUDIT] Debug it run ${runId} accepted for job ${JOB_ID} in ${REPO} by GitHub user 1000001`,
    ]);
  });

  test('a failed run without jobs: target kind run, job name is the run name', async () => {
    const { service, target, memory, github } = build();
    const outcome = await service.start(target('run'), DANA);
    expect(outcome.status).toBe(201);
    expect(outcome.body).toMatchObject({ target: { kind: 'run', id: RUN_ID }, jobName: 'Deploy' });
    const runId = (outcome.body as { runId: string }).runId;
    const record = (await memory.read<RunRecord>(`runs/${runId}.json`))!.value;
    expect(record).toMatchObject({ branch: 'main', headSha: SHA, jobName: 'Deploy' });
    expect(github.readWorkflowRun).toHaveBeenCalledWith(REPO, RUN_ID);
  });

  test('a run without commit or branch in the webhook record stores null, whatever GitHub says', async () => {
    failedRun(810002, { sha: null, branch: null });
    const { service, memory, github } = build();
    const outcome = await service.start(service.findTarget('run', '810002')!, DANA);
    expect(outcome.status).toBe(201);
    expect(github.readWorkflowRun).toHaveBeenCalledWith(REPO, 810002);
    const record = (await memory.read<RunRecord>(`runs/${(outcome.body as { runId: string }).runId}.json`))!.value;
    expect(record.headSha).toBeNull();
    expect(record.branch).toBeNull();
    expect(record.headRepository).toBe(REPO);
  });

  test('the head repository comes from GitHub, not the webhook record', async () => {
    const github = fakeGitHub({
      readWorkflowRun: jest.fn(async (_r: string, id: number) => ({
        id,
        headRepository: 'someone/payments-api',
        headSha: 'ffffffffffffffffffffffffffffffffffffffff',
        headBranch: 'other',
        path: null,
      })),
    });
    const { service, target, memory } = build({ github });
    const outcome = await service.start(target(), DANA);
    const record = (await memory.read<RunRecord>(`runs/${(outcome.body as { runId: string }).runId}.json`))!.value;
    expect(record.headRepository).toBe('someone/payments-api');
    // Commit and branch stay those of the signed webhook record.
    expect(record.headSha).toBe(SHA);
    expect(record.branch).toBe('feature/refunds');
  });

  test('the usage record keeps earlier entries and other fields', async () => {
    const { service, target, memory } = build();
    await seedUsage(memory, 'usage/2026-11/1000001.json', [0.5, 0.25]);
    expect((await service.start(target(), DANA)).status).toBe(201);
    const usage = await memory.read<{ entries: Array<{ runId: string }> }>('usage/2026-11/1000001.json');
    expect(usage!.value.entries.map((e) => e.runId)).toEqual(['seed-0', 'seed-1', '00000000-0000-4000-8000-000000000001']);
  });

  test('the spend limit allows a start below it', async () => {
    const { service, target, memory } = build({
      config: { limits: { ...DEBUG_IT_DEFAULTS.limits, organizationMonthlySpendLimitUsd: 10 } },
    });
    await seedUsage(memory, 'usage/2026-11/1000002.json', [4, 5.99]);
    await seedUsage(memory, 'usage/2026-10/1000002.json', [50]);
    expect((await service.start(target(), DANA)).status).toBe(201);
  });
});

describe('start: refusals write nothing', () => {
  test.each<[string, IsolationStatus]>([
    ['checking', { state: 'checking', reason: ISOLATION_REASONS.checking, checkedAt: null }],
    ['off', { state: 'off', reason: ISOLATION_REASONS.timeout, checkedAt: '2026-11-05T09:02:00.000Z' }],
  ])('gate %s: 503 with the gate reason', async (_name, isolation) => {
    const { service, target, objects, commands, github } = build({ isolation });
    const outcome = await service.start(target(), DANA);
    expect(outcome).toEqual({ status: 503, body: { error: isolation.reason } });
    expect(commands).toHaveLength(0);
    expect(github.readContextFile).not.toHaveBeenCalled();
    expect(await objects()).toEqual([]);
  });

  test.each([
    ['missing', { status: 'missing' as const }, `${REPO} has no debug context file`],
    ['empty', { status: 'found' as const, text: '  \n ' }, `${REPO} has an empty debug context file`],
    ['too large', { status: 'too-large' as const }, 'is larger than 64 KiB'],
  ])('context file %s: 409 with its reason', async (_name, answer, reason) => {
    const github = fakeGitHub({ readContextFile: jest.fn(async () => answer) });
    const { service, target, objects } = build({ github });
    const outcome = await service.start(target(), DANA);
    expect(outcome.status).toBe(409);
    expect((outcome.body as { error: string }).error).toContain(reason);
    expect(await objects()).toEqual([]);
  });

  test('context file GitHub failure: 502, only a GitHubAppError message is logged', async () => {
    const github = fakeGitHub({
      readContextFile: jest.fn(async () => {
        throw new Error(`socket hang up ${FAKE_TOKEN}`);
      }),
    });
    const { service, target, objects } = build({ github });
    expect(await service.start(target(), DANA)).toEqual({ status: 502, body: { error: RUN_ERRORS.github } });
    expect(await objects()).toEqual([]);
    expect(allLogs()).not.toContain(FAKE_TOKEN);
    expect(error.mock.calls.map((a) => a.join(' '))).toContain(
      '[ERROR] Debug it run could not start (debug context file): unknown error',
    );
  });

  test('personal key mode without a key store: 409', async () => {
    const { service, target, objects } = build({ config: { credentialsMode: 'personal' } });
    expect(await service.start(target(), DANA)).toEqual({ status: 409, body: { error: RUN_ERRORS.noPersonalKey } });
    expect(await objects()).toEqual([]);
  });

  describe('personal key mode (story 5.1)', () => {
    const KEY = 'sk-ant-api03-dana-personal-key-acme-WXYZ';
    const personal = (extra: BuildOptions = {}) =>
      build({ ...extra, config: { credentialsMode: 'personal', monthlyCap: 1, ...extra.config }, personalKeys: true });

    test('no saved key: 409 before any usage write', async () => {
      const { service, target, objects, commands } = personal();
      expect(await service.start(target(), DANA)).toEqual({ status: 409, body: { error: RUN_ERRORS.noPersonalKey } });
      expect(await objects()).toEqual([]);
      expect(commands.filter((c) => c.name === 'PutObjectCommand')).toEqual([]);
    });

    test('a saved key: accepted, usage written, no cap', async () => {
      const { service, keys, target, memory } = personal();
      await keys!.save(DANA.githubUserId, { key: KEY });
      const first = await service.start(target(), DANA);
      expect(first.status).toBe(201);
      failedJob(JOB_ID + 1);
      const second = await service.start(target('job', JOB_ID + 1), DANA);
      expect(second.status).toBe(201);
      const usage = await memory.read<{ entries: unknown[] }>('usage/2026-11/1000001.json');
      expect(usage!.value.entries).toHaveLength(2);
      const runs = await memory.list('runs/');
      for (const key of runs) expect(JSON.stringify((await memory.read(key))!.value)).not.toContain(KEY);
      expect(allLogs()).not.toContain(KEY);
    });

    test('an unreadable key: 409 asking to save it again, one error line without content', async () => {
      const { service, target, memory, objects } = personal();
      await memory.create(personalKeyKey(DANA.githubUserId), { v: 1, nonce: 'AAAA', ciphertext: 'AAAA', tag: 'AAAA', savedAt: 'x' });
      const before = await objects();
      expect(await service.start(target(), DANA)).toEqual({ status: 409, body: { error: RUN_ERRORS.personalKeyUnreadable } });
      expect(await objects()).toEqual(before);
      expect(error.mock.calls.map((a) => a.join(' '))).toContain(
        '[ERROR] Debug it personal key of GitHub user 1000001 cannot be read.',
      );
    });

    test('an S3 failure reading the key: 503', async () => {
      const { service, target, objects, client } = personal();
      client.fail = (c) => (c.name === 'GetObjectCommand' && String(c.input.Key).includes('personal-keys/') ? s3Down() : undefined);
      expect(await service.start(target(), DANA)).toEqual({ status: 503, body: { error: RUN_ERRORS.s3 } });
      expect(await objects()).toEqual([]);
    });
  });

  test('spend limit reached: 429 with the reset date', async () => {
    const { service, target, memory, objects } = build({
      config: { limits: { ...DEBUG_IT_DEFAULTS.limits, organizationMonthlySpendLimitUsd: 10 } },
    });
    await seedUsage(memory, 'usage/2026-11/1000002.json', [4, 1]);
    await seedUsage(memory, 'usage/2026-11/1000003.json', [5]);
    const before = await objects();
    const outcome = await service.start(target(), DANA);
    expect(outcome).toEqual({
      status: 429,
      body: {
        error: 'The organization has reached its Debug it spend limit for this month; runs start again on 2026-12-01 (UTC).',
      },
    });
    expect(await objects()).toEqual(before);
  });

  test('a malformed usage record of another user is left out of the spend sum with one error line', async () => {
    const { service, target, memory } = build({
      config: { limits: { ...DEBUG_IT_DEFAULTS.limits, organizationMonthlySpendLimitUsd: 10 } },
    });
    await memory.create('usage/2026-11/1000002.json', { entries: 'nope' });
    await seedUsage(memory, 'usage/2026-11/1000003.json', [9]);
    expect((await service.start(target(), DANA)).status).toBe(201);
    const lines = error.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes('usage/2026-11/1000002.json'));
    expect(lines).toEqual([
      '[ERROR] Debug it usage record usage/2026-11/1000002.json is malformed; it is left out of the spend sum.',
    ]);
  });

  test('cap reached: 429 with the reset date, usage unchanged', async () => {
    const { service, target, memory } = build();
    await seedUsage(memory, 'usage/2026-11/1000001.json', [0, 0, 0, 0, 0]);
    const before = await memory.read('usage/2026-11/1000001.json');
    const outcome = await service.start(target(), DANA);
    expect(outcome).toEqual({
      status: 429,
      body: { error: 'You have used all 5 debug runs for this month; your runs reset on 2026-12-01 (UTC).' },
    });
    expect(await memory.read('usage/2026-11/1000001.json')).toEqual(before);
    expect(await memory.list('runs/')).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test('a December clock resets on 2027-01-01', async () => {
    const { service, target, memory } = build({ now: new Date('2026-12-31T23:00:00.000Z'), config: { monthlyCap: 2 } });
    await seedUsage(memory, 'usage/2026-12/1000001.json', [0, 0]);
    const outcome = await service.start(target(), DANA);
    expect(outcome).toEqual({
      status: 429,
      body: { error: 'You have used all 2 debug runs for this month; your runs reset on 2027-01-01 (UTC).' },
    });
  });

  test('last month does not count against the cap', async () => {
    const { service, target, memory } = build();
    await seedUsage(memory, 'usage/2026-10/1000001.json', [0, 0, 0, 0, 0]);
    expect((await service.start(target(), DANA)).status).toBe(201);
  });

  test('S3 down: 503', async () => {
    const { service, target, objects, github } = build({ fail: (c) => (c.name === 'HeadBucketCommand' ? s3Down() : undefined) });
    expect(await service.start(target(), DANA)).toEqual({ status: 503, body: { error: RUN_ERRORS.s3 } });
    expect(github.readContextFile).not.toHaveBeenCalled();
    expect(await objects()).toEqual([]);
  });

  test('a malformed usage record of the user: 503', async () => {
    const { service, target, memory } = build();
    await memory.create('usage/2026-11/1000001.json', { entries: {} });
    expect(await service.start(target(), DANA)).toEqual({ status: 503, body: { error: RUN_ERRORS.s3 } });
    expect(await memory.read('usage/2026-11/1000001.json')).toMatchObject({ value: { entries: {} } });
    expect(await memory.list('runs/')).toEqual([]);
  });

  test('usage write fails: 503, nothing written', async () => {
    const { service, target, objects } = build({
      fail: (c) => (c.name === 'PutObjectCommand' ? s3Down() : undefined),
    });
    expect(await service.start(target(), DANA)).toEqual({ status: 503, body: { error: RUN_ERRORS.s3 } });
    expect(await objects()).toEqual([]);
  });

  test('workflow run read fails: 502, nothing written', async () => {
    const github = fakeGitHub({
      readWorkflowRun: jest.fn(async () => {
        throw new GitHubAppError('GitHub knows no such workflow run.');
      }),
    });
    const { service, target, objects } = build({ github });
    expect(await service.start(target(), DANA)).toEqual({ status: 502, body: { error: RUN_ERRORS.github } });
    expect(await objects()).toEqual([]);
    expect(error.mock.calls.map((a) => a.join(' '))).toContain(
      '[ERROR] Debug it run could not start (workflow run): GitHub knows no such workflow run.',
    );
  });

  test('a usage write that landed with its answer lost is given back: 503, usage unchanged', async () => {
    const built = build();
    const { service, target, memory, client, inner } = built;
    await seedUsage(memory, 'usage/2026-11/1000001.json', [0.1]);
    let failed = false;
    client.fail = (c) => {
      if (!failed && c.name === 'PutObjectCommand' && String(c.input.Key).startsWith('debug-it/usage/')) {
        failed = true;
        void inner.send(c); // the write lands, the answer is lost
        return s3Down();
      }
      return undefined;
    };
    expect(await service.start(target(), DANA)).toEqual({ status: 503, body: { error: RUN_ERRORS.s3 } });
    const usage = await memory.read<{ entries: Array<{ runId: string }> }>('usage/2026-11/1000001.json');
    expect(usage!.value.entries.map((e) => e.runId)).toEqual(['seed-0']);
    expect(await memory.list('runs/')).toEqual([]);
  });

  test('a run record create that landed with its answer lost is accepted and keeps its count', async () => {
    const { service, target, memory, client, inner } = build();
    client.fail = (c) => {
      if (c.name === 'PutObjectCommand' && String(c.input.Key).startsWith('debug-it/runs/')) {
        void inner.send(c);
        return s3Down();
      }
      return undefined;
    };
    const outcome = await service.start(target(), DANA);
    expect(outcome.status).toBe(201);
    const runId = (outcome.body as { runId: string }).runId;
    const usage = await memory.read<{ entries: Array<{ runId: string }> }>('usage/2026-11/1000001.json');
    expect(usage!.value.entries.map((e) => e.runId)).toEqual([runId]);
    expect(await memory.read(`runs/${runId}.json`)).not.toBeNull();
    expect(audits()).toHaveLength(1);
    client.fail = () => undefined;
    expect(await service.start(target(), DANA)).toMatchObject({ status: 200, body: { runId, existing: true } });
  });

  test('run record create fails: 503 and the usage entry is removed', async () => {
    const { service, target, memory } = build({
      fail: (c) =>
        c.name === 'PutObjectCommand' && String(c.input.Key).startsWith('debug-it/runs/') ? s3Down() : undefined,
    });
    await seedUsage(memory, 'usage/2026-11/1000001.json', [0.1]);
    expect(await service.start(target(), DANA)).toEqual({ status: 503, body: { error: RUN_ERRORS.s3 } });
    const usage = await memory.read<{ entries: Array<{ runId: string }> }>('usage/2026-11/1000001.json');
    expect(usage!.value.entries.map((e) => e.runId)).toEqual(['seed-0']);
    expect(await memory.list('runs/')).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test('a failed start leaves the target free', async () => {
    let failing = true;
    const { service, target } = build({
      fail: (c) =>
        failing && c.name === 'PutObjectCommand' && String(c.input.Key).startsWith('debug-it/runs/') ? s3Down() : undefined,
    });
    expect((await service.start(target(), DANA)).status).toBe(503);
    failing = false;
    expect((await service.start(target(), DANA)).status).toBe(201);
  });
});

describe('start: a run in progress on the target', () => {
  test('a second click with read access opens the same run; usage unchanged', async () => {
    const { service, target, memory, setClock } = build();
    const first = await service.start(target(), DANA);
    setClock(new Date(NOVEMBER.getTime() + 30000));
    const second = await service.start(target(), { githubUserId: 1000002, login: 'lee' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, elapsedMs: 30000, existing: true });
    const usage = await memory.read<{ entries: unknown[] }>('usage/2026-11/1000001.json');
    expect(usage!.value.entries).toHaveLength(1);
    expect(await memory.read('usage/2026-11/1000002.json')).toBeNull();
    expect(await memory.list('runs/')).toHaveLength(1);
  });

  test('the same click on a run target says workflow run when unreadable', async () => {
    const github = fakeGitHub();
    const { service, target } = build({ github });
    expect((await service.start(target('run'), DANA)).status).toBe(201);
    (github.checkPermission as jest.Mock).mockResolvedValue('none');
    expect(await service.start(target('run'), DANA)).toEqual({ status: 409, body: { error: RUN_ERRORS.inProgressRun } });
  });

  test('a download the user cannot read: 409', async () => {
    const github = fakeGitHub();
    const { service, target, memory } = build({ github });
    const first = await service.start(target(), DANA);
    const runId = (first.body as { runId: string }).runId;
    const record = (await memory.read<RunRecord>(`runs/${runId}.json`))!.value;
    service.trackRun({
      ...record,
      state: 'cloning',
      downloads: [
        { repository: REPO, commitSha: SHA, folder: 'payments-api' },
        { repository: 'acme/shared-config', commitSha: SHA, folder: 'shared-config' },
      ],
    });
    (github.checkPermission as jest.Mock).mockImplementation(async (_u: unknown, repository: string) =>
      repository === 'acme/shared-config' ? 'none' : 'read',
    );
    expect(await service.start(target(), { githubUserId: 1000002, login: 'lee' })).toEqual({
      status: 409,
      body: { error: RUN_ERRORS.inProgressJob },
    });
    expect(github.checkPermission).toHaveBeenCalledWith({ githubUserId: 1000002, login: 'lee' }, 'acme/shared-config');
  });

  test('a download that left the allowed list: 409, no permission call for it', async () => {
    const github = fakeGitHub();
    const allowed = ['acme/payments-api', 'acme/shared-config'];
    const settings = createSettingsService({
      store: createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() }),
      config: { administrators: [], allowedUsers: [], allowedRepositories: allowed },
    });
    const { service, target, memory } = build({ github, settings });
    const first = await service.start(target(), DANA);
    const runId = (first.body as { runId: string }).runId;
    const record = (await memory.read<RunRecord>(`runs/${runId}.json`))!.value;
    service.trackRun({
      ...record,
      state: 'cloning',
      downloads: [
        { repository: REPO, commitSha: SHA, folder: 'payments-api' },
        { repository: 'acme/shared-config', commitSha: SHA, folder: 'shared-config' },
      ],
    });
    const lee = { githubUserId: 1000002, login: 'lee' };
    expect((await service.start(target(), lee)).status).toBe(200);
    await settings.update((current) => ({
      ...current,
      allowedRepositories: current.allowedRepositories.filter((r) => r !== 'acme/shared-config'),
    }));
    (github.checkPermission as jest.Mock).mockClear();
    expect(await service.start(target(), lee)).toEqual({ status: 409, body: { error: RUN_ERRORS.inProgressJob } });
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('settings that cannot be read on a second click: 503', async () => {
    const github = fakeGitHub();
    const settings = {
      load: jest.fn(async () => ({ allowedRepositories: [REPO], allowedUsers: [] })),
      isRepositoryAllowed: (current: { allowedRepositories: string[] }, repository: string) =>
        current.allowedRepositories.includes(repository),
    };
    const { service, target } = build({ github, settings });
    expect((await service.start(target(), DANA)).status).toBe(201);
    settings.load.mockRejectedValue(new Error('S3 down'));
    expect(await service.start(target(), DANA)).toEqual({ status: 503, body: { error: RUN_ERRORS.s3 } });
  });

  test('a permission check failure: 502', async () => {
    const github = fakeGitHub();
    const { service, target } = build({ github });
    await service.start(target(), DANA);
    (github.checkPermission as jest.Mock).mockRejectedValue(new GitHubAppError('GitHub did not answer.'));
    expect(await service.start(target(), DANA)).toEqual({ status: 502, body: { error: RUN_ERRORS.github } });
  });

  test('a finished run frees the target', async () => {
    const { service, target, memory } = build();
    const first = await service.start(target(), DANA);
    const runId = (first.body as { runId: string }).runId;
    const record = (await memory.read<RunRecord>(`runs/${runId}.json`))!.value;
    service.trackRun({ ...record, state: 'finished' });
    const second = await service.start(target(), DANA);
    expect(second.status).toBe(201);
    expect((second.body as { runId: string }).runId).not.toBe(runId);
  });

  test('the isolation gate is checked before the run in progress', async () => {
    let isolation: IsolationStatus = ON;
    const { client } = recordingClient();
    const service = createRunService({
      store: createS3Store({ bucket: 'acme-bucket', client }),
      githubApp: fakeGitHub(),
      config: DEBUG_IT_DEFAULTS,
      isolation: { status: () => isolation },
      organization: 'acme',
    });
    const target = service.findTarget('job', String(JOB_ID))!;
    expect((await service.start(target, DANA)).status).toBe(201);
    isolation = { state: 'off', reason: ISOLATION_REASONS.failed, checkedAt: null };
    expect(await service.start(target, DANA)).toEqual({ status: 503, body: { error: ISOLATION_REASONS.failed } });
  });
});

describe('start: concurrency', () => {
  test('10 clicks on one target: one 201, nine 200 existing, one usage entry', async () => {
    const { service, target, memory } = build();
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => service.start(target(), DANA)));
    expect(outcomes.filter((o) => o.status === 201)).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 200)).toHaveLength(9);
    const runIds = new Set(outcomes.map((o) => (o.body as { runId: string }).runId));
    expect(runIds.size).toBe(1);
    const usage = await memory.read<{ entries: unknown[] }>('usage/2026-11/1000001.json');
    expect(usage!.value.entries).toHaveLength(1);
    expect(await memory.list('runs/')).toHaveLength(1);
  });

  test('10 clicks on 10 targets with 1 run left: exactly one 201', async () => {
    for (let i = 1; i <= 10; i++) failedJob(910000 + i);
    const { service, memory } = build();
    await seedUsage(memory, 'usage/2026-11/1000001.json', [0, 0, 0, 0]);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => service.start(service.findTarget('job', String(910001 + i))!, DANA)),
    );
    expect(outcomes.filter((o) => o.status === 201)).toHaveLength(1);
    expect(outcomes.every((o) => o.status === 201 || o.status === 429 || o.status === 503)).toBe(true);
    const usage = await memory.read<{ entries: unknown[] }>('usage/2026-11/1000001.json');
    expect(usage!.value.entries).toHaveLength(5);
    expect(await memory.list('runs/')).toHaveLength(1);
  });
});

describe('load and view', () => {
  test('a run reads back with its elapsed time', async () => {
    const { service, target, setClock } = build();
    const runId = ((await service.start(target(), DANA)).body as { runId: string }).runId;
    setClock(new Date(NOVEMBER.getTime() + 65000));
    const loaded = await service.load(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(service.view(loaded.record)).toMatchObject({ runId, state: 'waiting', elapsedMs: 65000 });
  });

  test('a finished run counts time up to updatedAt', () => {
    const { service } = build({ now: new Date('2026-11-06T00:00:00.000Z') });
    const record = {
      runId: '00000000-0000-4000-8000-000000000009',
      target: { kind: 'job', id: JOB_ID },
      state: 'finished',
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T10:07:30.000Z',
      repository: REPO,
      jobName: 'test',
      downloads: [],
    } as unknown as RunRecord;
    expect(service.view(record).elapsedMs).toBe(450000);
    expect(service.view({ ...record, state: 'failed' }).elapsedMs).toBe(450000);
  });

  test.each(['not-a-uuid', '../settings', '00000000-0000-4000-8000-00000000000G', undefined])(
    'malformed run ID %p is 404 with no S3 call',
    async (runId) => {
      const { service, commands } = build();
      expect(await service.load(runId)).toEqual({ ok: false, status: 404, error: RUN_ERRORS.runNotFound });
      expect(commands).toHaveLength(0);
    },
  );

  test('an unknown run is 404', async () => {
    const { service } = build();
    expect(await service.load('00000000-0000-4000-8000-000000000042')).toEqual({
      ok: false,
      status: 404,
      error: RUN_ERRORS.runNotFound,
    });
  });

  test('S3 down is 503', async () => {
    const { service } = build({ fail: (c) => (c.name === 'GetObjectCommand' ? s3Down() : undefined) });
    expect(await service.load('00000000-0000-4000-8000-000000000042')).toEqual({
      ok: false,
      status: 503,
      error: RUN_ERRORS.s3Read,
    });
  });

  test('a malformed run record is 503', async () => {
    const { service, memory } = build();
    await memory.create('runs/00000000-0000-4000-8000-000000000042.json', { runId: 'other' });
    expect(await service.load('00000000-0000-4000-8000-000000000042')).toMatchObject({ ok: false, status: 503 });
  });
});

describe('latest run per target (story 3.11)', () => {
  const LEE = { githubUserId: 1000002, login: 'lee' };

  test('start records the run for its requester only', async () => {
    const { service, target } = build();
    const runId = ((await service.start(target(), DANA)).body as { runId: string }).runId;
    expect(service.latestRunsOf(DANA.githubUserId).map((r) => [r.runId, r.state])).toEqual([[runId, 'waiting']]);
    expect(service.latestRunsOf(LEE.githubUserId)).toEqual([]);
  });

  test('trackRun keeps final states; a newer run of the target replaces an older one', async () => {
    const { service, target, memory, setClock } = build();
    const first = ((await service.start(target(), DANA)).body as { runId: string }).runId;
    const record = (await memory.read<RunRecord>(`runs/${first}.json`))!.value;
    service.trackRun({ ...record, state: 'failed', failureReason: 'The Debug Job of this run no longer exists.' });
    const kept = service.latestRunsOf(DANA.githubUserId);
    expect(kept.map((r) => [r.runId, r.state])).toEqual([[first, 'failed']]);
    expect(service.view(kept[0]!).failureReason).toBe('The Debug Job of this run no longer exists.');

    // Another user's newer run on the same target does not hide Dana's run.
    setClock(new Date(NOVEMBER.getTime() + 60_000));
    const second = ((await service.start(target(), LEE)).body as { runId: string }).runId;
    expect(service.latestRunsOf(DANA.githubUserId).map((r) => r.runId)).toEqual([first]);
    expect(service.latestRunsOf(LEE.githubUserId).map((r) => r.runId)).toEqual([second]);

    // Dana's own newer run replaces her older one.
    const secondRecord = (await memory.read<RunRecord>(`runs/${second}.json`))!.value;
    service.trackRun({ ...secondRecord, state: 'finished' });
    setClock(new Date(NOVEMBER.getTime() + 120_000));
    const third = ((await service.start(target(), DANA)).body as { runId: string }).runId;
    expect(service.latestRunsOf(DANA.githubUserId).map((r) => r.runId)).toEqual([third]);

    // An older record fed later (recovery order) does not replace the newer run.
    service.trackRun({ ...record, state: 'finished' });
    expect(service.latestRunsOf(DANA.githubUserId).map((r) => r.runId)).toEqual([third]);
    expect(service.latestRunsOf(LEE.githubUserId).map((r) => r.runId)).toEqual([second]);
  });

  test('targets are kept apart and copies are returned', async () => {
    const { service, target } = build();
    await service.start(target('job'), DANA);
    await service.start(target('run'), DANA);
    const runs = service.latestRunsOf(DANA.githubUserId);
    expect(runs.map((r) => r.target.kind).sort()).toEqual(['job', 'run']);
    runs[0]!.state = 'finished';
    expect(service.latestRunsOf(DANA.githubUserId).every((r) => r.state === 'waiting')).toBe(true);
  });

  test('forgetRun drops the run', async () => {
    const { service, target } = build();
    const runId = ((await service.start(target(), DANA)).body as { runId: string }).runId;
    service.forgetRun('00000000-0000-4000-8000-000000000099');
    expect(service.latestRunsOf(DANA.githubUserId)).toHaveLength(1);
    service.forgetRun(runId);
    expect(service.latestRunsOf(DANA.githubUserId)).toEqual([]);
  });

  test('view answers failureReason as null when not set', async () => {
    const { service, target } = build();
    const outcome = await service.start(target(), DANA);
    expect((outcome.body as { failureReason: unknown }).failureReason).toBeNull();
  });
});

describe('safety', () => {
  test('no log, record or answer holds a token or the context file text', async () => {
    const { service, target, memory } = build();
    const outcome = await service.start(target(), DANA);
    const runId = (outcome.body as { runId: string }).runId;
    const stored = JSON.stringify([outcome, await memory.read(`runs/${runId}.json`)]);
    for (const text of [stored, allLogs()]) {
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain('payments-api is the Node.js service');
    }
    expect(MOCK_CONTEXT_FILE).toContain('payments-api is the Node.js service');
  });

  test('the process service is built lazily and reset', () => {
    resetRunService();
    const env = { USE_MOCK_DATA: 'true' };
    const first = getRunService(env);
    expect(getRunService(env)).toBe(first);
    resetRunService();
    expect(getRunService(env)).not.toBe(first);
    resetRunService();
  });
});

describe('onRunCreated and startedRunIds (story 3.10)', () => {
  test('listeners get a copy of each created record, after it is tracked', async () => {
    const { service, target } = build();
    const seen: RunRecord[] = [];
    service.onRunCreated((record) => {
      seen.push(record);
      record.state = 'failed';
      record.downloads.push({ repository: 'acme/evil', commitSha: SHA, folder: 'evil' });
    });
    const outcome = await service.start(target(), DANA);
    expect(outcome.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.runId).toBe('00000000-0000-4000-8000-000000000001');
    // The listener's changes do not reach the target map: a second click opens the run.
    const again = await service.start(target(), DANA);
    expect(again.status).toBe(200);
    expect((again.body as { state: string }).state).toBe('waiting');
  });

  test('a throwing listener is logged and does not change the answer', async () => {
    const { service, target } = build();
    const second = jest.fn();
    service.onRunCreated(() => {
      throw new Error('listener broke');
    });
    service.onRunCreated(second);
    const outcome = await service.start(target(), DANA);
    expect(outcome.status).toBe(201);
    expect(second).toHaveBeenCalledTimes(1);
    expect(allLogs()).toContain('[ERROR] Debug it run 00000000-0000-4000-8000-000000000001: a run created listener failed.');
    expect(allLogs()).not.toContain('listener broke');
  });

  test('refusals call no listener', async () => {
    const { service, target, memory } = build();
    const listener = jest.fn();
    service.onRunCreated(listener);
    await seedUsage(memory, 'usage/2026-11/1000001.json', [0, 0, 0, 0, 0]);
    expect((await service.start(target(), DANA)).status).toBe(429);
    expect(listener).not.toHaveBeenCalled();
  });

  test('startedRunIds holds every ID generated, even when the usage write fails', async () => {
    let failing = false;
    const { service, target } = build({
      fail: (c) => (failing && c.name === 'PutObjectCommand' ? s3Down() : undefined),
    });
    expect([...service.startedRunIds()]).toEqual([]);
    expect((await service.start(target(), DANA)).status).toBe(201);
    failing = true;
    expect((await service.start(target('run'), DANA)).status).toBe(503);
    expect([...service.startedRunIds()]).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });
});

describe('result view and feedback (story 3.12)', () => {
  const ID = '00000000-0000-4000-8000-000000000055';
  const LEE = { githubUserId: 1000002, login: 'lee' };

  function record(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      runId: ID,
      target: { kind: 'job', id: JOB_ID },
      requester: { ...DANA },
      state: 'finished',
      createdAt: '2026-11-05T09:00:00.000Z',
      updatedAt: '2026-11-05T09:05:00.000Z',
      repository: REPO,
      headRepository: REPO,
      headSha: SHA,
      branch: 'main',
      jobName: 'test',
      downloads: [{ repository: REPO, commitSha: SHA, folder: 'payments-api' }],
      usageKey: 'usage/2026-11/1000001.json',
      resultCodeHash: 'a'.repeat(64),
      result: {
        schemaVersion: 1,
        explanation: 'Because.',
        causeLocation: { kind: 'extra-repository', repository: 'acme/shared-config' },
        patch: '',
        costUsd: 1.5,
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1000,
        logTruncated: false,
        failureReason: 'none',
      },
      feedback: null,
      fixPullRequests: [],
      failureReason: null,
      ...overrides,
    };
  }

  test('readRunResult keeps only the answered fields', () => {
    expect(readRunResult(record().result)).toEqual({
      explanation: 'Because.',
      causeLocation: { kind: 'extra-repository', repository: 'acme/shared-config' },
      patch: '',
      costUsd: 1.5,
      durationMs: 1000,
      logTruncated: false,
      failureReason: 'none',
    });
  });

  test.each([null, undefined, 'text', 42, [], true])('a non-object result %p is null', (value) => {
    expect(readRunResult(value)).toBeNull();
  });

  test('every wrong field type becomes a safe default', () => {
    expect(
      readRunResult({
        explanation: 7,
        causeLocation: { kind: 'extra-repository' },
        patch: ['x'],
        costUsd: Number.NaN,
        durationMs: -5,
        logTruncated: 'yes',
        failureReason: 'exploded',
        extra: 'never answered',
      }),
    ).toEqual({
      explanation: '',
      causeLocation: { kind: 'unknown' },
      patch: '',
      costUsd: 0,
      durationMs: 0,
      logTruncated: false,
      failureReason: 'error',
    });
    expect(readRunResult({ causeLocation: { kind: 'elsewhere' } })!.causeLocation).toEqual({ kind: 'unknown' });
    expect(readRunResult({ causeLocation: { kind: 'runner', repository: 'x' } })!.causeLocation).toEqual({ kind: 'runner' });
  });

  test('resultView reads downloads, skipped repositories and feedback defensively', () => {
    const { service } = build();
    const view = service.resultView(
      record({
        downloads: [
          { repository: REPO, commitSha: SHA, folder: 'payments-api' },
          { repository: 'acme/other', commitSha: 5 as unknown as string, folder: null as unknown as string },
        ],
        skippedRepositories: [{ repository: 'acme/x', reason: 'Not allowed.' }, 'junk' as never],
        feedback: { rating: 'useful', comment: 'Nice', at: '2026-11-05T10:00:00.000Z', githubUserId: DANA.githubUserId },
      }),
      DANA.githubUserId,
    );
    expect(view.downloads).toEqual([
      { repository: REPO, commitSha: SHA, folder: 'payments-api' },
      { repository: 'acme/other', commitSha: '', folder: '' },
    ]);
    expect(view.skippedRepositories).toEqual([{ repository: 'acme/x', reason: 'Not allowed.' }]);
    expect(view.feedback).toEqual({ rating: 'useful', comment: 'Nice', at: '2026-11-05T10:00:00.000Z' });
    expect(view.canGiveFeedback).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/aaaa|usage|requester|1000001/);
  });

  test('resultView: no skipped list, bad feedback, other viewer, no result', () => {
    const { service } = build();
    const view = service.resultView(record({ feedback: { rating: 'great', at: 'x' } }), LEE.githubUserId);
    expect(view.skippedRepositories).toEqual([]);
    expect(view.feedback).toBeNull();
    expect(view.canGiveFeedback).toBe(false);
    expect(service.resultView(record({ result: null }), DANA.githubUserId).canGiveFeedback).toBe(false);
  });

  test('resultView answers the stored fix pull requests and no offers (story 4.3)', () => {
    const { service } = build();
    const url = 'https://github.com/acme/payments-api/pull/17';
    const view = service.resultView(record({ fixPullRequests: [{ repository: REPO, url, extra: 'x' }] }), DANA.githubUserId);
    expect(view.fixPullRequests).toEqual([{ repository: REPO, url }]);
    expect(view.canOpenPullRequest).toEqual([]);
    const empty = service.resultView(record({ fixPullRequests: undefined as unknown as unknown[] }), DANA.githubUserId);
    expect(empty.fixPullRequests).toEqual([]);
    expect(empty.canOpenPullRequest).toEqual([]);
  });

  test('readFixPullRequests drops malformed entries', () => {
    const url = 'https://github.com/acme/payments-api/pull/17';
    expect(
      readFixPullRequests([
        { repository: REPO, url },
        { repository: REPO, url: 'javascript:alert(1)' },
        { repository: REPO, url: 'http://github.com/acme/payments-api/pull/1' },
        { repository: REPO, url: 'https://github.com.evil.example/x' },
        { repository: 7, url },
        { repository: '', url },
        { repository: REPO },
        'junk',
        null,
        [REPO, url],
      ]),
    ).toEqual([{ repository: REPO, url }]);
    expect(readFixPullRequests('x')).toEqual([]);
    expect(readFixPullRequests(null)).toEqual([]);
  });

  test('parseFeedback', () => {
    expect(parseFeedback({ rating: 'useful' })).toEqual({ ok: true, input: { rating: 'useful', comment: null } });
    expect(parseFeedback({ rating: 'not-useful', comment: ' a ' })).toEqual({
      ok: true,
      input: { rating: 'not-useful', comment: 'a' },
    });
    expect(parseFeedback({ rating: 'useful', comment: null })).toEqual({ ok: true, input: { rating: 'useful', comment: null } });
    expect(parseFeedback({ rating: 'useful', comment: ` ${'x'.repeat(2000)} ` }).ok).toBe(true);
    expect(parseFeedback({ rating: 'great' })).toEqual({ ok: false, error: RUN_ERRORS.feedbackRating });
    expect(parseFeedback(undefined)).toEqual({ ok: false, error: RUN_ERRORS.feedbackRating });
    expect(parseFeedback([])).toEqual({ ok: false, error: RUN_ERRORS.feedbackRating });
    expect(parseFeedback({ rating: 'useful', comment: 'x'.repeat(2001) })).toEqual({
      ok: false,
      error: RUN_ERRORS.feedbackComment,
    });
    expect(parseFeedback({ rating: 'useful', comment: 3 })).toEqual({ ok: false, error: RUN_ERRORS.feedbackComment });
  });

  test('saveFeedback sets only the feedback field', async () => {
    const { service, memory } = build();
    await memory.create(`runs/${ID}.json`, record());
    const outcome = await service.saveFeedback(ID, DANA, { rating: 'useful', comment: 'Good' });
    expect(outcome.ok).toBe(true);
    const stored = (await memory.read<RunRecord>(`runs/${ID}.json`))!.value;
    expect(stored).toEqual({
      ...record(),
      feedback: { rating: 'useful', comment: 'Good', at: NOVEMBER.toISOString(), githubUserId: DANA.githubUserId },
    });
    expect(audits()).toEqual([`[AUDIT] Debug it run ${ID} rated useful by GitHub user ${DANA.githubUserId}`]);
    expect(allLogs()).not.toContain('Good');
  });

  test('saveFeedback refusals write nothing', async () => {
    const { service, memory } = build();
    expect(await service.saveFeedback('bad', DANA, { rating: 'useful', comment: null })).toMatchObject({ status: 404 });
    expect(await service.saveFeedback(ID, DANA, { rating: 'useful', comment: null })).toMatchObject({ status: 404 });
    await memory.create(`runs/${ID}.json`, record({ result: null, state: 'analyzing' }));
    expect(await service.saveFeedback(ID, LEE, { rating: 'useful', comment: null })).toEqual({
      ok: false,
      status: 403,
      error: RUN_ERRORS.feedbackNotRequester,
    });
    expect(await service.saveFeedback(ID, DANA, { rating: 'useful', comment: null })).toEqual({
      ok: false,
      status: 409,
      error: RUN_ERRORS.feedbackNoResult,
    });
    expect((await memory.read<RunRecord>(`runs/${ID}.json`))!.value.feedback).toBeNull();
    expect(audits()).toEqual([]);
  });

  test('saveFeedback on a malformed record is 503', async () => {
    const { service, memory } = build();
    await memory.create(`runs/${ID}.json`, { runId: 'other' });
    expect(await service.saveFeedback(ID, DANA, { rating: 'useful', comment: null })).toMatchObject({ status: 503 });
  });

  test('saveFeedback with S3 down is 503 and logs no comment', async () => {
    const { service, memory, client } = build();
    await memory.create(`runs/${ID}.json`, record());
    client.fail = (c) => (c.name === 'PutObjectCommand' ? s3Down() : undefined);
    expect(await service.saveFeedback(ID, DANA, { rating: 'not-useful', comment: 'Secret words' })).toEqual({
      ok: false,
      status: 503,
      error: RUN_ERRORS.s3Feedback,
    });
    expect(allLogs()).not.toContain('Secret words');
    expect(audits()).toEqual([]);
  });
});
