import express from 'express';
import request from 'supertest';
import { registerDebugIt } from '../src/routes/debugIt';
import { DEBUG_IT_DEFAULTS } from '../src/services/debugItConfig';
import { createSessionService } from '../src/services/session';
import {
  createMockGitHubApp,
  GitHubAppError,
  type FixPullRequestInput,
  type FixPullRequestOutcome,
  type GitHubApp,
  type RepositoryPermission,
} from '../src/adapters/githubApp';
import { createSettingsService } from '../src/services/debugIt/settings';
import { createMemoryS3Client, createS3Store, type S3Store } from '../src/adapters/s3Store';
import { CHECK_ERRORS } from '../src/routes/checkChain';
import { createRunService, type RunRecord, type UsageRecord } from '../src/services/debugIt/runs';
import {
  cleanExplanation,
  createFixPullRequestService,
  fixPullRequestBody,
  fixPullRequestTitle,
  FIX_PR_ERRORS,
} from '../src/services/debugIt/fixPullRequest';
import { applySection } from '../src/services/debugIt/patchApply';
import { PATCH_RULE_MESSAGES } from '../src/services/debugIt/patchValidation';

const KEY = Buffer.alloc(32, 4);
const DANA = { uid: 1000001, login: 'dana' };
const LEE = { uid: 1000002, login: 'lee' };
const REPO = 'acme/payments-api';
const EXTRA = 'acme/shared-lib';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const EXTRA_SHA = 'b'.repeat(40);
const ID = '00000000-0000-4000-8000-000000000042';
const USAGE = 'usage/2026-11/1000001.json';
const PATH = `/debug-it/runs/${ID}/pull-requests/acme/payments-api`;
const PR_URL = 'https://github.com/acme/payments-api/pull/17';
const TOKEN = 'ghs_secretinstallationtoken123';
const NOVEMBER = new Date('2026-11-05T10:00:00.000Z');

const CLEAN =
  '--- a/payments-api/src/db.ts\n+++ b/payments-api/src/db.ts\n@@ -1 +1 @@\n-old\n+new\n' +
  '--- a/shared-lib/index.ts\n+++ b/shared-lib/index.ts\n@@ -1 +1 @@\n-a\n+b\n';
const WORKFLOW = '--- a/payments-api/.github/workflows/ci.yml\n+++ b/payments-api/.github/workflows/ci.yml\n@@ -1 +1 @@\n-a\n+b\n';

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

function record(overrides: Partial<RunRecord> = {}, patch = CLEAN): RunRecord {
  return {
    runId: ID,
    target: { kind: 'job', id: 900001 },
    requester: { githubUserId: DANA.uid, login: DANA.login },
    state: 'finished',
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:04:00.000Z',
    repository: REPO,
    headRepository: REPO,
    headSha: SHA,
    branch: 'feature/refunds',
    jobName: 'test',
    downloads: [
      { repository: REPO, commitSha: SHA, folder: 'payments-api' },
      { repository: EXTRA, commitSha: EXTRA_SHA, folder: 'shared-lib' },
    ],
    usageKey: USAGE,
    resultCodeHash: 'f'.repeat(64),
    result: {
      schemaVersion: 1,
      explanation: 'The refund test fails. Fixes #12, cc @lee <b>bold</b>',
      causeLocation: { kind: 'this-repository' },
      patch,
      costUsd: 0.2,
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

function fakeGitHub(
  options: {
    permission?: (uid: number, repository: string) => RepositoryPermission;
    protected?: boolean;
    open?: (input: FixPullRequestInput) => Promise<FixPullRequestOutcome>;
  } = {},
) {
  const mock = createMockGitHubApp();
  return {
    ...mock,
    checkPermission: jest.fn(async (user: { githubUserId: number }, repository: string) =>
      (options.permission ?? (() => 'write'))(user.githubUserId, repository),
    ),
    checkRuleset: jest.fn(async () => ({ protected: options.protected ?? true })),
    openFixPullRequest: jest.fn(
      options.open ??
        (async (input: FixPullRequestInput): Promise<FixPullRequestOutcome> => ({
          status: 'opened',
          url: `https://github.com/${input.repository}/pull/17`,
          number: 17,
          existing: false,
        })),
    ),
  } satisfies GitHubApp;
}

async function build(
  options: {
    github?: ReturnType<typeof fakeGitHub>;
    record?: RunRecord | null;
    serviceStore?: (store: S3Store) => S3Store;
  } = {},
) {
  const store = createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() });
  const settings = createSettingsService({
    store,
    config: { administrators: ['1000001'], allowedRepositories: [REPO, EXTRA], allowedUsers: ['1000001', '1000002'] },
  });
  const github = options.github ?? fakeGitHub();
  const isolation = { status: () => ({ state: 'on' as const, reason: null, checkedAt: NOVEMBER.toISOString() }) };
  const runs = createRunService({ store, githubApp: github, config: DEBUG_IT_DEFAULTS, isolation, organization: 'acme' });
  const fixPullRequests = createFixPullRequestService({
    store: options.serviceStore ? options.serviceStore(store) : store,
    githubApp: github,
    config: DEBUG_IT_DEFAULTS,
  });
  const session = createSessionService(KEY, { secure: false });
  const app = express();
  app.use(express.json());
  registerDebugIt(
    app,
    { ...DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'https://monitor.acme.example', githubAppClientId: 'Iv1.acme' },
    { session, githubApp: github, env: {}, settings, isolation, runs, fixPullRequests },
  );
  if (options.record !== null) await store.create(`runs/${ID}.json`, options.record ?? record());
  await store.create<UsageRecord>(USAGE, { entries: [{ runId: ID, costUsd: 0.2, fixPullRequests: 0 }] });
  const as = (user = DANA) => {
    const value = session.seal(user);
    const cookie = `dbg_session=${value}`;
    const csrf = session.csrfToken(value);
    return {
      post: (path: string, body: unknown = {}) =>
        request(app).post(path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body as object),
      postNoCsrf: (path: string) => request(app).post(path).set('Cookie', cookie).send({}),
    };
  };
  const stored = async () => (await store.read<RunRecord>(`runs/${ID}.json`))!.value;
  const usage = async () => (await store.read<UsageRecord>(USAGE))!.value;
  return { app, store, github, as, stored, usage };
}

function allLogs(): string {
  return [...log.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

function audits(): string[] {
  return log.mock.calls.map((a) => a.join(' ')).filter((line) => line.includes('[AUDIT]') && line.includes('fix pull request'));
}

beforeEach(() => {
  log.mockClear();
  error.mockClear();
});

describe('POST /debug-it/runs/{runId}/pull-requests/{owner}/{name}', () => {
  test('happy path: 201, the adapter gets the stored values, record and usage updated, one audit line', async () => {
    const { as, github, stored, usage } = await build();
    const res = await as().post(PATH).expect(201);
    expect(res.body).toEqual({ repository: REPO, url: PR_URL });

    expect(github.checkPermission).toHaveBeenCalledWith({ githubUserId: DANA.uid, login: 'dana' }, REPO, { fresh: true });
    expect(github.checkRuleset).toHaveBeenCalledWith(REPO);
    expect(github.openFixPullRequest).toHaveBeenCalledTimes(1);
    const input = github.openFixPullRequest.mock.calls[0]![0];
    expect(input).toMatchObject({
      repository: REPO,
      commitSha: SHA,
      base: 'feature/refunds',
      branch: `debug-it/${ID}/payments-api`,
      title: 'Debug it fix: test',
      sections: [{ oldPath: 'src/db.ts', newPath: 'src/db.ts', text: '--- a/payments-api/src/db.ts\n+++ b/payments-api/src/db.ts\n@@ -1 +1 @@\n-old\n+new\n' }],
    });
    expect(input.apply).toBe(applySection);
    expect(input.body).toContain(`Debug it run ID: ${ID}`);

    expect((await stored()).fixPullRequests).toEqual([{ repository: REPO, url: PR_URL }]);
    expect((await usage()).entries[0]!.fixPullRequests).toBe(1);
    expect(audits()).toEqual([
      `[AUDIT] Debug it run ${ID} opened fix pull request ${PR_URL} in ${REPO} for GitHub user ${DANA.uid}`,
    ]);
  });

  test('two repositories: the second body links the first by URL, the first links the second by a branch search', async () => {
    const { as, github } = await build();
    await as().post(PATH).expect(201);
    await as().post(`/debug-it/runs/${ID}/pull-requests/acme/shared-lib`).expect(201);
    const [first, second] = github.openFixPullRequest.mock.calls.map((c) => c[0].body);
    const search = `https://github.com/acme/shared-lib/pulls?q=${encodeURIComponent(`is:pr head:debug-it/${ID}/shared-lib`)}`;
    expect(first).toContain(`Fix pull requests from the same Debug it run:\n\n- ${EXTRA}: ${search}\n`);
    expect(first).not.toContain(`- ${REPO}:`);
    expect(second).toContain(`Fix pull requests from the same Debug it run:\n\n- ${REPO}: ${PR_URL}\n`);
    expect(second).not.toContain(`- ${EXTRA}:`);
  });

  test('a single repository patch, or another part refused: no other fix pull requests listed', async () => {
    const single = '--- a/payments-api/src/db.ts\n+++ b/payments-api/src/db.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const { as, github } = await build({ record: record({}, single) });
    await as().post(PATH).expect(201);
    expect(github.openFixPullRequest.mock.calls[0]![0].body).not.toContain('Fix pull requests from the same Debug it run');

    const refusedOther = single + '--- a/shared-lib/.github/workflows/ci.yml\n+++ b/shared-lib/.github/workflows/ci.yml\n@@ -1 +1 @@\n-a\n+b\n';
    const other = await build({ record: record({}, refusedOther) });
    await other.as().post(PATH).expect(201);
    expect(other.github.openFixPullRequest.mock.calls[0]![0].body).not.toContain('Fix pull requests from the same Debug it run');
  });

  test('the request body and query are ignored', async () => {
    const { as, github } = await build();
    await as()
      .post(`${PATH}?repository=acme/other&branch=main`, { repository: 'acme/other', branch: 'main', commitSha: 'f'.repeat(40) })
      .expect(201);
    expect(github.openFixPullRequest.mock.calls[0]![0]).toMatchObject({ repository: REPO, commitSha: SHA, base: 'feature/refunds' });
  });

  test('an extra repository opens against its default branch at its own commit', async () => {
    const { as, github, stored } = await build();
    const res = await as().post(`/debug-it/runs/${ID}/pull-requests/ACME/Shared-Lib`).expect(201);
    expect(res.body).toEqual({ repository: EXTRA, url: 'https://github.com/acme/shared-lib/pull/17' });
    // The stored name, never the URL text.
    expect(github.checkPermission).toHaveBeenCalledWith(expect.anything(), EXTRA, { fresh: true });
    expect(github.openFixPullRequest.mock.calls[0]![0]).toMatchObject({
      repository: EXTRA,
      commitSha: EXTRA_SHA,
      base: null,
      branch: `debug-it/${ID}/shared-lib`,
      sections: [{ oldPath: 'index.ts', newPath: 'index.ts' }],
    });
    expect((await stored()).fixPullRequests).toEqual([{ repository: EXTRA, url: 'https://github.com/acme/shared-lib/pull/17' }]);
  });

  test('second click: 200 existing with no GitHub call', async () => {
    const { as, github, usage } = await build({ record: record({ fixPullRequests: [{ repository: REPO, url: PR_URL }] }) });
    const res = await as().post(PATH).expect(200);
    expect(res.body).toEqual({ repository: REPO, url: PR_URL, existing: true });
    expect(github.checkRuleset).not.toHaveBeenCalled();
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
    expect((await usage()).entries[0]!.fixPullRequests).toBe(0);
  });

  test('two clicks at once run one after another: one pull request, one count', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const github = fakeGitHub({
      open: async () => {
        calls += 1;
        // The second click finds the branch and its pull request again.
        if (calls > 1) return { status: 'opened', url: PR_URL, number: 17, existing: true };
        await gate;
        return { status: 'opened', url: PR_URL, number: 17, existing: false };
      },
    });
    const { as, usage, stored } = await build({ github });
    const first = as().post(PATH).then((r) => r);
    const second = as().post(PATH).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const answers = await Promise.all([first, second]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(github.openFixPullRequest.mock.calls.length).toBeLessThanOrEqual(2);
    expect((await usage()).entries[0]!.fixPullRequests).toBe(1);
    expect((await stored()).fixPullRequests).toEqual([{ repository: REPO, url: PR_URL }]);
    expect(audits()).toHaveLength(1);
  });

  test('a pull request GitHub already had: 200 existing, recorded, not counted again', async () => {
    const github = fakeGitHub({ open: async () => ({ status: 'opened', url: PR_URL, number: 17, existing: true }) });
    const { as, usage, stored } = await build({ github });
    expect((await as().post(PATH).expect(200)).body).toEqual({ repository: REPO, url: PR_URL, existing: true });
    expect((await stored()).fixPullRequests).toEqual([{ repository: REPO, url: PR_URL }]);
    expect((await usage()).entries[0]!.fixPullRequests).toBe(0);
    expect(audits()).toEqual([]);
  });

  test('a copy section reaches the adapter with copy: true', async () => {
    const patch =
      'diff --git a/payments-api/src/db.ts b/payments-api/src/db2.ts\nsimilarity index 100%\ncopy from payments-api/src/db.ts\ncopy to payments-api/src/db2.ts\n';
    const { as, github } = await build({ record: record({}, patch) });
    await as().post(PATH).expect(201);
    expect(github.openFixPullRequest.mock.calls[0]![0].sections).toEqual([
      { oldPath: 'src/db.ts', newPath: 'src/db2.ts', text: patch, copy: true },
    ]);
  });

  test('not the requester: 403, nothing written', async () => {
    const { as, github, stored, usage } = await build();
    const res = await as(LEE).post(PATH).expect(403);
    expect(res.body).toEqual({ error: FIX_PR_ERRORS.notRequester });
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
    expect((await stored()).fixPullRequests).toEqual([]);
    expect((await usage()).entries[0]!.fixPullRequests).toBe(0);
  });

  test('read only: 403 tooLittleAccess from a fresh lookup', async () => {
    const { as, github } = await build({ github: fakeGitHub({ permission: () => 'read' }) });
    const res = await as().post(PATH).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.tooLittleAccess });
    expect(github.checkPermission).toHaveBeenCalledWith(expect.anything(), REPO, { fresh: true });
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
  });

  // Security review 2.0.0, finding F1 (AD-11, SR13): a route that takes a run
  // ID checks read access to every repository of the run, Open a PR included.
  test('no read access to another repository of the run: 403 tooLittleAccess, nothing written', async () => {
    const { as, github, stored, usage } = await build({
      github: fakeGitHub({ permission: (_uid, repository) => (repository === EXTRA ? 'none' : 'write') }),
    });
    const res = await as().post(PATH).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.tooLittleAccess });
    expect(github.checkPermission).toHaveBeenCalledWith(expect.anything(), EXTRA, { fresh: true });
    // Only the read step ran (REPO, then EXTRA): the write lookup was never reached.
    expect(github.checkPermission).toHaveBeenCalledTimes(2);
    expect(github.checkRuleset).not.toHaveBeenCalled();
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
    expect((await stored()).fixPullRequests).toEqual([]);
    expect((await usage()).entries[0]!.fixPullRequests).toBe(0);
  });

  test('another repository of the run no longer allowed: 403 repositoryNotAllowed, nothing written', async () => {
    const { as, github, store, stored, usage } = await build();
    // An administrator removed the extra repository after the run.
    await store.create('settings.json', { allowedRepositories: [REPO], allowedUsers: [{ githubUserId: DANA.uid }] });
    const res = await as().post(PATH).expect(403);
    expect(res.body).toEqual({ error: CHECK_ERRORS.repositoryNotAllowed });
    expect(github.checkRuleset).not.toHaveBeenCalled();
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
    expect((await stored()).fixPullRequests).toEqual([]);
    expect((await usage()).entries[0]!.fixPullRequests).toBe(0);
  });

  test('fork: 409 with no adapter call', async () => {
    const { as, github } = await build({ record: record({ headRepository: 'other/payments-api' }) });
    expect((await as().post(PATH).expect(409)).body).toEqual({ error: FIX_PR_ERRORS.fork });
    expect(github.checkRuleset).not.toHaveBeenCalled();
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
  });

  test('an unknown head repository counts as a fork', async () => {
    const { as } = await build({ record: record({ headRepository: null }) });
    expect((await as().post(PATH).expect(409)).body).toEqual({ error: FIX_PR_ERRORS.fork });
  });

  test('no ruleset or a bypass allowed: 409 with no write call', async () => {
    const { as, github, stored } = await build({ github: fakeGitHub({ protected: false }) });
    expect((await as().post(PATH).expect(409)).body).toEqual({ error: FIX_PR_ERRORS.ruleset });
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
    expect((await stored()).fixPullRequests).toEqual([]);
  });

  test('a refused part: 409 with the rule message', async () => {
    const { as, github } = await build({ record: record({}, WORKFLOW) });
    expect((await as().post(PATH).expect(409)).body).toEqual({ error: PATCH_RULE_MESSAGES['workflow-file'] });
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
  });

  test('a repository the patch does not change: 409', async () => {
    const patch = '--- a/payments-api/src/db.ts\n+++ b/payments-api/src/db.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const { as } = await build({ record: record({}, patch) });
    expect((await as().post(`/debug-it/runs/${ID}/pull-requests/acme/shared-lib`).expect(409)).body).toEqual({
      error: FIX_PR_ERRORS.noPatch,
    });
  });

  test('a run without a result: 409', async () => {
    const { as } = await build({ record: record({ result: null }) });
    expect((await as().post(PATH).expect(409)).body).toEqual({ error: FIX_PR_ERRORS.noResult });
  });

  test('an unknown base branch for the run repository: 409', async () => {
    const { as, github } = await build({ record: record({ branch: null }) });
    expect((await as().post(PATH).expect(409)).body).toEqual({ error: FIX_PR_ERRORS.noBase });
    expect(github.openFixPullRequest).not.toHaveBeenCalled();
  });

  test('a download without a full commit: 409', async () => {
    const { as } = await build({
      record: record({ downloads: [{ repository: REPO, commitSha: 'main', folder: 'payments-api' }] }, WORKFLOW.replace(/\.github\/workflows\/ci\.yml/g, 'x')),
    });
    expect((await as().post(PATH).expect(409)).body).toEqual({ error: FIX_PR_ERRORS.noCommit });
  });

  test('a repository not in the run: 404 before any permission call', async () => {
    const { as, github } = await build();
    await as().post(`/debug-it/runs/${ID}/pull-requests/acme/other`).expect(404);
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('an unknown run: 404', async () => {
    const { as } = await build({ record: null });
    await as().post(PATH).expect(404);
  });

  test('symbolic link at the commit: 409 file sentence', async () => {
    const github = fakeGitHub({ open: async () => ({ status: 'refused', reason: 'not-a-file' }) });
    const { as, stored } = await build({ github });
    expect((await as().post(PATH).expect(409)).body).toEqual({ error: FIX_PR_ERRORS.notAFile });
    expect((await stored()).fixPullRequests).toEqual([]);
  });

  test('stale context: 409 no longer applies', async () => {
    const github = fakeGitHub({ open: async () => ({ status: 'refused', reason: 'does-not-apply' }) });
    const { as } = await build({ github });
    expect((await as().post(PATH).expect(409)).body).toEqual({
      error: 'The patch no longer applies to the files at the failed commit.',
    });
  });

  test('GitHub down: 502 one sentence, [ERROR] logged without the token', async () => {
    const github = fakeGitHub({
      open: async () => {
        throw new Error(`request failed with Authorization: token ${TOKEN}`);
      },
    });
    const { as, stored } = await build({ github });
    expect((await as().post(PATH).expect(502)).body).toEqual({ error: FIX_PR_ERRORS.github });
    expect(error.mock.calls.map((a) => a.join(' ')).join('\n')).toContain('[ERROR]');
    expect(allLogs()).not.toContain(TOKEN);
    expect((await stored()).fixPullRequests).toEqual([]);
  });

  test('a GitHubAppError message is logged', async () => {
    const github = fakeGitHub({
      open: async () => {
        throw new GitHubAppError('GitHub did not answer the tree request (GitHub answered 500).');
      },
    });
    const { as } = await build({ github });
    await as().post(PATH).expect(502);
    expect(allLogs()).toContain('GitHub did not answer the tree request (GitHub answered 500).');
  });

  test('a record write failure is logged and the answer stays 201', async () => {
    const { as, usage } = await build({
      serviceStore: (store) => ({
        ...store,
        modify: async <T>(key: string, fn: (current: T | null) => T | undefined) => {
          if (key.startsWith('runs/')) throw new Error('S3 down');
          return store.modify<T>(key, fn);
        },
      }),
    });
    expect((await as().post(PATH).expect(201)).body).toEqual({ repository: REPO, url: PR_URL });
    expect(error.mock.calls.map((a) => a.join(' ')).join('\n')).toMatch(/\[ERROR\].*could not be recorded/);
    expect((await usage()).entries[0]!.fixPullRequests).toBe(1);
  });

  test('a missing CSRF token: 403 before anything', async () => {
    const { as, github } = await build();
    expect((await as().postNoCsrf(PATH).expect(403)).body).toEqual({ error: CHECK_ERRORS.csrf });
    expect(github.checkPermission).not.toHaveBeenCalled();
  });

  test('no session: 401', async () => {
    const { app } = await build();
    await request(app).post(PATH).expect(401);
  });
});

describe('fix pull request title and body', () => {
  test('HTML, angle brackets, mentions and closing keywords are removed', () => {
    const cleaned = cleanExplanation(
      'Hi @lee and @acme/team. <script>alert(1)</script> a < b > c. Fixes #12, closes acme/x#3, Resolved: GH-4, fix https://github.com/acme/x/issues/5. The fix is small; email a@b.example.',
    );
    expect(cleaned).not.toMatch(/[<>]/);
    expect(cleaned).not.toContain('@');
    expect(cleaned).not.toMatch(/\b(fixes|closes|resolved|fix)\b\s*:?\s*(#|acme\/x#|GH-|https)/i);
    expect(cleaned).toContain('#12');
    expect(cleaned).toContain('The fix is small');
    expect(cleaned).toContain('Hi lee and acme/team.');
  });

  test('a keyword uncovered by a removal is removed too', () => {
    expect(cleanExplanation('fix @fixes #1')).not.toMatch(/fix(es)?\s*#1/i);
    expect(cleanExplanation('<b>fixes</b> #1')).not.toMatch(/fixes\s*#1/i);
  });

  test('the explanation is cut at 20,000 characters', () => {
    expect(cleanExplanation('x'.repeat(30000))).toHaveLength(20000);
  });

  test('the body follows the template', () => {
    const body = fixPullRequestBody(record(), 'Line one\n@lee fixes #3\n<i>x</i>');
    expect(body).toContain('> Line one\n> lee #3\n> x');
    expect(body).toContain(`https://github.com/${REPO}/runs/900001`);
    expect(body).toContain('`dana`');
    expect(body).not.toContain('@');
    expect(body).toMatch(/Someone other than `dana` should review and approve/);
    expect(body).toContain('did not run any command or test');
    expect(body).toContain(`Debug it run ID: ${ID}`);
  });

  test('without others the body has no other fix pull requests section', () => {
    expect(fixPullRequestBody(record(), 'x')).not.toContain('Fix pull requests from the same Debug it run');
    expect(fixPullRequestBody(record(), 'x', [])).not.toContain('Fix pull requests from the same Debug it run');
  });

  test('others are listed before the run ID line: a stored URL or a branch search', () => {
    const body = fixPullRequestBody(record(), 'x', [
      { repository: EXTRA, url: null, branch: `debug-it/${ID}/shared-lib` },
      { repository: 'acme/docs', url: 'https://github.com/acme/docs/pull/3', branch: `debug-it/${ID}/docs` },
    ]);
    const search = `https://github.com/acme/shared-lib/pulls?q=is%3Apr%20head%3Adebug-it%2F${ID}%2Fshared-lib`;
    expect(body).toContain(
      `Fix pull requests from the same Debug it run:\n\n- acme/shared-lib: ${search}\n- acme/docs: https://github.com/acme/docs/pull/3\n\nDebug it run ID: ${ID}`,
    );
  });

  test('a run target links the workflow run', () => {
    const body = fixPullRequestBody(record({ target: { kind: 'run', id: 810001 } }), 'x');
    expect(body).toContain(`https://github.com/${REPO}/actions/runs/810001`);
  });

  test('the title is cleaned and at most 200 characters', () => {
    expect(fixPullRequestTitle('test')).toBe('Debug it fix: test');
    expect(fixPullRequestTitle('<b>@lee</b> fixes #1\nnext')).toBe('Debug it fix: lee #1 next');
    expect(fixPullRequestTitle('x'.repeat(500))).toHaveLength(200);
  });
});
