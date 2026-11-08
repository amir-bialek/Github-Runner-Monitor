// Story 7.4 (SR12, SR13, SR15, SR16 input, plus SR6/SR10 across the job): the
// in-pod harness of the leak sweep and dashboard attack test.
//
// leak-attack-test.sh runs it in the test pod attack-backend, from the backend
// image, with the backend's labels and service account, in place of the
// chart's backend (scaled to 0):
//
//   cd /app && npx tsx /attack/leak-backend.ts
//
// It composes the backend's own modules in real mode: routes, check chain,
// sessions and CSRF (registerDebugIt on :3001, and a second personal-mode
// instance on its own port for the key flow, sharing the store); the GitHub
// webhook route; the run service, lifecycle, download step and Kubernetes
// adapter; the results listener on :3002; the S3 store against MinIO; the
// GitHub App adapter for the 7.3 test App; personal keys; telemetry pointed at
// a sink in this pod. Then, in this order:
//
//   1. authorization (SR13): every Debug it route without a session, as omar
//      (not allowed), erin (allowed, no repository access) and dana (not an
//      administrator); dana and priya with CSRF on one route of each kind
//      (positive control); every state change without X-CSRF-Token
//   2. personal key flow (SR12): dana saves, reads and deletes the fake
//      personal key on the personal-mode instance
//   3. full run (SR12, SR15): a signed workflow_job webhook, dana starts the
//      run, a real Debug Job runs real Claude Code through the 7.2 key helper
//   4. hostile run (SR12, SR15, SR16 input): a record seeded in analyzing gets
//      a hostile result on the real results port, then Open a PR on
//      ATTACK_TEST_REPO
//   5. "attack: browser-ready run=<id> job=<jobId>", then wait for
//      /work/browser-done (the browser test runs on the CI runner)
//   6. GitHub writes and tokens across the job (SR6, SR10), audit (SR15)
//   7. dump S3, write /work, clean up GitHub, delete the held Jobs, exit
//
// Test-only swaps, all here, each named where it is made:
//   - GET /orgs/{owner}/installation goes to GET /repos/{ATTACK_TEST_REPO}/installation (as 7.3);
//   - the run does not exist on GitHub: the adapter fetch serves an invented
//     failure log for actions/jobs/{id}/logs, the actions/runs/{id} answer and
//     an invented .github/claude-debug-context.md; commit and tarball reads stay real;
//   - checkPermission is a fixed table: dana write, erin none on ATTACK_TEST_REPO;
//   - the Anthropic adapter fetch answers 200 for the known fake personal key only;
//   - the isolation gate is a stub that is on (Story 7.1 proves isolation);
//   - the Job template comes patched from leak-attack-test.sh (key helper as in 7.2);
//   - Kubernetes deleteJob is held back until the end, so the Debug Job logs
//     can be collected first.
//
// Output: ok, FAIL and warn lines with names, statuses and counts (plus the one
// browser-ready line). Values, cookies, tokens and bodies are never printed.
// Files written to ATTACK_WORK (/work): values.json (the known values, input
// of leak-sweep.mjs), s3.jsonl, backend-console.txt, telemetry.jsonl,
// responses.jsonl and console.txt. Any FAIL exits 1.
//
// `node helm/tests/attack/leak-backend.ts mint-cookie` (ATTACK_SESSION_KEY in
// the environment) prints {"cookie","csrf"} for dana: the browser test's cookie.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cleanupFixPullRequest,
  coversOnly,
  createGitHubCall,
  createHarnessTokens,
  isOpenAPrWrite,
  newFilePatch,
  OWNER_NAME,
  READ,
  swapInstallationUrl,
  type Auth,
  type Log,
  type Recorded,
  type TokenRequest,
} from './github-write-attack.ts';
import { valueForms } from './leak-sweep.mjs';

const GITHUB = 'https://api.github.com';
const here = dirname(fileURLToPath(import.meta.url));

/** The invented users (SR13). */
export const USERS = {
  dana: { uid: 1000001, login: 'dana' }, // allowed, write access to ATTACK_TEST_REPO
  erin: { uid: 1000002, login: 'erin' }, // allowed, no repository access
  omar: { uid: 1000003, login: 'omar' }, // not allowed
  priya: { uid: 1000004, login: 'priya' }, // administrator
} as const;
type UserName = keyof typeof USERS;

/** Invented job, run and target IDs; they do not exist on GitHub. */
export const IDS = { fullJob: 740001, fullRun: 840001, hostileJob: 740002, matrixJob: 740003 } as const;
export const HOSTILE_JOB_NAME = 'leak-attack-hostile';
export const FULL_JOB_NAME = 'integration-tests';
const SESSION_COOKIE = 'dbg_session';
const DEBUG_NS = 'debug-it';
const FULL_RUN_WAIT_MS = 15 * 60_000; // the spec's 15 minutes from the start
const BROWSER_WAIT_MS = 15 * 60_000;
export const HOSTILE_SCRIPT = '<script>window.__attackRan=1</script>';
export const HOSTILE_IMAGE = '<img src="https://attack-outside.example/x.png" onerror="window.__attackRan=1">';

// Invented text only: no real log content.
const INVENTED_LOG = [
  '2026-11-07T09:58:01.0000000Z ##[group]Run npm run test:integration',
  '2026-11-07T09:58:02.0000000Z > payments-api@1.0.0 test:integration',
  '2026-11-07T09:58:09.0000000Z FAIL tests/refund-fee.test.js',
  '2026-11-07T09:58:09.0000000Z   refund fee: expected 2.50, received 2.05',
  '2026-11-07T09:58:10.0000000Z ##[error]Process completed with exit code 1.',
  '',
].join('\n');
const INVENTED_CONTEXT = [
  '# Debug context',
  '',
  '## About this repo',
  '',
  'An invented test repository for the Debug it leak attack test.',
  '',
  '## Common failures',
  '',
  'Integration tests fail when a fee rounds the wrong way.',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Loading the backend: one tsx graph, so the webhook route and the run service
// share one job store (each tsImport call gets its own module instances).

/** Where the backend lives: ATTACK_BACKEND_DIR (/app in the pod) or code/backend. */
export function backendDir(): string {
  return process.env.ATTACK_BACKEND_DIR ? resolve(process.env.ATTACK_BACKEND_DIR) : resolve(here, '../../../code/backend');
}

const MODULES = {
  debugIt: 'src/routes/debugIt.ts',
  webhook: 'src/routes/githubWebhook.ts',
  resultsRoute: 'src/routes/debugItResults.ts',
  config: 'src/services/debugItConfig.ts',
  session: 'src/services/session.ts',
  githubApp: 'src/adapters/githubApp.ts',
  settings: 'src/services/debugIt/settings.ts',
  s3: 'src/adapters/s3Store.ts',
  runs: 'src/services/debugIt/runs.ts',
  fix: 'src/services/debugIt/fixPullRequest.ts',
  lifecycle: 'src/services/debugIt/lifecycle.ts',
  downloads: 'src/services/debugIt/downloads.ts',
  kube: 'src/adapters/kubernetes.ts',
  telemetry: 'src/adapters/telemetry.ts',
  anthropic: 'src/adapters/anthropic.ts',
  personalKeys: 'src/services/debugIt/personalKeys.ts',
  results: 'src/services/debugIt/results.ts',
} as const;

let loaded: Promise<any> | undefined;

export function loadLeakBackend(dir: string = backendDir()): Promise<any> {
  loaded ??= (async () => {
    const requireBackend = createRequire(resolve(dir, 'package.json'));
    let tsImport: (specifier: string, parent: string) => Promise<any>;
    try {
      ({ tsImport } = await import(pathToFileURL(requireBackend.resolve('tsx/esm/api')).href));
    } catch {
      throw new Error('tsx not found; run npm ci in code/backend first');
    }
    const barrel = Object.entries(MODULES)
      .map(([name, file]) => `export * as ${name} from ${JSON.stringify(pathToFileURL(resolve(dir, file)).href)};`)
      .join('\n');
    const file = join(mkdtempSync(join(tmpdir(), 'leak-backend-')), 'backend.mts');
    writeFileSync(file, `${barrel}\n`);
    const modules = await tsImport(pathToFileURL(file).href, import.meta.url);
    return {
      ...modules,
      express: requireBackend('express'),
      requireBackend,
      schemaPath: resolve(dir, '../debug-job/schema/result.v1.json'),
    };
  })();
  return loaded;
}

// ---------------------------------------------------------------------------
// Reporting, known values and captured output

export interface Reporter {
  ok(text: string): void;
  fail(text: string): void;
  warn(text: string): void;
  line(text: string): void;
  fails(): number;
}

/** ok/FAIL/warn lines through `log`, each redacted against `hidden`. */
export function createReporter(log: Log, hidden: Set<string> = new Set()): Reporter {
  let fails = 0;
  const redact = (text: string): string => {
    let out = text;
    for (const value of [...hidden].sort((a, b) => b.length - a.length)) if (value.length >= 4) out = out.split(value).join('***');
    return out;
  };
  const line = (text: string): void => log(redact(text));
  return {
    ok: (text) => line(`ok   - ${text}`),
    fail: (text) => {
      fails += 1;
      line(`FAIL - ${text}`);
    },
    warn: (text) => line(`warn - ${text}`),
    line,
    fails: () => fails,
  };
}

export interface KnownValue {
  name: string;
  value: string;
}

/**
 * The known values the sweep searches for; every one, in every form the sweep
 * searches (base64, halves, ...), is also hidden from the output, so a leaked
 * form never reaches the job log before the sweep names it.
 */
export function createKnownValues(hidden: Set<string>) {
  const values: KnownValue[] = [];
  const seen = new Set<string>();
  const counters = new Map<string, number>();
  return {
    values,
    /** Adds a value; a name ending in # is numbered (session-cookie-1, -2, ...). */
    add(name: string, value: unknown): void {
      if (typeof value !== 'string' || value.trim() === '' || seen.has(value)) return;
      seen.add(value);
      for (const form of valueForms(value)) hidden.add(form);
      hidden.add(value);
      let label = name;
      if (name.endsWith('#')) {
        const n = (counters.get(name) ?? 0) + 1;
        counters.set(name, n);
        label = `${name.slice(0, -1)}${n}`;
      }
      values.push({ name: label, value });
    },
  };
}
type Known = ReturnType<typeof createKnownValues>;

export interface Captured {
  label: string;
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Caller = { cookie?: string; csrf?: string };

/**
 * An HTTP client for the backend's own routes that keeps every answer
 * (status, headers, body) for the sweep. The csrfToken field of
 * GET /debug-it/session is its designed carrier: it is replaced by a marker
 * only when it equals the token for the cookie sent; any other occurrence of a
 * token stays and is found by the sweep.
 */
export function createRouteClient(options: { csrfOf: (cookie: string) => string; captured: Captured[] }) {
  return async (
    base: string,
    label: string,
    method: string,
    path: string,
    caller: Caller = {},
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any; headers: Record<string, string>; text: string }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(caller.cookie ? { Cookie: `${SESSION_COOKIE}=${caller.cookie}` } : {}),
        ...(caller.csrf ? { 'X-CSRF-Token': caller.csrf } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    const answerHeaders: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      answerHeaders[name] = value;
    });
    let kept = text;
    if (path === '/debug-it/session' && caller.cookie && json && typeof json.csrfToken === 'string') {
      if (json.csrfToken === options.csrfOf(caller.cookie)) kept = JSON.stringify({ ...json, csrfToken: '[csrf token of this session]' });
    }
    options.captured.push({ label, method, path, status: res.status, headers: answerHeaders, body: kept });
    return { status: res.status, json, headers: answerHeaders, text };
  };
}
export type RouteClient = ReturnType<typeof createRouteClient>;

// ---------------------------------------------------------------------------
// Fixtures

/** A run record as the run service writes it, for a seeded run. */
export function seededRecord(options: {
  runId: string;
  jobId: number;
  jobName: string;
  repo: string;
  headSha: string;
  branch: string;
  usageKey: string;
  state: string;
  result: unknown;
  resultCodeHash?: string | null;
  user?: { uid: number; login: string };
}): Record<string, unknown> {
  const user = options.user ?? USERS.dana;
  const now = new Date().toISOString();
  return {
    runId: options.runId,
    target: { kind: 'job', id: options.jobId },
    requester: { githubUserId: user.uid, login: user.login },
    state: options.state,
    createdAt: now,
    updatedAt: now,
    repository: options.repo,
    headRepository: options.repo,
    headSha: options.headSha,
    branch: options.branch,
    jobName: options.jobName,
    downloads: [{ repository: options.repo, commitSha: options.headSha, folder: options.repo.split('/')[1] }],
    usageKey: options.usageKey,
    resultCodeHash: options.resultCodeHash ?? null,
    result: options.result,
    feedback: null,
    fixPullRequests: [],
    failureReason: null,
    deadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

/** Writes a seeded record and its usage entry, as the run service would have. */
export async function seedRun(b: any, store: any, record: Record<string, unknown>): Promise<void> {
  await store.create(`runs/${record.runId}.json`, record);
  await store.modify(record.usageKey as string, (current: any) => ({
    ...(current ?? {}),
    entries: [...(current?.entries ?? []), { runId: record.runId, costUsd: 0, fixPullRequests: 0 }],
  }));
}

export function usageKeyOf(b: any, uid: number): string {
  return `usage/${b.runs.usageMonth(new Date())}/${uid}.json`;
}

/** A benign finished result with no patch. */
export function benignResult(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    explanation: 'Debug it leak attack test (Story 7.4): a seeded run for the authorization checks.',
    causeLocation: { kind: 'this-repository' },
    patch: '',
    costUsd: 0,
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1000,
    logTruncated: false,
    failureReason: 'none',
  };
}

/** A signed workflow_job webhook delivery (completed, failure) for the invented job. */
export function workflowJobEvent(repo: string, headSha: string, branch: string, jobId: number, runId: number, name: string) {
  const [owner, repoName] = repo.split('/');
  const at = new Date().toISOString();
  return {
    action: 'completed',
    workflow_job: {
      id: jobId,
      run_id: runId,
      run_url: `${GITHUB}/repos/${repo}/actions/runs/${runId}`,
      run_attempt: 1,
      node_id: `CR_attack_${jobId}`,
      head_sha: headSha,
      head_branch: branch,
      url: `${GITHUB}/repos/${repo}/actions/jobs/${jobId}`,
      html_url: `https://github.com/${repo}/actions/runs/${runId}/job/${jobId}`,
      status: 'completed',
      conclusion: 'failure',
      created_at: at,
      started_at: at,
      completed_at: at,
      name,
      workflow_name: 'CI',
      steps: [],
      check_run_url: `${GITHUB}/repos/${repo}/check-runs/${jobId}`,
      labels: ['ubuntu-latest'],
      runner_id: null,
      runner_name: null,
      runner_group_id: null,
      runner_group_name: null,
    },
    repository: { full_name: repo, html_url: `https://github.com/${repo}`, name: repoName, owner: { login: owner } },
  };
}

export async function postWebhook(base: string, secret: string, event: unknown, client: RouteClient) {
  const raw = JSON.stringify(event);
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return client(base, 'webhook', 'POST', '/webhooks/github', {}, raw, {
    'X-GitHub-Event': 'workflow_job',
    'X-GitHub-Delivery': randomUUID(),
    'X-Hub-Signature-256': signature,
  });
}

// ---------------------------------------------------------------------------
// Routes: the backend's own Debug it routes on 127.0.0.1

/** Mounts the webhook route and registerDebugIt on 127.0.0.1:port (0 = any). */
export async function startRoutes(
  b: any,
  config: Record<string, unknown>,
  deps: Record<string, unknown>,
  port: number,
  host = '127.0.0.1',
): Promise<{ base: string; close: () => Promise<void> }> {
  const app = b.express();
  app.use(b.webhook.createWebhookRouter());
  app.use(b.express.json());
  b.debugIt.registerDebugIt(app, config, { ...deps, env: {} });
  const server: any = await new Promise((done, failed) => {
    const s = app.listen(port, host, () => done(s));
    s.once('error', failed);
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${actual}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

/** checkPermission as a fixed table (test-only swap): dana write, everyone else none, on `repo` only. */
export function permissionTable(repo: string) {
  return async (user: { githubUserId: number }, repository: string): Promise<string> => {
    if (repository.trim().toLowerCase() !== repo.toLowerCase()) return 'none';
    return user.githubUserId === USERS.dana.uid ? 'write' : 'none';
  };
}

export function settingsConfig(repo: string) {
  return {
    administrators: [String(USERS.priya.uid)],
    allowedRepositories: [repo],
    allowedUsers: [String(USERS.dana.uid), String(USERS.erin.uid)],
  };
}

export const isolationOn = {
  status: () => ({ state: 'on' as const, reason: null, checkedAt: new Date().toISOString() }),
};

// ---------------------------------------------------------------------------
// 1. Authorization matrix (SR13)

type Kind = 'session' | 'allowed' | 'repository' | 'admin';
interface RouteCase {
  label: string;
  method: string;
  path: string;
  kind: Kind;
  body?: unknown;
}

const INVENTED_REPOSITORY = 'acme-attack/invented-repo';

export function matrixRoutes(o: { runId: string; jobId: number; repo: string }): RouteCase[] {
  return [
    { label: 'GET session', method: 'GET', path: '/debug-it/session', kind: 'session' },
    { label: 'POST sign-out', method: 'POST', path: '/debug-it/sign-out', kind: 'session' },
    { label: 'GET runs list', method: 'GET', path: '/debug-it/runs', kind: 'allowed' },
    { label: 'POST start', method: 'POST', path: `/debug-it/targets/job/${o.jobId}/runs`, kind: 'repository', body: {} },
    { label: 'GET progress', method: 'GET', path: `/debug-it/runs/${o.runId}`, kind: 'repository' },
    { label: 'GET result', method: 'GET', path: `/debug-it/runs/${o.runId}/result`, kind: 'repository' },
    {
      label: 'PUT feedback',
      method: 'PUT',
      path: `/debug-it/runs/${o.runId}/feedback`,
      kind: 'repository',
      body: { rating: 'useful', comment: 'leak attack test' },
    },
    { label: 'POST Open a PR', method: 'POST', path: `/debug-it/runs/${o.runId}/pull-requests/${o.repo}`, kind: 'repository', body: {} },
    { label: 'GET personal key', method: 'GET', path: '/debug-it/personal-key', kind: 'allowed' },
    { label: 'PUT personal key', method: 'PUT', path: '/debug-it/personal-key', kind: 'allowed', body: { key: 'sk-ant-api03-attack-matrix-not-a-key-0000' } },
    { label: 'DELETE personal key', method: 'DELETE', path: '/debug-it/personal-key', kind: 'allowed' },
    { label: 'GET settings', method: 'GET', path: '/debug-it/settings', kind: 'admin' },
    { label: 'POST settings repository', method: 'POST', path: '/debug-it/settings/repositories', kind: 'admin', body: { repository: INVENTED_REPOSITORY } },
    { label: 'DELETE settings repository', method: 'DELETE', path: `/debug-it/settings/repositories/${INVENTED_REPOSITORY}`, kind: 'admin' },
    { label: 'POST settings user', method: 'POST', path: '/debug-it/settings/users', kind: 'admin', body: { login: 'invented-user' } },
    { label: 'DELETE settings user', method: 'DELETE', path: '/debug-it/settings/users/1000009', kind: 'admin' },
    { label: 'GET usage', method: 'GET', path: '/debug-it/usage', kind: 'admin' },
  ];
}

export interface MatrixContext {
  base: string;
  client: RouteClient;
  /** A session cookie and its CSRF token per user. */
  sessions: Record<UserName, { cookie: string; csrf: string }>;
  runId: string;
  jobId: number;
  repo: string;
  report: Reporter;
}

const STATE_CHANGE = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method);

/**
 * Runs the authorization matrix. Refusals print one ok line per caller, every
 * unexpected answer one FAIL line naming the route, the caller and the status.
 */
export async function runAuthorizationPhase(ctx: MatrixContext): Promise<void> {
  const { base, client, sessions, report } = ctx;
  const routes = matrixRoutes(ctx);
  const send = (route: RouteCase, who: string, caller: Caller) =>
    client(base, `authorization ${who}: ${route.label}`, route.method, route.path, caller, route.body);

  // No session: 401 everywhere. Sign-out without a session has nothing to
  // sign out: it answers 204 with a clearing cookie (production behavior).
  let refused = 0;
  for (const route of routes) {
    const answer = await send(route, 'no session', {});
    if (route.label === 'POST sign-out') {
      const cookie = answer.headers['set-cookie'] ?? '';
      if (answer.status === 204 && /^dbg_session=;/.test(cookie)) report.ok('authorization: no session: POST sign-out answered 204 and only clears the cookie');
      else report.fail(`authorization: no session: POST sign-out answered ${answer.status}`);
      continue;
    }
    if (answer.status === 401) refused += 1;
    else report.fail(`authorization: no session: ${route.label} answered ${answer.status}, expected 401`);
  }
  report.ok(`authorization: no session: ${refused} of ${routes.length - 1} routes answered 401`);

  // Forged cookie: same as none.
  const forged = await send(routes[2]!, 'forged session', { cookie: randomBytes(48).toString('base64url') });
  if (forged.status === 401) report.ok('authorization: a forged session cookie answered 401');
  else report.fail(`authorization: a forged session cookie answered ${forged.status}, expected 401`);

  // omar (not allowed): 403 on every allowed, repository and admin route.
  const caller = (name: UserName): Caller => ({ cookie: sessions[name].cookie, csrf: sessions[name].csrf });
  refused = 0;
  let asked = 0;
  for (const route of routes) {
    if (route.kind === 'session') continue;
    asked += 1;
    const answer = await send(route, 'omar', caller('omar'));
    if (answer.status === 403) refused += 1;
    else report.fail(`authorization: omar (not allowed): ${route.label} answered ${answer.status}, expected 403`);
  }
  report.ok(`authorization: omar (not allowed): ${refused} of ${asked} routes answered 403`);
  const omarSession = await send(routes[0]!, 'omar', caller('omar'));
  if (omarSession.status === 200 && omarSession.json?.allowedUser === false && omarSession.json?.administrator === false) {
    report.ok('authorization: omar (not allowed): GET session says not allowed, not an administrator');
  } else {
    report.fail(`authorization: omar (not allowed): GET session answered ${omarSession.status} allowedUser ${String(omarSession.json?.allowedUser)}`);
  }

  // erin (allowed, no repository access): 403 on the repository and admin routes.
  refused = 0;
  asked = 0;
  for (const route of routes) {
    if (route.kind !== 'repository' && route.kind !== 'admin') continue;
    asked += 1;
    const answer = await send(route, 'erin', caller('erin'));
    if (answer.status === 403) refused += 1;
    else report.fail(`authorization: erin (no repository access): ${route.label} answered ${answer.status}, expected 403`);
  }
  report.ok(`authorization: erin (no repository access): ${refused} of ${asked} repository and admin routes answered 403`);
  const erinList = await send(routes[2]!, 'erin', caller('erin'));
  const erinRuns: unknown[] = Array.isArray(erinList.json?.runs) ? erinList.json.runs : [];
  if (erinList.status === 200 && !erinRuns.some((r: any) => r?.runId === ctx.runId)) {
    report.ok(`authorization: erin (no repository access): GET runs list answered 200 without dana's run`);
  } else {
    report.fail(`authorization: erin (no repository access): GET runs list answered ${erinList.status} with ${erinRuns.length} runs`);
  }

  // dana (allowed, not an administrator): 403 on the admin routes.
  refused = 0;
  asked = 0;
  for (const route of routes) {
    if (route.kind !== 'admin') continue;
    asked += 1;
    const answer = await send(route, 'dana', caller('dana'));
    if (answer.status === 403) refused += 1;
    else report.fail(`authorization: dana (not an administrator): ${route.label} answered ${answer.status}, expected 403`);
  }
  report.ok(`authorization: dana (not an administrator): ${refused} of ${asked} admin routes answered 403`);

  // A signed in allowed user without X-CSRF-Token: 403 on every state change.
  refused = 0;
  asked = 0;
  for (const route of routes) {
    if (!STATE_CHANGE(route.method)) continue;
    asked += 1;
    const who: UserName = route.kind === 'admin' ? 'priya' : 'dana';
    const answer = await send(route, `${who} without CSRF`, { cookie: sessions[who].cookie });
    if (answer.status === 403) refused += 1;
    else report.fail(`authorization: ${who} without X-CSRF-Token: ${route.label} answered ${answer.status}, expected 403`);
  }
  report.ok(`authorization: without X-CSRF-Token: ${refused} of ${asked} state changes answered 403`);

  // Positive control: one route of each kind passes with a session and CSRF.
  const positive: Array<[string, UserName]> = [
    ['GET session', 'dana'],
    ['POST sign-out', 'dana'],
    ['GET runs list', 'dana'],
    ['GET personal key', 'dana'],
    ['GET progress', 'dana'],
    ['PUT feedback', 'dana'],
    ['GET settings', 'priya'],
    ['POST settings repository', 'priya'],
    ['DELETE settings repository', 'priya'],
    ['GET usage', 'priya'],
  ];
  for (const [label, who] of positive) {
    const route = routes.find((r) => r.label === label)!;
    const answer = await send(route, `${who} positive control`, caller(who));
    if (answer.status !== 401 && answer.status !== 403 && answer.status < 500) {
      report.ok(`authorization: positive control: ${label} as ${who} with CSRF answered ${answer.status}`);
    } else {
      report.fail(`authorization: positive control: ${label} as ${who} with CSRF answered ${answer.status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6b. Audit (SR15)

const FINAL = new Set(['finished', 'failed']);

/**
 * Every run record must name its requester (GitHub user ID and login), its
 * time, repository, target and job and a final state; the fix pull request
 * run must hold the pull request URL.
 */
export function auditRecords(
  records: Array<{ key: string; value: any }>,
  options: { labels?: Map<string, string>; fixRunId?: string | null; expected?: number },
  report: Reporter,
): void {
  let complete = 0;
  for (const { key, value } of records) {
    const runId = typeof value?.runId === 'string' ? value.runId : key;
    const label = options.labels?.get(runId) ?? `run ${runId}`;
    const missing: string[] = [];
    if (!Number.isSafeInteger(value?.requester?.githubUserId) || value.requester.githubUserId <= 0) missing.push('requester.githubUserId');
    if (typeof value?.requester?.login !== 'string' || value.requester.login === '') missing.push('requester.login');
    if (typeof value?.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) missing.push('createdAt');
    if (typeof value?.repository !== 'string' || !OWNER_NAME.test(value.repository)) missing.push('repository');
    if (!value?.target || (value.target.kind !== 'job' && value.target.kind !== 'run') || !Number.isSafeInteger(value.target.id)) {
      missing.push('target');
    }
    if (typeof value?.jobName !== 'string' || value.jobName === '') missing.push('jobName');
    if (!FINAL.has(value?.state)) missing.push(`final state (is ${String(value?.state)})`);
    if (options.fixRunId && runId === options.fixRunId) {
      const url = Array.isArray(value?.fixPullRequests) ? value.fixPullRequests[0]?.url : undefined;
      if (typeof url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) missing.push('fixPullRequests[0].url');
    }
    if (missing.length === 0) complete += 1;
    else report.fail(`audit: ${label} has no ${missing.join(', no ')}`);
  }
  if (options.fixRunId && !records.some((r) => r.value?.runId === options.fixRunId)) report.fail('audit: the fix pull request run has no record');
  if (options.expected !== undefined && records.length < options.expected) {
    report.fail(`audit: ${records.length} run records, expected at least ${options.expected}`);
  }
  if (complete === records.length && records.length > 0) report.ok(`audit: all ${complete} run records are complete`);
}

// ---------------------------------------------------------------------------
// The value forms (as leak-sweep.mjs searches them)

export function base64Forms(value: string): string[] {
  return [Buffer.from(value, 'utf8').toString('base64'), Buffer.from(value, 'utf8').toString('base64url')];
}

// ---------------------------------------------------------------------------
// The in-pod run

export interface KubeApi {
  createJob(params: any): Promise<any>;
  createSecret(params: any): Promise<unknown>;
  deleteJob(params: any): Promise<unknown>;
  readJob(params: any): Promise<any>;
  listJobs(params: any): Promise<any>;
  listPods(params: any): Promise<any>;
}

export interface LeakBackendOptions {
  env: Record<string, string | undefined>;
  log: Log;
  /** Local dry runs only: where https://api.github.com goes (default GitHub). */
  apiBase?: string;
  /** Local dry runs only: the App's auth (default createAppAuth with the App ID and key). */
  auth?: Auth;
  /** Local dry runs only: the S3 client ({ name, input } commands; default the SDK against ATTACK_S3_ENDPOINT). */
  s3Client?: { send(command: { name: string; input: Record<string, unknown> }): Promise<any> };
  /** Local dry runs only: the Kubernetes calls (default the in-cluster API). */
  kubeApi?: KubeApi;
  /** Unit tests only: wraps the recording fetch the adapter calls (to model a dishonest adapter). */
  wrapAdapterFetch?: (fetch: (url: string, init?: RequestInit) => Promise<Response>) => (url: string, init?: RequestInit) => Promise<Response>;
}

const HARNESS_SECRETS = ['ATTACK_TEST_GITHUB_APP_ID', 'ATTACK_TEST_GITHUB_APP_PRIVATE_KEY', 'ATTACK_TEST_REPO'] as const;
const POD_SETTINGS = [
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
] as const;

/** The FAIL line for the first missing or malformed setting, or null. */
export function checkLeakSettings(env: Record<string, string | undefined>): string | null {
  for (const name of [...HARNESS_SECRETS, ...POD_SETTINGS]) {
    if (!env[name] || env[name]!.trim() === '') return `FAIL - ${name} is not set`;
  }
  if (!OWNER_NAME.test(env.ATTACK_TEST_REPO!.trim())) return 'FAIL - ATTACK_TEST_REPO is not owner/name';
  return null;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function runLeakBackend(options: LeakBackendOptions): Promise<number> {
  const { env } = options;
  const work = resolve(env.ATTACK_WORK ?? '/work');
  mkdirSync(work, { recursive: true });
  const consoleFile = join(work, 'console.txt');
  const hidden = new Set<string>();
  const report = createReporter((line) => {
    options.log(line);
    appendFileSync(consoleFile, `${line}\n`);
  }, hidden);
  const missing = checkLeakSettings(env);
  if (missing) {
    report.line(missing);
    return 1;
  }
  const known = createKnownValues(hidden);
  const repo = env.ATTACK_TEST_REPO!.trim();
  const [owner, name] = repo.split('/') as [string, string];
  const privateKey = env.ATTACK_TEST_GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n');
  known.add('github-app-private-key', env.ATTACK_TEST_GITHUB_APP_PRIVATE_KEY);
  known.add('github-app-private-key-pem', privateKey);
  privateKey
    .split('\n')
    .filter((line) => line.trim().length >= 16 && !line.startsWith('-----'))
    .forEach((line) => known.add('github-app-private-key-line-#', line.trim()));
  const sessionKeyText = env.ATTACK_SESSION_KEY!.trim();
  const personalKeyText = env.ATTACK_PERSONAL_KEY_ENCRYPTION_KEY!.trim();
  known.add('session-key', sessionKeyText);
  known.add('personal-key-encryption-key', personalKeyText);
  known.add('webhook-secret', env.ATTACK_WEBHOOK_SECRET!.trim());
  known.add('telemetry-api-key', env.ATTACK_TELEMETRY_API_KEY!.trim());
  known.add('organization-anthropic-key', env.ATTACK_ORG_KEY!.trim());
  known.add('personal-anthropic-key', env.ATTACK_PERSONAL_KEY!.trim());
  known.add('s3-access-key', env.ATTACK_S3_ACCESS_KEY!.trim());
  known.add('s3-secret-key', env.ATTACK_S3_SECRET_KEY!.trim());
  const ORG_KEY = env.ATTACK_ORG_KEY!.trim();
  const PERSONAL_KEY = env.ATTACK_PERSONAL_KEY!.trim();
  const TELEMETRY_KEY = env.ATTACK_TELEMETRY_API_KEY!.trim();
  const WEBHOOK_SECRET = env.ATTACK_WEBHOOK_SECRET!.trim();

  // Output files, written as the run goes.
  const files = {
    s3: join(work, 's3.jsonl'),
    backend: join(work, 'backend-console.txt'),
    telemetry: join(work, 'telemetry.jsonl'),
    responses: join(work, 'responses.jsonl'),
    values: join(work, 'values.json'),
  };
  for (const file of Object.values(files)) writeFileSync(file, '');

  let b: any;
  try {
    b = await loadLeakBackend();
  } catch (error) {
    report.fail(`setup: ${(error as Error).message}`);
    return report.fails();
  }
  const sessionKey = b.session.parseSessionKey(sessionKeyText);
  const encryptionKey = b.session.parseSessionKey(personalKeyText);
  if (!sessionKey || !encryptionKey) {
    report.fail('setup: ATTACK_SESSION_KEY or ATTACK_PERSONAL_KEY_ENCRYPTION_KEY is not a 32 byte key');
    return report.fails();
  }
  known.add('session-key-bytes-base64', sessionKey.toString('base64'));
  known.add('session-key-bytes-hex', sessionKey.toString('hex'));
  known.add('personal-key-encryption-key-bytes-base64', encryptionKey.toString('base64'));
  known.add('personal-key-encryption-key-bytes-hex', encryptionKey.toString('hex'));

  // The backend's own log lines: every line, unredacted, to backend-console.txt
  // (the backend logs the sweep searches); on stdout only non-[AUDIT] lines, redacted.
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const backendLine = (...args: unknown[]): void => {
    const line = args.map(String).join(' ');
    appendFileSync(files.backend, `${line}\n`);
    if (!line.startsWith('[AUDIT]')) report.line(`       backend: ${line}`);
  };
  console.log = backendLine;
  console.error = backendLine;
  console.warn = backendLine;
  console.info = backendLine;

  // ---- GitHub: recording auth and fetch around the adapter ----------------
  let baseAuth: Auth;
  if (options.auth) baseAuth = options.auth;
  else {
    const { createAppAuth } = await import(pathToFileURL(b.requireBackend.resolve('@octokit/auth-app')).href);
    baseAuth = createAppAuth({ appId: env.ATTACK_TEST_GITHUB_APP_ID!.trim(), privateKey }) as Auth;
  }
  const apiBase = (options.apiBase ?? GITHUB).replace(/\/+$/, '');
  const authHidden: Auth = async (authOptions) => {
    const answer = await baseAuth(authOptions);
    if (typeof answer?.token === 'string') known.add(authOptions.type === 'app' ? 'github-app-jwt-#' : 'github-installation-token-#', answer.token);
    return answer;
  };
  let phase = 'setup';
  const requests: Recorded[] = [];
  const tokenRequests: TokenRequest[] = [];
  const recordingAuth: Auth = async (authOptions) => {
    const answer = await authHidden(authOptions);
    if (authOptions.type === 'installation') {
      tokenRequests.push({ phase, repositoryNames: authOptions.repositoryNames, permissions: authOptions.permissions, token: answer.token });
    }
    return answer;
  };
  const lower = (text: string) => text.toLowerCase();
  const recordingFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    // Test-only swap (as 7.3): the test repositories live on a user account.
    const target = swapInstallationUrl(url, owner, repo);
    const parsed = new URL(target);
    const path = decodeURIComponent(parsed.pathname);
    let body: any;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    requests.push({ phase, method, path, ref: body?.ref, draft: body?.draft });
    if (parsed.origin === GITHUB && method === 'GET') {
      const base = lower(`/repos/${repo}`);
      // Test-only swaps: the invented run does not exist on GitHub.
      if (lower(path) === `${base}/actions/jobs/${IDS.fullJob}/logs`) {
        return new Response(INVENTED_LOG, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (lower(path) === `${base}/actions/runs/${IDS.fullRun}`) {
        return Response.json({
          id: IDS.fullRun,
          head_sha: fullHead,
          head_branch: defaultBranch,
          head_repository: { full_name: repo },
          path: '.github/workflows/ci.yml',
        });
      }
      if (lower(path) === `${base}/contents/.github/claude-debug-context.md`) {
        const bytes = Buffer.from(INVENTED_CONTEXT, 'utf8');
        return Response.json({ type: 'file', size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' });
      }
    }
    return fetch(parsed.origin === GITHUB ? `${apiBase}${parsed.pathname}${parsed.search}` : target, init);
  };
  const call = createGitHubCall(apiBase);
  const harnessToken = createHarnessTokens(authHidden, call, repo);
  let fullHead = '';
  let defaultBranch = '';

  // ---- S3 against MinIO ---------------------------------------------------
  let s3Client = options.s3Client;
  if (!s3Client) {
    const sdk = b.requireBackend('@aws-sdk/client-s3');
    const sdkClient = new sdk.S3Client({
      region: 'us-east-1',
      endpoint: env.ATTACK_S3_ENDPOINT!.trim(),
      forcePathStyle: true,
      credentials: { accessKeyId: env.ATTACK_S3_ACCESS_KEY!.trim(), secretAccessKey: env.ATTACK_S3_SECRET_KEY!.trim() },
    });
    s3Client = { send: (command) => sdkClient.send(new sdk[command.name](command.input)) };
  }
  const bucket = env.ATTACK_S3_BUCKET!.trim();
  const store = b.s3.createS3Store({ bucket, client: s3Client });

  // ---- Telemetry sink -----------------------------------------------------
  let telemetryBodies = 0;
  let telemetryKeyOk = true;
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      telemetryBodies += 1;
      if (req.headers['x-api-key'] !== TELEMETRY_KEY) telemetryKeyOk = false;
      // Bodies only: the x-api-key header is the key's designed carrier.
      appendFileSync(files.telemetry, `${Buffer.concat(chunks).toString('utf8')}\n`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((done) => sink.listen(0, '127.0.0.1', () => done()));
  const telemetry = b.telemetry.createTelemetryAdapter({
    enabled: true,
    endpoint: `http://127.0.0.1:${(sink.address() as AddressInfo).port}`,
    apiKey: TELEMETRY_KEY,
  });

  // ---- Kubernetes: the cluster API, Secrets captured, deletes held --------
  let cluster: KubeApi;
  if (options.kubeApi) cluster = options.kubeApi;
  else {
    const k8s = await import(pathToFileURL(b.requireBackend.resolve('@kubernetes/client-node')).href);
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromCluster();
    const batch = kubeConfig.makeApiClient(k8s.BatchV1Api);
    const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
    // The same six calls as the backend's createClusterApi (not exported).
    cluster = {
      createJob: ({ namespace, body }) => batch.createNamespacedJob({ namespace, body }),
      createSecret: ({ namespace, body }) => core.createNamespacedSecret({ namespace, body }),
      deleteJob: ({ name: jobName, namespace, propagationPolicy }) => batch.deleteNamespacedJob({ name: jobName, namespace, propagationPolicy }),
      readJob: ({ name: jobName, namespace }) => batch.readNamespacedJob({ name: jobName, namespace }),
      listJobs: ({ namespace, labelSelector }) => batch.listNamespacedJob({ namespace, labelSelector }),
      listPods: ({ namespace, labelSelector }) => core.listNamespacedPod({ namespace, labelSelector }),
    };
  }
  const heldDeletes = new Set<string>();
  let secretsCreated = 0;
  const capturedKeys: string[] = [];
  const api: KubeApi = {
    createJob: (params) => cluster.createJob(params),
    createSecret: async ({ namespace, body }: any) => {
      secretsCreated += 1;
      for (const [item, encoded] of Object.entries((body?.data ?? {}) as Record<string, string>)) {
        const value = Buffer.from(encoded, 'base64').toString('utf8');
        if (item === 'anthropic-api-key') capturedKeys.push(value);
        known.add(item === 'anthropic-api-key' ? 'per-run-anthropic-key-#' : `${item}-#`, value);
      }
      await cluster.createSecret({ namespace, body });
    },
    // Held back until the Debug Job logs are collected (test-only swap).
    deleteJob: async ({ name: jobName }: any) => {
      heldDeletes.add(jobName);
    },
    readJob: (params) => cluster.readJob(params),
    listJobs: (params) => cluster.listJobs(params),
    listPods: (params) => cluster.listPods(params),
  };
  const kubernetes = b.kube.createKubernetesAdapter({
    namespace: env.DEBUG_IT_NAMESPACE?.trim() || DEBUG_NS,
    template: b.kube.parseJobTemplate(env.DEBUG_IT_JOB_TEMPLATE!),
    imageTag: env.DEBUG_JOB_IMAGE_TAG!.trim(),
    api,
  });

  // ---- The backend's services ---------------------------------------------
  const adapter = b.githubApp.createGitHubApp({
    appId: env.ATTACK_TEST_GITHUB_APP_ID!.trim(),
    privateKey,
    clientId: '',
    clientSecret: '',
    organization: owner,
    auth: recordingAuth,
    fetch: options.wrapAdapterFetch ? options.wrapAdapterFetch(recordingFetch) : recordingFetch,
  });
  // Test-only swap: user repository access is a fixed table.
  const githubApp = { ...adapter, checkPermission: permissionTable(repo) };
  const settings = b.settings.createSettingsService({ store, config: settingsConfig(repo) });
  const limits = { ...b.config.DEBUG_IT_DEFAULTS.limits, maxConcurrentRuns: 2, maxRunsPerUser: 2 };
  const config = { ...b.config.DEBUG_IT_DEFAULTS, enabled: true, limits, publicUrl: 'http://127.0.0.1', githubAppClientId: 'Iv1.attack' };
  const runs = b.runs.createRunService({ store, githubApp, config, isolation: isolationOn, organization: owner, settings });
  const fixPullRequests = b.fix.createFixPullRequestService({ store, githubApp, config });
  const session = b.session.createSessionService(sessionKey, { secure: false });
  const orgKeys = b.personalKeys.createPersonalKeyService({
    store,
    adapter: b.anthropic.createAnthropicAdapter({ fetch: async () => ({ status: 401 }) }),
    encryptionKey: null,
    credentialsMode: 'organization',
  });
  // Test-only swap: the Anthropic key check answers 200 for the known fake personal key only.
  const anthropicFetch = async (_url: string, init: { headers: Record<string, string> }) => ({
    status: init.headers['x-api-key'] === PERSONAL_KEY ? 200 : 401,
    body: null,
  });
  const personalKeys = b.personalKeys.createPersonalKeyService({
    store,
    adapter: b.anthropic.createAnthropicAdapter({ fetch: anthropicFetch }),
    encryptionKey,
    credentialsMode: 'personal',
  });
  const downloads = b.downloads.createDownloadStep({
    store,
    githubApp,
    settings,
    organization: owner,
    logLimitBytes: limits.logLimitBytes,
  });
  const lifecycle = b.lifecycle.createRunLifecycle({
    store,
    kubernetes,
    downloads,
    isolation: isolationOn,
    runs,
    config,
    apiKeyFor: async () => ORG_KEY,
    telemetry,
  });
  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;

  const captured: Captured[] = [];
  const client = createRouteClient({ csrfOf: (cookie) => session.csrfToken(cookie), captured });
  const flushResponses = () => {
    for (const answer of captured.splice(0)) appendFileSync(files.responses, `${JSON.stringify(answer)}\n`);
  };
  const newSession = (user: { uid: number; login: string }) => {
    const cookie = session.seal(user);
    const csrf = session.csrfToken(cookie);
    known.add('session-cookie-#', cookie);
    known.add('csrf-token-#', csrf);
    return { cookie, csrf };
  };

  const closers: Array<() => Promise<void>> = [];
  let resultsServer: any;
  let fixRunId: string | null = null;
  let prNumber: number | null = null;
  const labels = new Map<string, string>();
  try {
    // ---- Setup -------------------------------------------------------------
    await store.checkReachable();
    report.ok(`setup: S3 bucket ${bucket} answers`);
    const readToken = await harnessToken(repo, READ);
    const info = await call(readToken, 'GET', `/repos/${repo}`);
    defaultBranch = typeof info.json?.default_branch === 'string' ? info.json.default_branch : '';
    if (!defaultBranch) throw new Error(`${repo} has no default branch (GitHub answered ${info.status})`);
    const head = await call(readToken, 'GET', `/repos/${repo}/git/ref/heads/${defaultBranch.split('/').map(encodeURIComponent).join('/')}`);
    fullHead = typeof head.json?.object?.sha === 'string' ? head.json.object.sha : '';
    if (!fullHead) throw new Error(`${repo} ${defaultBranch} has no head (GitHub answered ${head.status})`);
    report.ok(`setup: ${repo} default branch ${defaultBranch} read`);

    const deps = { session, githubApp, settings, isolation: isolationOn, runs, fixPullRequests };
    const org = await startRoutes(b, config, { ...deps, personalKeys: orgKeys }, Number(env.ATTACK_MAIN_PORT ?? 3001), '0.0.0.0');
    closers.push(org.close);
    const personal = await startRoutes(b, { ...config, credentialsMode: 'personal' }, { ...deps, personalKeys }, 0);
    closers.push(personal.close);
    resultsServer = b.resultsRoute.openResultsListener(
      { enabled: true, resultsPort: Number(env.ATTACK_RESULTS_PORT ?? 3002), credentialsMode: 'organization' },
      {
        store: () => store,
        apiKeyFor: () => ORG_KEY,
        schemaPath: b.schemaPath,
        onAccepted: lifecycle.onResultAccepted,
        onFailed: lifecycle.onRunFailed,
      },
    );
    lifecycle.start();
    report.ok('setup: routes on :3001, results port on :3002, personal-mode routes, lifecycle started');

    const sessions = {
      dana: newSession(USERS.dana),
      erin: newSession(USERS.erin),
      omar: newSession(USERS.omar),
      priya: newSession(USERS.priya),
    };

    // The webhook first: the start route finds its target only in the webhook store.
    const delivered = await postWebhook(
      org.base,
      WEBHOOK_SECRET,
      workflowJobEvent(repo, fullHead, defaultBranch, IDS.fullJob, IDS.fullRun, FULL_JOB_NAME),
      client,
    );
    if (delivered.status === 200 && delivered.json?.applied === true) report.ok('setup: signed workflow_job webhook applied');
    else report.fail(`setup: signed workflow_job webhook answered ${delivered.status}, applied ${String(delivered.json?.applied)}`);

    // ---- 1. Authorization (SR13) -----------------------------------------
    phase = 'authorization';
    const matrixRunId = randomUUID();
    labels.set(matrixRunId, 'the authorization run');
    await seedRun(
      b,
      store,
      seededRecord({
        runId: matrixRunId,
        jobId: IDS.matrixJob,
        jobName: 'leak-attack-authorization',
        repo,
        headSha: fullHead,
        branch: defaultBranch,
        usageKey: usageKeyOf(b, USERS.dana.uid),
        state: 'finished',
        result: benignResult(),
      }),
    );
    await runAuthorizationPhase({ base: org.base, client, sessions, runId: matrixRunId, jobId: IDS.fullJob, repo, report });
    flushResponses();

    // ---- 2. Personal key flow (SR12) -------------------------------------
    phase = 'personal-key';
    const dana = sessions.dana;
    const keyObject = `personal-keys/${USERS.dana.uid}.json`;
    const onlyLast4 = (json: any, saved: boolean): boolean =>
      json !== null &&
      typeof json === 'object' &&
      Object.keys(json).sort().join(',') === 'credentialsMode,last4,saved' &&
      json.saved === saved &&
      json.last4 === (saved ? PERSONAL_KEY.slice(-4) : null);
    const put = await client(personal.base, 'personal key PUT', 'PUT', '/debug-it/personal-key', dana, { key: PERSONAL_KEY });
    if (put.status === 200 && onlyLast4(put.json, true)) report.ok('personal key: PUT answered 200 with only credentialsMode, saved and last4');
    else report.fail(`personal key: PUT answered ${put.status}${onlyLast4(put.json, true) ? '' : ' with other fields than last4'}`);
    const got = await client(personal.base, 'personal key GET', 'GET', '/debug-it/personal-key', dana);
    if (got.status === 200 && onlyLast4(got.json, true)) report.ok('personal key: GET answered 200 with only credentialsMode, saved and last4');
    else report.fail(`personal key: GET answered ${got.status}${onlyLast4(got.json, true) ? '' : ' with other fields than last4'}`);
    const stored = await store.read(keyObject);
    if (!stored) {
      report.fail('personal key: no S3 object debug-it/personal-keys/{uid}.json after PUT');
    } else {
      const raw = JSON.stringify(stored.value);
      const forms = [PERSONAL_KEY, ...base64Forms(PERSONAL_KEY), PERSONAL_KEY.slice(0, PERSONAL_KEY.length >> 1), PERSONAL_KEY.slice(PERSONAL_KEY.length >> 1)];
      const ciphertext = typeof stored.value?.ciphertext === 'string' ? Buffer.from(stored.value.ciphertext, 'base64').toString('utf8') : '';
      if (forms.some((form) => raw.includes(form))) report.fail('personal key: the S3 object holds a form of the key');
      else report.ok('personal key: the S3 object holds no form of the key');
      if (ciphertext !== '' && ciphertext !== PERSONAL_KEY && !ciphertext.includes(PERSONAL_KEY)) {
        report.ok('personal key: the stored ciphertext decoded is not the key');
      } else {
        report.fail('personal key: the stored ciphertext is missing or decodes to the key');
      }
      const fields = Object.keys(stored.value ?? {}).sort().join(',');
      if (fields === 'ciphertext,nonce,savedAt,tag,v') report.ok('personal key: the S3 object is {v, nonce, ciphertext, tag, savedAt}');
      else report.fail(`personal key: the S3 object has fields ${fields}`);
    }
    const removed = await client(personal.base, 'personal key DELETE', 'DELETE', '/debug-it/personal-key', dana);
    if (removed.status === 200 && removed.json?.saved === false && removed.json?.last4 === null) report.ok('personal key: DELETE answered 200, nothing saved');
    else report.fail(`personal key: DELETE answered ${removed.status}`);
    if ((await store.read(keyObject)) === null) report.ok('personal key: the S3 object is gone after DELETE');
    else report.fail('personal key: the S3 object is still there after DELETE');
    flushResponses();

    // ---- 3. Full run (SR12, SR15) ----------------------------------------
    phase = 'full-run';
    const started = await client(org.base, 'full run start', 'POST', `/debug-it/targets/job/${IDS.fullJob}/runs`, dana, {});
    const fullRunId: string | null = started.status === 201 && typeof started.json?.runId === 'string' ? started.json.runId : null;
    if (fullRunId) {
      labels.set(fullRunId, 'the full run');
      report.ok('full run: dana started the run (201)');
    } else {
      report.fail(`full run: start answered ${started.status}${typeof started.json?.error === 'string' ? `: ${started.json.error}` : ''}`);
    }
    if (fullRunId) {
      const deadline = Date.now() + FULL_RUN_WAIT_MS;
      let record: any = null;
      for (;;) {
        record = (await store.read(`runs/${fullRunId}.json`))?.value ?? null;
        if (record && (record.state === 'finished' || record.state === 'failed')) break;
        if (Date.now() > deadline) break;
        await sleep(10_000);
      }
      const minutes = Math.round(FULL_RUN_WAIT_MS / 60_000);
      if (record?.state === 'finished') report.ok('full run: the run ended finished');
      else if (record?.state === 'failed' && record.result && typeof record.result === 'object') {
        report.warn(`full run: the run ended failed with a result (${String(record.failureReason)})`);
      } else if (record?.state === 'failed') report.fail(`full run: the run ended failed without a result: ${String(record.failureReason)}`);
      else report.fail(`full run: the run did not end within ${minutes} minutes (state ${String(record?.state)})`);
      if (secretsCreated >= 1 && capturedKeys.length >= 1 && capturedKeys.every((key) => key === ORG_KEY)) {
        report.ok(`full run: the per-run Secret holds the fake organization key (${secretsCreated} Secrets)`);
      } else {
        report.fail(`full run: per-run Secrets ${secretsCreated}, organization key in them: ${capturedKeys.every((key) => key === ORG_KEY) ? 'yes' : 'no'}`);
      }
      await telemetry.flush();
      if (telemetryBodies >= 1 && telemetryKeyOk) report.ok(`full run: the telemetry sink got ${telemetryBodies} bodies with the telemetry key`);
      else if (record?.result) report.fail(`full run: the telemetry sink got ${telemetryBodies} bodies, key header ${telemetryKeyOk ? 'right' : 'wrong'}`);
      else report.warn('full run: no result, so no telemetry body is expected');
    }
    flushResponses();

    // ---- 4. Hostile result and Open a PR (SR12, SR15, SR16 input) ---------
    phase = 'hostile-result';
    const hostileRunId = randomUUID();
    labels.set(hostileRunId, 'the hostile run');
    const resultCode = b.results.newResultCode();
    known.add('result-code-#', resultCode);
    await seedRun(
      b,
      store,
      seededRecord({
        runId: hostileRunId,
        jobId: IDS.hostileJob,
        jobName: HOSTILE_JOB_NAME,
        repo,
        headSha: fullHead,
        branch: defaultBranch,
        usageKey: usageKeyOf(b, USERS.dana.uid),
        state: 'analyzing',
        result: null,
        resultCodeHash: b.results.hashResultCode(resultCode),
      }),
    );
    const hostile = {
      schemaVersion: 1,
      explanation: `Debug it leak and dashboard attack test (Story 7.4). ${HOSTILE_SCRIPT} ${HOSTILE_IMAGE} This pull request is closed by the test.`,
      causeLocation: { kind: 'this-repository' },
      patch: newFilePatch(name, `debug-it-attack/${hostileRunId}.txt`, `Debug it leak attack test ${hostileRunId}`),
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 10,
      durationMs: 1000,
      logTruncated: false,
      failureReason: 'none',
    };
    const posted = await client(
      `http://127.0.0.1:${Number(env.ATTACK_RESULTS_PORT ?? 3002)}`,
      'hostile result',
      'POST',
      `/results/${hostileRunId}`,
      {},
      hostile,
      { Authorization: `Bearer ${resultCode}` },
    );
    if (posted.status >= 200 && posted.status < 300) report.ok(`hostile result: POST /results/{runId} on the results port answered ${posted.status}`);
    else report.fail(`hostile result: POST /results/{runId} on the results port answered ${posted.status}`);
    let hostileRecord: any = null;
    for (let i = 0; i < 30; i += 1) {
      hostileRecord = (await store.read(`runs/${hostileRunId}.json`))?.value ?? null;
      if (hostileRecord?.state === 'finished' || hostileRecord?.state === 'failed') break;
      await sleep(1000);
    }
    if (hostileRecord?.state === 'finished') report.ok('hostile result: the run ended finished');
    else report.fail(`hostile result: the run is ${String(hostileRecord?.state)}, expected finished`);

    phase = 'open-a-pr';
    fixRunId = hostileRunId;
    const opened = await client(org.base, 'Open a PR', 'POST', `/debug-it/runs/${hostileRunId}/pull-requests/${repo}`, dana, {});
    if (opened.status === 201 && typeof opened.json?.url === 'string') {
      const match = /\/pull\/(\d+)$/.exec(opened.json.url);
      prNumber = match ? Number(match[1]) : null;
      report.ok(`Open a PR: POST /debug-it/runs/{runId}/pull-requests/${repo} answered 201`);
      const pr = prNumber === null ? null : await call(readToken, 'GET', `/repos/${repo}/pulls/${prNumber}`);
      if (pr?.status === 200 && pr.json?.draft === true) report.ok(`Open a PR: pull request #${prNumber} is a draft`);
      else report.fail(`Open a PR: pull request read back ${String(pr?.status)}, draft ${String(pr?.json?.draft)}`);
    } else {
      report.fail(`Open a PR: answered ${opened.status}${typeof opened.json?.error === 'string' ? `: ${opened.json.error}` : ''}`);
    }
    flushResponses();

    // ---- 5. The browser test (on the CI runner) ---------------------------
    phase = 'browser';
    report.line(`attack: browser-ready run=${hostileRunId} job=${IDS.hostileJob}`);
    const browserDone = join(work, 'browser-done');
    const until = Date.now() + BROWSER_WAIT_MS;
    while (!existsSync(browserDone) && Date.now() < until) await sleep(2000);
    if (existsSync(browserDone)) report.ok('browser: the browser test finished');
    else report.fail(`browser: the browser test did not finish within ${BROWSER_WAIT_MS / 60_000} minutes`);

    // ---- 6. GitHub writes and tokens across the job (SR6, SR10) ------------
    phase = 'checks';
    const fixBranch = `debug-it/${hostileRunId}/${name}`;
    const writes = requests.filter((r) => r.method !== 'GET');
    let extra = 0;
    for (const w of writes) {
      if (w.phase !== 'open-a-pr' || !isOpenAPrWrite(w, repo, fixBranch)) {
        extra += 1;
        report.fail(`GitHub writes: the adapter sent ${w.method} ${w.path} during ${w.phase}`);
      }
    }
    const pullPosts = writes.filter((w) => w.method === 'POST' && lower(w.path) === lower(`/repos/${repo}/pulls`)).length;
    if (pullPosts !== 1) {
      extra += 1;
      report.fail(`GitHub writes: the adapter sent ${pullPosts} POST /pulls, expected exactly 1`);
    }
    if (extra === 0) report.ok(`GitHub writes: ${writes.length} adapter writes across the job, all Open a PR's (blobs, tree, commit, debug-it/ ref, one draft pull request)`);
    if (tokenRequests.length === 0) report.fail('GitHub tokens: the adapter requested no installation token');
    let tokensOk = 0;
    let repositoryTokens = 0;
    let index = 0;
    for (const t of tokenRequests) {
      index += 1;
      const permissions = Object.entries((t.permissions ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(', ');
      const label = `GitHub tokens: #${index} (${t.phase}, ${permissions})`;
      const names = Array.isArray(t.repositoryNames) ? t.repositoryNames : [];
      if (names.length === 0 && Object.keys((t.permissions ?? {}) as object).join(',') === 'members') {
        // An organization members lookup token carries no repository permission.
        report.warn(`${label} names no repository (organization members lookup)`);
        continue;
      }
      repositoryTokens += 1;
      if (names.length !== 1 || typeof names[0] !== 'string' || lower(names[0]) !== lower(name)) {
        report.fail(`${label} names ${names.length} repositories, expected only ${repo}`);
        continue;
      }
      const covered = await coversOnly(call, t.token, repo);
      if (covered.ok) tokensOk += 1;
      else report.fail(`${label}: GET /installation/repositories answered ${covered.status} with ${covered.count} repositories`);
    }
    if (repositoryTokens === 0) report.fail('GitHub tokens: the adapter requested no repository token');
    else if (tokensOk === repositoryTokens) report.ok(`GitHub tokens: all ${tokensOk} adapter repository tokens cover only ${repo}`);

    // ---- 6b. Audit (SR15) -------------------------------------------------
    const keys: string[] = await store.list('runs/');
    const records: Array<{ key: string; value: any }> = [];
    for (const key of keys) {
      const value = (await store.read(key))?.value;
      if (value) records.push({ key, value });
    }
    auditRecords(records, { labels, fixRunId: prNumber === null ? null : fixRunId, expected: fullRunId ? 3 : 2 }, report);
  } catch (error) {
    report.fail(`${phase}: ${(error as Error)?.message ?? 'unknown error'}`);
  } finally {
    phase = 'cleanup';
    // ---- 7. Dump S3, write /work, clean up GitHub, delete the held Jobs ----
    try {
      const dumped = await dumpS3(s3Client, bucket, files.s3);
      if (dumped.unreadable === 0) report.ok(`S3 dump: ${dumped.objects} object versions written for the sweep`);
      else report.warn(`S3 dump: ${dumped.objects} object versions written, ${dumped.unreadable} could not be read`);
    } catch (error) {
      report.fail(`S3 dump: ${(error as Error)?.message ?? 'unknown error'}`);
    }
    flushResponses();
    if (fixRunId !== null) {
      await cleanupFixPullRequest({
        harnessToken,
        call,
        repo,
        runId: fixRunId,
        prNumber,
        log: (line) => report.line(line),
        warn: (line) => report.warn(line),
      });
    }
    lifecycle.stop();
    telemetry.stop();
    for (const jobName of heldDeletes) {
      try {
        await cluster.deleteJob({ name: jobName, namespace: env.DEBUG_IT_NAMESPACE?.trim() || DEBUG_NS, propagationPolicy: 'Background' });
      } catch (error) {
        // Seeded runs never had a Job: 404 is fine.
        const code = (error as { code?: unknown; statusCode?: unknown })?.code ?? (error as { statusCode?: unknown })?.statusCode;
        if (code !== 404) report.warn('cleanup: a held Debug Job could not be deleted');
      }
    }
    // After the cleanup, so its own installation token is swept too.
    writeFileSync(files.values, `${JSON.stringify(known.values, null, 1)}\n`);
    report.ok(`known values: ${known.values.length} written for the sweep`);
    for (const close of closers) await close().catch(() => undefined);
    if (resultsServer) await new Promise((done) => resultsServer.close(done));
    await new Promise((done) => sink.close(done));
    console.log = saved.log;
    console.error = saved.error;
    console.warn = saved.warn;
    console.info = saved.info;
  }
  report.line(report.fails() === 0 ? 'leak backend: all ok' : `leak backend: ${report.fails()} FAIL`);
  return report.fails();
}

type S3Send = { send(command: { name: string; input: Record<string, unknown> }): Promise<any> };

/** Every object version in the bucket (every key, not only debug-it/), one JSON line each. */
async function dumpS3(client: S3Send, bucket: string, file: string): Promise<{ objects: number; unreadable: number }> {
  let objects = 0;
  let unreadable = 0;
  const write = async (key: string, versionId?: string) => {
    let body: string | null = null;
    try {
      const answer = await client.send({
        name: 'GetObjectCommand',
        input: { Bucket: bucket, Key: key, ...(versionId && versionId !== 'null' ? { VersionId: versionId } : {}) },
      });
      body = await answer.Body.transformToString();
    } catch {
      unreadable += 1;
    }
    appendFileSync(file, `${JSON.stringify({ key, versionId: versionId ?? null, body })}\n`);
    objects += 1;
  };
  try {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const page = await client.send({
        name: 'ListObjectVersionsCommand',
        input: { Bucket: bucket, ...(keyMarker ? { KeyMarker: keyMarker, VersionIdMarker: versionMarker } : {}) },
      });
      for (const v of page.Versions ?? []) await write(v.Key, v.VersionId);
      if (!page.IsTruncated) break;
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }
  } catch {
    // No version listing: the current objects.
    let token: string | undefined;
    for (;;) {
      const page = await client.send({ name: 'ListObjectsV2Command', input: { Bucket: bucket, ...(token ? { ContinuationToken: token } : {}) } });
      for (const o of page.Contents ?? []) await write(o.Key);
      if (!page.IsTruncated) break;
      token = page.NextContinuationToken;
    }
  }
  if (objects === 0) throw new Error('the bucket holds no object');
  return { objects, unreadable };
}

/** dana's cookie and CSRF token for the browser test, from ATTACK_SESSION_KEY. */
export async function mintCookie(env: Record<string, string | undefined>): Promise<{ cookie: string; csrf: string }> {
  const b = await loadLeakBackend();
  const key = b.session.parseSessionKey(env.ATTACK_SESSION_KEY);
  if (!key) throw new Error('ATTACK_SESSION_KEY is not a 32 byte key');
  const session = b.session.createSessionService(key, { secure: false });
  const cookie = session.seal(USERS.dana);
  return { cookie, csrf: session.csrfToken(cookie) };
}

/** A SHA-256 of a value, for tests. */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

// CLI entry: npx tsx /attack/leak-backend.ts (ConfigMap files are symlinks, so
// compare the file name, not the URL).
if (process.argv[1] !== undefined && basename(process.argv[1]) === 'leak-backend.ts') {
  if (process.argv[2] === 'mint-cookie') {
    try {
      process.stdout.write(`${JSON.stringify(await mintCookie(process.env))}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`FAIL - mint-cookie: ${(error as Error).message}\n`);
      process.exit(1);
    }
  }
  const fails = await runLeakBackend({ env: process.env, log: (line) => process.stdout.write(`${line}\n`) });
  process.exit(fails === 0 ? 0 : 1);
}
