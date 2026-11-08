// Story 7.4: the authorization phase and the audit check of leak-backend.ts,
// in-process, against an in-memory S3 store and the backend's mock GitHub App
// (with the fixed permission table). The real routes give zero FAILs; a
// permission table that lets erin in, or a record missing its requester or
// time, gives a FAIL. No session cookie or CSRF token is kept in the captured
// answers. The whole harness, over the fake GitHub, an in-memory S3 and a fake
// cluster (no Job can start), FAILs an extra adapter write outside Open a PR
// (SR6, SR10).
//
//   cd code/backend && npm ci     (once: the backend runs under tsx)
//   node --test helm/tests/attack/leak-backend.test.ts
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fakeGitHub, KEY, REPO as FAKE_REPO } from './fake-github.ts';
import {
  auditRecords,
  benignResult,
  checkLeakSettings,
  createReporter,
  createRouteClient,
  IDS,
  isolationOn,
  loadLeakBackend,
  permissionTable,
  postWebhook,
  runAuthorizationPhase,
  runLeakBackend,
  seededRecord,
  seedRun,
  settingsConfig,
  startRoutes,
  usageKeyOf,
  USERS,
  workflowJobEvent,
  type Captured,
} from './leak-backend.ts';

// Invented names only.
const REPO = 'acme-attack/payments-api';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SECRET = 'leak-test-webhook-secret-0123456789';

const b = await loadLeakBackend();

interface Setup {
  base: string;
  close: () => Promise<void>;
  sessions: any;
  runId: string;
  captured: Captured[];
  client: ReturnType<typeof createRouteClient>;
  store: any;
}

async function setup(table = permissionTable(REPO)): Promise<Setup> {
  const store = b.s3.createS3Store({ bucket: 'leak-test', client: b.s3.createMemoryS3Client() });
  const githubApp = { ...b.githubApp.createMockGitHubApp(), checkPermission: table };
  const settings = b.settings.createSettingsService({ store, config: settingsConfig(REPO) });
  const config = { ...b.config.DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'http://127.0.0.1', githubAppClientId: 'Iv1.attack' };
  const runs = b.runs.createRunService({ store, githubApp, config, isolation: isolationOn, organization: 'acme-attack', settings });
  const fixPullRequests = b.fix.createFixPullRequestService({ store, githubApp, config });
  const personalKeys = b.personalKeys.createPersonalKeyService({
    store,
    adapter: b.anthropic.createAnthropicAdapter({ mock: true }),
    encryptionKey: null,
    credentialsMode: 'organization',
  });
  const session = b.session.createSessionService(randomBytes(32), { secure: false });
  const routes = await startRoutes(b, config, { session, githubApp, settings, isolation: isolationOn, runs, fixPullRequests, personalKeys }, 0);
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const captured: Captured[] = [];
  const client = createRouteClient({ csrfOf: (cookie) => session.csrfToken(cookie), captured });
  const delivered = await postWebhook(routes.base, SECRET, workflowJobEvent(REPO, SHA, 'main', IDS.fullJob, IDS.fullRun, 'integration-tests'), client);
  assert.equal(delivered.status, 200);
  const runId = randomUUID();
  await seedRun(
    b,
    store,
    seededRecord({
      runId,
      jobId: IDS.matrixJob,
      jobName: 'leak-attack-authorization',
      repo: REPO,
      headSha: SHA,
      branch: 'main',
      usageKey: usageKeyOf(b, USERS.dana.uid),
      state: 'finished',
      result: benignResult(),
    }),
  );
  const mint = (user: { uid: number; login: string }) => {
    const cookie = session.seal(user);
    return { cookie, csrf: session.csrfToken(cookie) };
  };
  const sessions = { dana: mint(USERS.dana), erin: mint(USERS.erin), omar: mint(USERS.omar), priya: mint(USERS.priya) };
  return { base: routes.base, close: routes.close, sessions, runId, captured, client, store };
}

function collect() {
  const lines: string[] = [];
  return { lines, report: createReporter((line) => lines.push(line)) };
}

// The backend's [AUDIT] lines are not part of what is checked here.
const quiet = { log: console.log, error: console.error, warn: console.warn };
before(() => {
  console.log = () => undefined;
  console.error = () => undefined;
  console.warn = () => undefined;
});
after(() => {
  console.log = quiet.log;
  console.error = quiet.error;
  console.warn = quiet.warn;
});

describe('authorization phase (SR13)', () => {
  it('gives zero FAILs against the real routes', async () => {
    const s = await setup();
    try {
      const { lines, report } = collect();
      await runAuthorizationPhase({ base: s.base, client: s.client, sessions: s.sessions, runId: s.runId, jobId: IDS.fullJob, repo: REPO, report });
      assert.deepEqual(lines.filter((l) => l.startsWith('FAIL')), []);
      assert.equal(report.fails(), 0);
      assert.ok(lines.some((l) => /no session: 16 of 16 routes answered 401/.test(l)), lines.join('\n'));
      assert.ok(lines.some((l) => /omar \(not allowed\): 15 of 15 routes answered 403/.test(l)), lines.join('\n'));
      assert.ok(lines.some((l) => /erin \(no repository access\): 11 of 11/.test(l)), lines.join('\n'));
      assert.ok(lines.some((l) => /positive control: PUT feedback as dana with CSRF answered 200/.test(l)), lines.join('\n'));
      assert.ok(lines.some((l) => /without X-CSRF-Token: 10 of 10 state changes answered 403/.test(l)), lines.join('\n'));
    } finally {
      await s.close();
    }
  });

  it('keeps no session cookie or CSRF token in the captured answers', async () => {
    const s = await setup();
    try {
      const { report } = collect();
      await runAuthorizationPhase({ base: s.base, client: s.client, sessions: s.sessions, runId: s.runId, jobId: IDS.fullJob, repo: REPO, report });
      const text = JSON.stringify(s.captured);
      assert.ok(s.captured.length > 50);
      for (const { cookie, csrf } of Object.values(s.sessions) as Array<{ cookie: string; csrf: string }>) {
        assert.equal(text.includes(cookie), false);
        assert.equal(text.includes(csrf), false);
      }
      assert.ok(text.includes('[csrf token of this session]'));
    } finally {
      await s.close();
    }
  });

  it('fails when erin is given access to the repository', async () => {
    const leaky = async (user: { githubUserId: number }, repository: string) =>
      repository.toLowerCase() === REPO && (user.githubUserId === USERS.dana.uid || user.githubUserId === USERS.erin.uid) ? 'write' : 'none';
    const s = await setup(leaky);
    try {
      const { lines, report } = collect();
      await runAuthorizationPhase({ base: s.base, client: s.client, sessions: s.sessions, runId: s.runId, jobId: IDS.fullJob, repo: REPO, report });
      assert.ok(report.fails() > 0);
      assert.ok(lines.some((l) => /^FAIL - authorization: erin \(no repository access\): GET result answered 200, expected 403$/.test(l)), lines.join('\n'));
    } finally {
      await s.close();
    }
  });
});

describe('audit (SR15)', () => {
  const complete = (runId: string, extra: Record<string, unknown> = {}) => ({
    key: `runs/${runId}.json`,
    value: {
      ...seededRecord({
        runId,
        jobId: 1,
        jobName: 'build',
        repo: REPO,
        headSha: SHA,
        branch: 'main',
        usageKey: 'usage/2026-11/1000001.json',
        state: 'finished',
        result: benignResult(),
      }),
      ...extra,
    },
  });

  it('passes complete records, the fix pull request run with its URL', () => {
    const { lines, report } = collect();
    const fix = randomUUID();
    auditRecords(
      [complete(randomUUID()), complete(fix, { fixPullRequests: [{ repository: REPO, url: 'https://github.com/acme-attack/payments-api/pull/7' }] })],
      { fixRunId: fix, expected: 2 },
      report,
    );
    assert.equal(report.fails(), 0, lines.join('\n'));
    assert.ok(lines.some((l) => l === 'ok   - audit: all 2 run records are complete'));
  });

  it('fails a record missing its requester or its time', () => {
    for (const broken of [{ requester: undefined }, { requester: { githubUserId: 1000001 } }, { createdAt: undefined }, { createdAt: 'yesterday' }]) {
      const { lines, report } = collect();
      auditRecords([complete(randomUUID(), broken)], {}, report);
      assert.equal(report.fails(), 1, JSON.stringify(broken));
      assert.match(lines.join('\n'), /^FAIL - audit: run .* has no (requester|createdAt)/m);
    }
  });

  it('fails a run that is not final and a fix run without its URL', () => {
    const { lines, report } = collect();
    const fix = randomUUID();
    auditRecords([complete(randomUUID(), { state: 'analyzing' }), complete(fix)], { fixRunId: fix }, report);
    assert.equal(report.fails(), 2, lines.join('\n'));
    assert.match(lines.join('\n'), /final state \(is analyzing\)/);
    assert.match(lines.join('\n'), /fixPullRequests\[0\]\.url/);
  });
});

describe('settings', () => {
  it('names the first missing or malformed setting', () => {
    assert.equal(checkLeakSettings({}), 'FAIL - ATTACK_TEST_GITHUB_APP_ID is not set');
    const env: Record<string, string> = {
      ATTACK_TEST_GITHUB_APP_ID: '1',
      ATTACK_TEST_GITHUB_APP_PRIVATE_KEY: 'x',
      ATTACK_TEST_REPO: 'not a repository',
    };
    for (const name of [
      'ATTACK_SESSION_KEY',
      'ATTACK_PERSONAL_KEY_ENCRYPTION_KEY',
      'ATTACK_WEBHOOK_SECRET',
      'ATTACK_TELEMETRY_API_KEY',
      'ATTACK_ORG_KEY',
      'ATTACK_PERSONAL_KEY',
      'ATTACK_S3_ENDPOINT',
      'ATTACK_S3_BUCKET',
      'ATTACK_S3_ACCESS_KEY',
      'ATTACK_S3_SECRET_KEY',
      'DEBUG_IT_JOB_TEMPLATE',
      'DEBUG_JOB_IMAGE_TAG',
    ]) {
      env[name] = 'set';
    }
    assert.equal(checkLeakSettings(env), 'FAIL - ATTACK_TEST_REPO is not owner/name');
    assert.equal(checkLeakSettings({ ...env, ATTACK_TEST_REPO: REPO }), null);
  });
});

// The Debug Job template, shaped as the chart renders it (invented values).
const TEMPLATE = {
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: { name: 'debug-it-run', namespace: 'debug-it', labels: { 'app.kubernetes.io/name': 'debug-it-job' } },
  spec: {
    backoffLimit: 0,
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'debug-it-job' } },
      spec: {
        initContainers: [
          { name: 'receiver', image: 'debug-job' },
          { name: 'key-helper', image: 'debug-job' },
        ],
        containers: [{ name: 'claude', image: 'debug-job', env: [] }],
        volumes: ['anthropic-key', 'upload-code', 'result-code'].map((name) => ({ name, secret: { secretName: '' } })),
      },
    },
  },
};

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });

async function harness(wrapAdapterFetch?: Parameters<typeof runLeakBackend>[0]['wrapAdapterFetch']) {
  const work = mkdtempSync(join(tmpdir(), 'leak-harness-'));
  // The browser test is not part of this run.
  writeFileSync(join(work, 'browser-done'), '');
  const fake = fakeGitHub();
  await new Promise<void>((done) => fake.server.listen(0, '127.0.0.1', done));
  const apiBase = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const missing = () => Promise.reject(Object.assign(new Error('not found'), { code: 404 }));
  const kubeApi = {
    createJob: () => Promise.reject(Object.assign(new Error('no cluster'), { code: 500 })),
    createSecret: async () => undefined,
    deleteJob: missing,
    readJob: missing,
    listJobs: async () => ({ items: [] }),
    listPods: async () => ({ items: [] }),
  };
  const env = {
    ATTACK_TEST_GITHUB_APP_ID: '424242',
    ATTACK_TEST_GITHUB_APP_PRIVATE_KEY: KEY,
    ATTACK_TEST_REPO: FAKE_REPO,
    ATTACK_SESSION_KEY: randomBytes(32).toString('hex'),
    ATTACK_PERSONAL_KEY_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ATTACK_WEBHOOK_SECRET: `attack-webhook-${randomBytes(10).toString('hex')}`,
    ATTACK_TELEMETRY_API_KEY: `attack-telemetry-${randomBytes(10).toString('hex')}`,
    ATTACK_ORG_KEY: `sk-ant-api03-attack-organization-${randomBytes(12).toString('hex')}`,
    ATTACK_PERSONAL_KEY: `sk-ant-api03-attack-personal-${randomBytes(12).toString('hex')}`,
    ATTACK_S3_ENDPOINT: 'http://unused.invalid',
    ATTACK_S3_BUCKET: 'leak-test',
    ATTACK_S3_ACCESS_KEY: 'attacktest',
    ATTACK_S3_SECRET_KEY: randomBytes(12).toString('hex'),
    DEBUG_IT_JOB_TEMPLATE: JSON.stringify(TEMPLATE),
    DEBUG_JOB_IMAGE_TAG: 'attack-test',
    ATTACK_WORK: work,
    ATTACK_MAIN_PORT: '0',
    ATTACK_RESULTS_PORT: String(await freePort()),
  };
  const lines: string[] = [];
  try {
    await runLeakBackend({
      env,
      log: (line) => lines.push(line),
      apiBase,
      auth: fake.auth as any,
      s3Client: b.s3.createMemoryS3Client(),
      kubeApi,
      ...(wrapAdapterFetch ? { wrapAdapterFetch } : {}),
    });
  } finally {
    fake.server.closeAllConnections();
    await new Promise((done) => fake.server.close(done));
  }
  return lines;
}

describe('GitHub writes across the job (SR6, SR10)', () => {
  it('accepts Open a PR as the only adapter writes', async () => {
    const lines = await harness();
    assert.deepEqual(lines.filter((l) => l.startsWith('FAIL - GitHub')), []);
    assert.ok(lines.some((l) => /^ok {3}- GitHub writes: \d+ adapter writes across the job, all Open a PR's/.test(l)), lines.join('\n'));
  });

  it('fails an extra adapter write outside Open a PR', async () => {
    // A dishonest adapter: reading the context file at the start also tries to move main.
    let sent = false;
    const lines = await harness((fetch) => async (url, init) => {
      if (!sent && url.endsWith('/contents/.github/claude-debug-context.md')) {
        sent = true;
        await fetch(`https://api.github.com/repos/${FAKE_REPO}/git/refs`, {
          method: 'POST',
          body: JSON.stringify({ ref: 'refs/heads/main', sha: 'f'.repeat(40) }),
        });
      }
      return fetch(url, init);
    });
    assert.ok(sent);
    assert.ok(
      lines.some((l) => l === `FAIL - GitHub writes: the adapter sent POST /repos/${FAKE_REPO}/git/refs during full-run`),
      lines.join('\n'),
    );
  });
});
