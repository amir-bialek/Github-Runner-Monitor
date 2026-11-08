// Story 7.3 (SR6, SR7, SR9, SR10): GitHub write attack tests against real
// GitHub, with the test Debug it GitHub App on two test repositories.
//
// The backend's own Debug it routes are mounted in-process (registerDebugIt,
// createRunService, createFixPullRequestService, an in-memory S3 store, the
// real session and CSRF) over the real createGitHubApp adapter, and the Open
// a PR route is driven over HTTP on 127.0.0.1. Every adapter token request
// and GitHub request is recorded. Then the test attacks with an App token
// narrowed the way Open a PR narrows it:
//
//   open-a-pr     the route answers 201; the adapter wrote only blobs, a tree,
//                 a commit, a debug-it/ ref and one draft pull request (SR6, SR10)
//   push          PATCH of the default ref and PUT contents on the default
//                 branch fail; the default head is unchanged (SR9)
//   merge         PUT pulls/{n}/merge and POST merges fail; head unchanged (SR9)
//   no ruleset    the repository without a ruleset gets 409, no write, no
//                 branch and no pull request (SR9)
//   patch rules   each patch rule is refused with 409 and no GitHub request (SR7)
//   tokens        every adapter installation token names one repository and
//                 one step's permissions, and GitHub lists only that
//                 repository for it (SR6)
//
// Test-only swaps, all here: checkPermission answers write for the invented
// user dana (user authorization is Story 7.4's SR13); GET
// /orgs/{owner}/installation goes to GET /repos/{ATTACK_TEST_REPO}/installation
// (the test repositories live on a user account); ATTACK_GITHUB_API (unit
// tests only) points https://api.github.com at a fake server. Every other
// adapter call and route step is production code.
//
// Cleanup (a finally block, its own one-repository token): close the fix pull
// request and delete its debug-it/ branch. A cleanup failure prints warn.
// Nothing is ever written to ATTACK_TEST_REPO_NO_RULESET.
//
//   cd code/backend && npm ci     (once: the backend runs under tsx)
//   ATTACK_TEST_GITHUB_APP_ID=... ATTACK_TEST_GITHUB_APP_PRIVATE_KEY=... \
//   ATTACK_TEST_REPO=owner/name ATTACK_TEST_REPO_NO_RULESET=owner/other \
//   node helm/tests/attack/github-write-attack.ts
//
// Output: ok/FAIL lines with statuses, paths and counts. Tokens, the private
// key and request bodies are never printed. Any FAIL exits 1.
//
// Story 7.4 (leak-backend.ts) reuses the exported pieces: the installation
// swap, harness calls and tokens, the Open a PR write list, the token
// coverage check and the cleanup.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GITHUB = 'https://api.github.com';
const USER = { uid: 1000001, login: 'dana' };
const SECRETS = [
  'ATTACK_TEST_GITHUB_APP_ID',
  'ATTACK_TEST_GITHUB_APP_PRIVATE_KEY',
  'ATTACK_TEST_REPO',
  'ATTACK_TEST_REPO_NO_RULESET',
] as const;
export const OWNER_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// The only permission sets an adapter token of Open a PR may carry.
export const STEP_PERMISSIONS = [{ metadata: 'read' }, { contents: 'write', pull_requests: 'write' }];
// Harness token permissions: reading the test repositories, and attacking or
// cleaning up with what Open a PR's write step gets.
export const READ = { contents: 'read', pull_requests: 'read', metadata: 'read' };
export const WRITE = { contents: 'write', pull_requests: 'write' };
// Only these answers count as GitHub refusing a push or merge; 401, 404 or 5xx prove nothing.
export const REFUSALS = new Set([403, 405, 409, 422]);
// More than the default patch limit (102400 bytes).
const TOO_LARGE_LINES = 9000;

const here = dirname(fileURLToPath(import.meta.url));
// Story 7.4 runs this file inside the backend image, where the backend is /app.
const backend = process.env.ATTACK_BACKEND_DIR ? resolve(process.env.ATTACK_BACKEND_DIR) : resolve(here, '../../../code/backend');

export type Log = (line: string) => void;
export type Auth = (options: Record<string, unknown>) => Promise<{ token: string } & Record<string, unknown>>;
export type GitHubCall = (
  token: string,
  method: string,
  path: string,
  body?: unknown,
  scheme?: string,
) => Promise<{ status: number; json: any }>;

export interface GitHubWriteAttackOptions {
  env: Record<string, string | undefined>;
  /** Where https://api.github.com goes; defaults to env.ATTACK_GITHUB_API, then GitHub. */
  apiBase?: string;
  /** The App's auth (createAppAuth shape); defaults to createAppAuth with the App ID and key. */
  auth?: Auth;
  log: Log;
}

export interface Recorded {
  phase: string;
  method: string;
  path: string;
  ref?: unknown;
  draft?: unknown;
}

export interface TokenRequest {
  phase: string;
  repositoryNames: unknown;
  permissions: unknown;
  token: string;
}

let backendModules: Promise<any> | undefined;

// The backend is written for tsx (extensionless imports, parameter
// properties), so load it through the backend's own tsx.
function loadBackend(): Promise<any> {
  backendModules ??= (async () => {
    const requireBackend = createRequire(resolve(backend, 'package.json'));
    let tsImport: (specifier: string, parent: string) => Promise<any>;
    try {
      ({ tsImport } = await import(pathToFileURL(requireBackend.resolve('tsx/esm/api')).href));
    } catch {
      throw new Error('tsx not found; run npm ci in code/backend first');
    }
    const load = (path: string) => tsImport(pathToFileURL(resolve(backend, path)).href, import.meta.url);
    return {
      express: requireBackend('express'),
      authApp: () => import(pathToFileURL(requireBackend.resolve('@octokit/auth-app')).href),
      ...(await load('src/routes/debugIt.ts')),
      ...(await load('src/services/debugItConfig.ts')),
      ...(await load('src/services/session.ts')),
      ...(await load('src/adapters/githubApp.ts')),
      ...(await load('src/services/debugIt/settings.ts')),
      ...(await load('src/adapters/s3Store.ts')),
      ...(await load('src/services/debugIt/runs.ts')),
      ...(await load('src/services/debugIt/fixPullRequest.ts')),
      ...(await load('src/services/debugIt/patchValidation.ts')),
    };
  })();
  return backendModules;
}

/** The FAIL line for the first missing or malformed secret, or null. */
export function checkSecrets(env: Record<string, string | undefined>): string | null {
  for (const name of SECRETS) {
    if (!env[name] || env[name]!.trim() === '') return `FAIL - ${name} is not set`;
  }
  for (const name of ['ATTACK_TEST_REPO', 'ATTACK_TEST_REPO_NO_RULESET'] as const) {
    if (!OWNER_NAME.test(env[name]!.trim())) return `FAIL - ${name} is not owner/name`;
  }
  const [owner] = env.ATTACK_TEST_REPO!.trim().split('/');
  const [other] = env.ATTACK_TEST_REPO_NO_RULESET!.trim().split('/');
  if (owner!.toLowerCase() !== other!.toLowerCase()) {
    return 'FAIL - ATTACK_TEST_REPO_NO_RULESET must have the same owner as ATTACK_TEST_REPO';
  }
  if (env.ATTACK_TEST_REPO!.trim().toLowerCase() === env.ATTACK_TEST_REPO_NO_RULESET!.trim().toLowerCase()) {
    return 'FAIL - ATTACK_TEST_REPO_NO_RULESET must be another repository than ATTACK_TEST_REPO';
  }
  return null;
}

const HUNK = '@@ -1 +1 @@\n-old\n+new\n';
const plain = (oldPath: string, newPath = oldPath.replace(/^a\//, 'b/')): string => `--- ${oldPath}\n+++ ${newPath}\n${HUNK}`;

/** A clean patch that adds one new file to the folder. */
export function newFilePatch(folder: string, path: string, text: string): string {
  return (
    `diff --git a/${folder}/${path} b/${folder}/${path}\n` +
    'new file mode 100644\n' +
    '--- /dev/null\n' +
    `+++ b/${folder}/${path}\n` +
    '@@ -0,0 +1 @@\n' +
    `+${text}\n`
  );
}

/** One patch per patch-validation rule, case and rename variants included: [label, rule, patch]. */
export function rulePatches(folder: string, otherFolder: string): Array<[string, string, string]> {
  const big =
    `--- /dev/null\n+++ b/${folder}/big.txt\n@@ -0,0 +1,${TOO_LARGE_LINES} @@\n` +
    Array.from({ length: TOO_LARGE_LINES }, (_, i) => `+line ${String(i).padStart(6, '0')} of a patch above the limit\n`).join('');
  return [
    ['too-large', 'too-large', big],
    ['unreadable', 'unreadable', 'GIT binary patch\n'],
    ['outside-downloads', 'outside-downloads', plain('a/elsewhere/x')],
    ['outside-repository', 'outside-repository', plain(`a/${folder}/x`, `b/${otherFolder}/x`)],
    ['git-internals', 'git-internals', plain(`a/${folder}/.git/hooks/pre-commit`)],
    ['git-internals in other case', 'git-internals', plain(`a/${folder}/sub/.GIT/hooks/x`)],
    ['workflow-file', 'workflow-file', plain(`a/${folder}/.github/workflows/ci.yml`)],
    ['workflow-file in other case', 'workflow-file', plain(`a/${folder}/.GitHub/WorkFlows/x.yml`)],
    [
      'rename into workflows',
      'workflow-file',
      `diff --git a/${folder}/a.yml b/${folder}/.github/workflows/a.yml\n` +
        'similarity index 100%\n' +
        `rename from ${folder}/a.yml\n` +
        `rename to ${folder}/.github/workflows/a.yml\n`,
    ],
    [
      'symbolic-link',
      'symbolic-link',
      `diff --git a/${folder}/link b/${folder}/link\nnew file mode 120000\nindex 0000000..1234567\n` +
        `--- /dev/null\n+++ b/${folder}/link\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n`,
    ],
    [
      'new file mode 100755',
      'file-mode',
      `diff --git a/${folder}/run.sh b/${folder}/run.sh\nnew file mode 100755\n--- /dev/null\n+++ b/${folder}/run.sh\n@@ -0,0 +1 @@\n+x\n`,
    ],
    ['mode change', 'file-mode', `diff --git a/${folder}/run.sh b/${folder}/run.sh\nold mode 100644\nnew mode 100755\n`],
  ];
}

export const sameJson = (a: unknown, b: unknown): boolean => {
  const sorted = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

/** Test-only swap: the test repositories live on a user account, so the organization installation lookup asks the repository. */
export function swapInstallationUrl(url: string, owner: string, repo: string): string {
  return url === `${GITHUB}/orgs/${encodeURIComponent(owner)}/installation` ? `${GITHUB}/repos/${repo}/installation` : url;
}

/** A harness call to GitHub (never through the adapter), 30 s timeout; the answer's JSON or null. */
export function createGitHubCall(apiBase: string): GitHubCall {
  return async (token, method, path, body, scheme = 'token') => {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `${scheme} ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-runner-monitor-attack-test',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}

/**
 * One-repository harness tokens of the test App, found through
 * GET /repos/{repo}/installation. `auth` should hide each token it returns.
 */
export function createHarnessTokens(
  auth: Auth,
  call: GitHubCall,
  repo: string,
): (repository: string, permissions: Record<string, string>) => Promise<string> {
  let installationId: number | undefined;
  return async (repository, permissions) => {
    if (installationId === undefined) {
      const { token: jwt } = await auth({ type: 'app' });
      const found = await call(jwt, 'GET', `/repos/${repo}/installation`, undefined, 'Bearer');
      if (found.status !== 200 || typeof found.json?.id !== 'number') {
        throw new Error(`the test App is not installed on ${repo} (GitHub answered ${found.status})`);
      }
      installationId = found.json.id;
    }
    const { token } = await auth({
      type: 'installation',
      installationId,
      repositoryNames: [repository.split('/')[1]],
      permissions,
    });
    return token;
  };
}

/**
 * Whether an adapter write is one of Open a PR's (SR10): blobs, a tree, a
 * commit, the fix branch ref and a draft pull request, all on `repo`.
 */
export function isOpenAPrWrite(w: Pick<Recorded, 'method' | 'path' | 'ref' | 'draft'>, repo: string, fixBranch: string): boolean {
  const prefix = `/repos/${repo}`.toLowerCase();
  const lower = w.path.toLowerCase();
  const rel = lower.startsWith(`${prefix}/`) ? w.path.slice(prefix.length) : null;
  return (
    rel !== null &&
    ((w.method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits'].includes(rel)) ||
      (w.method === 'POST' && rel === '/git/refs' && w.ref === `refs/heads/${fixBranch}`) ||
      (w.method === 'PATCH' && rel === `/git/refs/heads/${fixBranch}`) ||
      (w.method === 'POST' && rel === '/pulls' && w.draft === true))
  );
}

/** What GitHub's GET /installation/repositories lists for the token: ok when exactly `full`. */
export async function coversOnly(
  call: GitHubCall,
  token: string,
  full: string,
): Promise<{ ok: boolean; status: number; count: string }> {
  const listed = await call(token, 'GET', '/installation/repositories?per_page=100');
  const repos: unknown[] = Array.isArray(listed.json?.repositories) ? listed.json.repositories : [];
  const fullNames = repos.map((r: any) => String(r?.full_name ?? '').toLowerCase());
  return {
    ok: listed.status === 200 && listed.json?.total_count === 1 && fullNames.length === 1 && fullNames[0] === full.toLowerCase(),
    status: listed.status,
    count: String(listed.json?.total_count ?? fullNames.length),
  };
}

/**
 * Cleanup, test harness work apart from the App's writes: closes the fix pull
 * request and deletes its debug-it/{runId}/{name} branch with its own
 * one-repository token. A failure is a warn line, never a FAIL.
 */
export async function cleanupFixPullRequest(options: {
  harnessToken: (repository: string, permissions: Record<string, string>) => Promise<string>;
  call: GitHubCall;
  repo: string;
  runId: string;
  prNumber: number | null;
  log: Log;
  warn: Log;
}): Promise<void> {
  const { harnessToken, call, repo, runId, prNumber, log, warn } = options;
  const name = repo.split('/')[1]!;
  const branch = `debug-it/${runId}/${name}`;
  try {
    const token = await harnessToken(repo, WRITE);
    if (prNumber !== null) {
      const closed = await call(token, 'PATCH', `/repos/${repo}/pulls/${prNumber}`, { state: 'closed' });
      if (closed.status === 200) log(`cleanup - closed pull request #${prNumber}`);
      else warn(`cleanup: closing pull request #${prNumber} answered ${closed.status}`);
    }
    const deleted = await call(token, 'DELETE', `/repos/${repo}/git/refs/heads/${branch}`);
    if (deleted.status === 204) log('cleanup - deleted branch debug-it/{runId}/' + name);
    else if (prNumber !== null || deleted.status !== 422) warn(`cleanup: deleting branch debug-it/{runId}/${name} answered ${deleted.status}`);
  } catch (error) {
    warn(`cleanup: ${(error as Error)?.message ?? 'unknown error'}`);
  }
}

export async function runGitHubWriteAttack(options: GitHubWriteAttackOptions): Promise<number> {
  const { env } = options;
  // Every value that must never be printed; every line goes through redact.
  const hidden = new Set<string>();
  const redact = (text: string): string => {
    let out = text;
    for (const value of hidden) if (value.length >= 4) out = out.split(value).join('***');
    return out;
  };
  const log: Log = (line) => options.log(redact(line));

  const missing = checkSecrets(env);
  if (missing) {
    log(missing);
    return 1;
  }
  const privateKey = env.ATTACK_TEST_GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n');
  hidden.add(env.ATTACK_TEST_GITHUB_APP_PRIVATE_KEY!);
  hidden.add(privateKey);
  for (const line of privateKey.split('\n')) if (line.length >= 16 && !line.startsWith('-----')) hidden.add(line);

  let fails = 0;
  const ok = (text: string): void => log(`ok   - ${text}`);
  const fail = (text: string): void => {
    fails += 1;
    log(`FAIL - ${text}`);
  };
  const warn = (text: string): void => log(`warn - ${text}`);

  const repo = env.ATTACK_TEST_REPO!.trim();
  const noRuleset = env.ATTACK_TEST_REPO_NO_RULESET!.trim();
  const [owner, name] = repo.split('/') as [string, string];
  const otherName = noRuleset.split('/')[1]!;
  const apiBase = (options.apiBase ?? env.ATTACK_GITHUB_API ?? GITHUB).replace(/\/+$/, '');

  let b: any;
  try {
    b = await loadBackend();
  } catch (error) {
    fail(`setup: ${(error as Error).message}`);
    return fails;
  }

  let baseAuth: Auth;
  if (options.auth) baseAuth = options.auth;
  else {
    const { createAppAuth } = await b.authApp();
    baseAuth = createAppAuth({ appId: env.ATTACK_TEST_GITHUB_APP_ID!.trim(), privateKey }) as Auth;
  }
  // Every token, harness or adapter, is hidden from the output.
  const authHidden: Auth = async (authOptions) => {
    const answer = await baseAuth(authOptions);
    if (typeof answer?.token === 'string') hidden.add(answer.token);
    return answer;
  };

  // ---- Recording around the adapter -------------------------------------
  let phase = 'setup';
  const requests: Recorded[] = [];
  const tokenRequests: TokenRequest[] = [];
  const appAuthRequests: string[] = [];
  const recordingAuth: Auth = async (authOptions) => {
    const answer = await authHidden(authOptions);
    if (authOptions.type === 'installation') {
      tokenRequests.push({
        phase,
        repositoryNames: authOptions.repositoryNames,
        permissions: authOptions.permissions,
        token: answer.token,
      });
    } else {
      appAuthRequests.push(String(authOptions.type));
    }
    return answer;
  };
  const recordingFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    // Test-only swap: the test repositories live on a user account.
    const target = swapInstallationUrl(url, owner, repo);
    const parsed = new URL(target);
    let body: any;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    requests.push({ phase, method, path: decodeURIComponent(parsed.pathname), ref: body?.ref, draft: body?.draft });
    const real = parsed.origin === GITHUB ? `${apiBase}${parsed.pathname}${parsed.search}` : target;
    return fetch(real, init);
  };

  // ---- Harness calls (never through the adapter) -------------------------
  const call = createGitHubCall(apiBase);
  const refusal = (what: string, status: number): void => {
    if (REFUSALS.has(status)) ok(`${what} answered ${status}`);
    else fail(`${what} answered ${status}, expected a refusal (403, 405, 409 or 422)`);
  };
  const harnessToken = createHarnessTokens(authHidden, call, repo);
  const defaultHeadOf = async (token: string, repository: string, branch: string): Promise<string | null> => {
    const answer = await call(token, 'GET', `/repos/${repository}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    return answer.status === 200 && typeof answer.json?.object?.sha === 'string' ? answer.json.object.sha : null;
  };

  // ---- The backend's own routes, in-process ------------------------------
  const store = b.createS3Store({ bucket: 'debug-it-attack-test', client: b.createMemoryS3Client() });
  const adapter = b.createGitHubApp({
    appId: env.ATTACK_TEST_GITHUB_APP_ID!.trim(),
    privateKey,
    clientId: '',
    clientSecret: '',
    organization: owner,
    auth: recordingAuth,
    fetch: recordingFetch,
  });
  // Test-only swap: user authorization is Story 7.4's SR13.
  const githubApp = { ...adapter, checkPermission: async () => 'write' };
  const settings = b.createSettingsService({
    store,
    config: { administrators: [String(USER.uid)], allowedRepositories: [repo, noRuleset], allowedUsers: [String(USER.uid)] },
  });
  const isolation = { status: () => ({ state: 'on', reason: null, checkedAt: new Date().toISOString() }) };
  const runs = b.createRunService({ store, githubApp, config: b.DEBUG_IT_DEFAULTS, isolation, organization: owner, settings });
  const fixPullRequests = b.createFixPullRequestService({ store, githubApp, config: b.DEBUG_IT_DEFAULTS });
  const session = b.createSessionService(randomBytes(32), { secure: false });
  const app = b.express();
  app.use(b.express.json());

  // The backend's own log lines: [AUDIT] dropped, the rest shown, redacted.
  // (options.log must not write through console.log, which is swapped here.)
  const savedLog = console.log;
  const savedError = console.error;
  const savedWarn = console.warn;
  const savedInfo = console.info;
  const backendLine = (...args: unknown[]): void => {
    const line = args.map(String).join(' ');
    if (!line.startsWith('[AUDIT]')) options.log(redact(`       backend: ${line}`));
  };
  console.log = backendLine;
  console.error = backendLine;
  console.warn = backendLine;
  console.info = backendLine;

  let server: any;
  let prNumber: number | null = null;
  let fixRunId: string | null = null;
  try {
    b.registerDebugIt(
      app,
      { ...b.DEBUG_IT_DEFAULTS, enabled: true, publicUrl: 'https://monitor.acme.example', githubAppClientId: 'Iv1.attack' },
      { session, githubApp, env: {}, settings, isolation, runs, fixPullRequests },
    );
    server = await new Promise((done) => {
      const s = app.listen(0, '127.0.0.1', () => done(s));
    });
    const port = (server.address() as AddressInfo).port;
    const cookie = session.seal(USER);
    const csrf = session.csrfToken(cookie);
    const post = async (runId: string, repository: string): Promise<{ status: number; json: any }> => {
      const res = await fetch(`http://127.0.0.1:${port}/debug-it/runs/${runId}/pull-requests/${repository}`, {
        method: 'POST',
        headers: { Cookie: `dbg_session=${cookie}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json };
    };

    const putRecord = async (
      runId: string,
      repository: string,
      headSha: string,
      branch: string,
      patch: string,
      downloads: Array<{ repository: string; commitSha: string; folder: string }>,
    ): Promise<void> => {
      const usageKey = `usage/2026-11/${USER.uid}.json`;
      await store.create(`runs/${runId}.json`, {
        runId,
        target: { kind: 'job', id: 900001 },
        requester: { githubUserId: USER.uid, login: USER.login },
        state: 'finished',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        repository,
        headRepository: repository,
        headSha,
        branch,
        jobName: 'attack test',
        downloads,
        usageKey,
        resultCodeHash: 'f'.repeat(64),
        result: {
          schemaVersion: 1,
          explanation: 'Debug it GitHub write attack test (Story 7.3). This pull request is closed by the test.',
          causeLocation: { kind: 'this-repository' },
          patch,
          costUsd: 0,
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1000,
          logTruncated: false,
          failureReason: 'none',
        },
        feedback: null,
        fixPullRequests: [],
        failureReason: null,
      });
      await store.modify(usageKey, (current: any) => ({
        entries: [...(current?.entries ?? []), { runId, costUsd: 0, fixPullRequests: 0 }],
      }));
    };

    // ---- Setup: the default branch and its head on both repositories -----
    const readToken = await harnessToken(repo, READ);
    const repoInfo = await call(readToken, 'GET', `/repos/${repo}`);
    const defaultBranch: string | null = typeof repoInfo.json?.default_branch === 'string' ? repoInfo.json.default_branch : null;
    if (!defaultBranch) throw new Error(`${repo} has no default branch (GitHub answered ${repoInfo.status})`);
    const defaultHead = await defaultHeadOf(readToken, repo, defaultBranch);
    if (!defaultHead) throw new Error(`${repo} default branch ${defaultBranch} has no head`);
    const otherReadToken = await harnessToken(noRuleset, READ);
    const otherInfo = await call(otherReadToken, 'GET', `/repos/${noRuleset}`);
    const otherBranch: string | null = typeof otherInfo.json?.default_branch === 'string' ? otherInfo.json.default_branch : null;
    if (!otherBranch) throw new Error(`${noRuleset} has no default branch (GitHub answered ${otherInfo.status})`);
    const otherHead = await defaultHeadOf(otherReadToken, noRuleset, otherBranch);
    if (!otherHead) throw new Error(`${noRuleset} default branch ${otherBranch} has no head`);
    const unchanged = async (what: string): Promise<void> => {
      const now = await defaultHeadOf(readToken, repo, defaultBranch);
      if (now === null) fail(`${what}: could not read the head of ${repo} ${defaultBranch}`);
      else if (now === defaultHead) ok(`${what}: ${repo} ${defaultBranch} head unchanged`);
      else fail(`${what}: ${repo} ${defaultBranch} head moved`);
    };

    // ---- open-a-pr (SR6, SR10) -----------------------------------------
    phase = 'open-a-pr';
    const runId = randomUUID();
    fixRunId = runId;
    const fixBranch = `debug-it/${runId}/${name}`;
    await putRecord(runId, repo, defaultHead, defaultBranch, newFilePatch(name, `debug-it-attack/${runId}.txt`, `Debug it attack test ${runId}`), [
      { repository: repo, commitSha: defaultHead, folder: name },
    ]);
    const opened = await post(runId, repo);
    let fixSha: string | null = null;
    let nodeId: string | null = null;
    if (opened.status === 201 && typeof opened.json?.url === 'string') {
      ok(`open-a-pr: POST /debug-it/runs/{runId}/pull-requests/${repo} answered 201`);
      const match = /\/pull\/(\d+)$/.exec(opened.json.url);
      prNumber = match ? Number(match[1]) : null;
    } else {
      fail(`open-a-pr: POST /debug-it/runs/{runId}/pull-requests/${repo} answered ${opened.status}, expected 201`);
    }
    const prefix = `/repos/${repo}`.toLowerCase();
    const writes = requests.filter((r) => r.phase === 'open-a-pr' && r.method !== 'GET');
    let extra = 0;
    for (const w of writes) {
      if (!isOpenAPrWrite(w, repo, fixBranch)) {
        extra += 1;
        fail(`open-a-pr: the adapter sent ${w.method} ${w.path}${w.path.endsWith('/pulls') ? ` (draft ${String(w.draft)})` : ''}`);
      }
    }
    const kinds = (method: string, rel: string): number =>
      writes.filter((w) => w.method === method && w.path.toLowerCase() === `${prefix}${rel}`.toLowerCase()).length;
    const pullPosts = kinds('POST', '/pulls');
    if (pullPosts !== 1) {
      extra += 1;
      fail(`open-a-pr: the adapter sent ${pullPosts} POST /pulls, expected exactly 1`);
    }
    if (extra === 0 && writes.length > 0) {
      ok(
        `open-a-pr: adapter writes only blobs ${kinds('POST', '/git/blobs')}, trees ${kinds('POST', '/git/trees')}, ` +
          `commits ${kinds('POST', '/git/commits')}, refs ${kinds('POST', '/git/refs') + kinds('PATCH', `/git/refs/heads/${fixBranch}`)} ` +
          `under debug-it/, draft pull requests ${kinds('POST', '/pulls')} (${writes.length} writes)`,
      );
    } else if (writes.length === 0) {
      fail('open-a-pr: the adapter sent no write');
    }
    if (prNumber !== null) {
      const pr = await call(readToken, 'GET', `/repos/${repo}/pulls/${prNumber}`);
      const draft = pr.json?.draft === true;
      const head = pr.json?.head?.ref;
      const base = pr.json?.base?.ref;
      fixSha = typeof pr.json?.head?.sha === 'string' ? pr.json.head.sha : null;
      nodeId = typeof pr.json?.node_id === 'string' ? pr.json.node_id : null;
      if (pr.status === 200 && draft) ok(`open-a-pr: pull request #${prNumber} is a draft`);
      else fail(`open-a-pr: pull request #${prNumber} read back ${pr.status}, draft ${String(pr.json?.draft)}`);
      if (head === fixBranch) ok(`open-a-pr: head is debug-it/{runId}/${name}`);
      else fail(`open-a-pr: head is ${String(head)}, expected debug-it/{runId}/${name}`);
      if (base === defaultBranch) ok(`open-a-pr: base is the default branch ${defaultBranch}`);
      else fail(`open-a-pr: base is ${String(base)}, expected ${defaultBranch}`);
    } else if (opened.status === 201) {
      fail('open-a-pr: the answered URL names no pull request number');
    }

    // ---- push and merge (SR9), with a token narrowed like Open a PR -----
    phase = 'attack';
    const attackToken = await harnessToken(repo, WRITE);
    if (fixSha === null) {
      fail('push: no fix commit to push, open-a-pr did not open a pull request');
    } else {
      const patched = await call(attackToken, 'PATCH', `/repos/${repo}/git/refs/heads/${defaultBranch}`, { sha: fixSha, force: false });
      refusal(`push: PATCH git/refs/heads/${defaultBranch} to the fix commit`, patched.status);
    }
    const putPath = `debug-it-attack/${runId}-push.txt`;
    const put = await call(attackToken, 'PUT', `/repos/${repo}/contents/${putPath}`, {
      message: 'Debug it attack test: direct push',
      content: Buffer.from(`Debug it attack test ${runId}\n`, 'utf8').toString('base64'),
      branch: defaultBranch,
    });
    refusal(`push: PUT contents/debug-it-attack/{runId}-push.txt on ${defaultBranch}`, put.status);
    await unchanged('push');

    if (prNumber === null) {
      fail('merge: no fix pull request to merge, open-a-pr did not open one');
    } else {
      // Ready for review first, so the merge is refused by the ruleset, not for being a draft.
      const ready = await call(attackToken, 'POST', '/graphql', {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
        variables: { id: nodeId },
      });
      const isDraft = ready.json?.data?.markPullRequestReadyForReview?.pullRequest?.isDraft;
      if (nodeId === null || ready.status !== 200 || ready.json?.errors || isDraft !== false) {
        fail(`merge: marking pull request #${prNumber} ready for review answered ${ready.status}${ready.json?.errors ? ' with errors' : ''}`);
      } else {
        ok(`merge: pull request #${prNumber} marked ready for review`);
        const merged = await call(attackToken, 'PUT', `/repos/${repo}/pulls/${prNumber}/merge`, {});
        refusal(`merge: PUT pulls/${prNumber}/merge`, merged.status);
      }
    }
    if (fixSha === null) {
      fail('merge: no fix branch to merge, open-a-pr did not open a pull request');
    } else {
      const merges = await call(attackToken, 'POST', `/repos/${repo}/merges`, {
        base: defaultBranch,
        head: fixBranch,
        commit_message: 'Debug it attack test: direct merge',
      });
      refusal(`merge: POST merges (base ${defaultBranch}, head the fix branch)`, merges.status);
    }
    await unchanged('merge');

    // ---- no ruleset (SR9) ------------------------------------------------
    phase = 'no-ruleset';
    const otherRunId = randomUUID();
    await putRecord(otherRunId, noRuleset, otherHead, otherBranch, newFilePatch(otherName, `debug-it-attack/${otherRunId}.txt`, 'x'), [
      { repository: noRuleset, commitSha: otherHead, folder: otherName },
    ]);
    const refused = await post(otherRunId, noRuleset);
    if (refused.status === 409 && refused.json?.error === b.FIX_PR_ERRORS.ruleset) {
      ok(`no ruleset: POST for ${noRuleset} answered 409 with the ruleset sentence`);
    } else {
      fail(`no ruleset: POST for ${noRuleset} answered ${refused.status}${refused.json?.error === b.FIX_PR_ERRORS.ruleset ? '' : ' without the ruleset sentence'}`);
    }
    const otherWrites = requests.filter((r) => r.phase === 'no-ruleset' && r.method !== 'GET');
    if (otherWrites.length === 0) ok(`no ruleset: no adapter write to ${noRuleset}`);
    else for (const w of otherWrites) fail(`no ruleset: the adapter sent ${w.method} ${w.path}`);
    const otherBranchName = `debug-it/${otherRunId}/${otherName}`;
    const refs = await call(otherReadToken, 'GET', `/repos/${noRuleset}/git/matching-refs/heads/debug-it/${otherRunId}`);
    if (refs.status === 200 && Array.isArray(refs.json) && refs.json.length === 0) ok(`no ruleset: no debug-it/{runId} branch on ${noRuleset}`);
    else fail(`no ruleset: branch lookup on ${noRuleset} answered ${refs.status} with ${Array.isArray(refs.json) ? refs.json.length : 'no'} refs`);
    const pulls = await call(
      otherReadToken,
      'GET',
      `/repos/${noRuleset}/pulls?state=open&head=${encodeURIComponent(`${owner}:${otherBranchName}`)}`,
    );
    if (pulls.status === 200 && Array.isArray(pulls.json) && pulls.json.length === 0) ok(`no ruleset: no open pull request from it on ${noRuleset}`);
    else fail(`no ruleset: pull request lookup on ${noRuleset} answered ${pulls.status} with ${Array.isArray(pulls.json) ? pulls.json.length : 'no'} pull requests`);

    // ---- patch rules (SR7), sent straight to the API ---------------------
    const downloads = [
      { repository: repo, commitSha: defaultHead, folder: name },
      { repository: noRuleset, commitSha: otherHead, folder: otherName },
    ];
    for (const [label, rule, patch] of rulePatches(name, otherName)) {
      phase = `rule:${label}`;
      // The fixture must hit its rule, or a 409 would prove nothing.
      const checked = b.validatePatch(patch, downloads, b.DEBUG_IT_DEFAULTS.limits.patchLimitBytes);
      if (checked.rule !== rule) {
        fail(`patch rule ${label}: the fixture hits ${String(checked.rule)}, not ${rule}`);
        continue;
      }
      const ruleRunId = randomUUID();
      await putRecord(ruleRunId, repo, defaultHead, defaultBranch, patch, downloads);
      const answer = await post(ruleRunId, repo);
      const seen = requests.filter((r) => r.phase === phase).length + tokenRequests.filter((t) => t.phase === phase).length;
      // The service answers the refused part's message, or noPatch when the repository has no part.
      const part = checked.repositories.find((r: any) => r.repository.toLowerCase() === repo.toLowerCase());
      const expected = part && part.sections.length > 0 ? (part.message ?? b.FIX_PR_ERRORS.noPatch) : b.FIX_PR_ERRORS.noPatch;
      const sentence = answer.json?.error === expected;
      if (answer.status === 409 && sentence && seen === 0) ok(`patch rule ${label}: 409 with the rule's sentence, 0 GitHub requests`);
      else fail(`patch rule ${label}: answered ${answer.status}${sentence ? '' : ' without the expected sentence'} with ${seen} GitHub requests`);
    }

    // ---- tokens (SR6) ----------------------------------------------------
    phase = 'tokens';
    const names = new Map([
      [name.toLowerCase(), repo],
      [otherName.toLowerCase(), noRuleset],
    ]);
    if (tokenRequests.length === 0) fail('tokens: the adapter requested no installation token');
    let index = 0;
    for (const t of tokenRequests) {
      index += 1;
      const one = Array.isArray(t.repositoryNames) && t.repositoryNames.length === 1 && typeof t.repositoryNames[0] === 'string';
      const full = one ? names.get((t.repositoryNames as string[])[0]!.toLowerCase()) : undefined;
      const permissionsOk = STEP_PERMISSIONS.some((p) => sameJson(p, t.permissions));
      const label = `tokens: #${index} (${t.phase}, ${Object.entries((t.permissions ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(', ')})`;
      if (!one || full === undefined) {
        fail(`${label} names ${Array.isArray(t.repositoryNames) ? t.repositoryNames.length : 'no'} test repositories`);
        continue;
      }
      if (!permissionsOk) {
        fail(`${label} has permissions outside the Open a PR steps`);
        continue;
      }
      const covered = await coversOnly(call, t.token, full);
      if (covered.ok) {
        ok(`${label} covers only ${full}`);
      } else {
        fail(`${label}: GET /installation/repositories answered ${covered.status} with ${covered.count} repositories`);
      }
    }
  } catch (error) {
    fail(`${phase}: ${(error as Error)?.message ?? 'unknown error'}`);
  } finally {
    // ---- cleanup: test harness work, apart from the App's writes --------
    phase = 'cleanup';
    if (fixRunId !== null) {
      await cleanupFixPullRequest({ harnessToken, call, repo, runId: fixRunId, prNumber, log, warn });
    }
    console.log = savedLog;
    console.error = savedError;
    console.warn = savedWarn;
    console.info = savedInfo;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    }
  }
  log(fails === 0 ? 'github write attack tests: all ok' : `github write attack tests: ${fails} FAIL`);
  return fails;
}

// CLI entry: node helm/tests/attack/github-write-attack.ts
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fails = await runGitHubWriteAttack({ env: process.env, log: (line) => process.stdout.write(`${line}\n`) });
  process.exit(fails === 0 ? 0 : 1);
}
