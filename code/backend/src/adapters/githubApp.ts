// The Debug it GitHub App adapter (AD-1). Every call Debug it makes to GitHub
// lives here. Each function requests its own token narrowed to that step and
// no function returns a token (SR6, SR12): callers only see plain results.
import { Readable } from 'stream';
import { gzipSync } from 'zlib';
import { LRUCache } from 'lru-cache';

const GITHUB_API = 'https://api.github.com';

// Permissions the Debug it GitHub App must never hold (SR8).
const FORBIDDEN_PERMISSIONS = ['workflows', 'administration', 'organization_administration'];

export class GitHubAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

/** The subset of the `createAppAuth` result this adapter uses. */
export type AppAuth = (options: Record<string, unknown>) => Promise<{ token: string } & Record<string, unknown>>;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  organization: string;
  auth?: AppAuth;
  fetch?: FetchLike;
  /** Clock for the permission cache, in milliseconds; defaults to Date.now. */
  now?: () => number;
}

/** A user's access to one repository, as Debug it needs it. */
export type RepositoryPermission = 'write' | 'read' | 'none';

export const PERMISSION_CACHE_TTL_MS = 5 * 60 * 1000;
export const PERMISSION_CACHE_MAX = 5000;

export interface GitHubUser {
  githubUserId: number;
  login: string;
}

export interface InstallationCheck {
  installationId: number;
  permissions: Record<string, string>;
  forbidden: string[];
}

/** Where Debug it looks for the opt-in file, on the default branch (FR26). */
export const CONTEXT_FILE_PATH = '.github/claude-debug-context.md';
/** The largest debug context file Debug it reads, in bytes (64 KiB). */
export const CONTEXT_FILE_MAX_BYTES = 65536;
// A valid repository name; `.` and `..` would rewrite the API path.
const REPOSITORY_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** What GitHub holds at CONTEXT_FILE_PATH on a repository's default branch. */
export type ContextFileAnswer = { status: 'found'; text: string } | { status: 'missing' } | { status: 'too-large' };

/** What Debug it reads from a workflow run (AD-13). */
export interface WorkflowRunInfo {
  id: number;
  /** owner/name of the repository the run's commit comes from (a fork for a fork pull request). */
  headRepository: string | null;
  headSha: string | null;
  headBranch: string | null;
  /** The run's workflow file path, as GitHub names it (for example .github/workflows/ci.yml). */
  path: string | null;
  /** Only with `workflowFile: true`: the workflow file at the run's commit, or null when it cannot be read. */
  workflowFile?: WorkflowFile | null;
  /** Only with `workflowFile: true`: GitHub's error message for the run; GitHub offers none today (null). */
  errorMessage?: string | null;
}

/** A workflow file read at a run's commit. */
export interface WorkflowFile {
  path: string;
  text: string;
}

/** The tail of a job log (FR43). */
export interface JobLog {
  text: Buffer;
  /** Whether the start of the log was cut away. */
  truncated: boolean;
}

/** A repository tarball being downloaded: its resolved commit and the gzip body, as a stream. */
export interface Tarball {
  commitSha: string;
  body: Readable;
}

/** The largest workflow file Debug it reads, in bytes (1 MiB). */
export const WORKFLOW_FILE_MAX_BYTES = 1024 * 1024;
/** How long a log or tarball body may take to arrive, in milliseconds (10 minutes). */
export const BODY_TIMEOUT_MS = 10 * 60 * 1000;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._/-]+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
// A branch or tag name Debug it is willing to put in an API path.
const REF_NAME = /^[A-Za-z0-9._/-]{1,255}$/;

/** Whether a repository's default branch is protected the way Debug it needs (story 4.2). */
export interface RulesetCheck {
  protected: boolean;
}

/** One validated file section of a fix, paths inside the repository (null for /dev/null). */
export interface FixPullRequestSection {
  oldPath: string | null;
  newPath: string | null;
  text: string;
  /** A git copy: the source path stays. */
  copy?: boolean;
}

/** What openFixPullRequest needs; every value comes from the run record and the validated patch. */
export interface FixPullRequestInput {
  /** owner/name, in the organization. */
  repository: string;
  /** The commit the files are read at and the fix commit's parent (40 hex). */
  commitSha: string;
  /** The pull request base; null is the default branch. */
  base: string | null;
  /** The branch to create, under debug-it/. */
  branch: string;
  title: string;
  body: string;
  sections: FixPullRequestSection[];
  /** The pure applier: the new text, or null to delete the file. Throws when the section does not apply. */
  apply: (original: string | null, sectionText: string) => string | null;
}

export type FixPullRequestOutcome =
  | { status: 'opened'; url: string; number: number; existing: boolean }
  | { status: 'refused'; reason: 'not-a-file' | 'does-not-apply' };

/** The largest original file a fix reads, in bytes (1 MiB). */
export const FIX_FILE_MAX_BYTES = 1024 * 1024;
/** Every branch Debug it writes starts with this. */
export const FIX_BRANCH_PREFIX = 'debug-it/';

export interface GitHubApp {
  /** Exchanges an OAuth code for the user's ID and login. The user token is dropped. */
  exchangeCode(code: string, redirectUrl: string): Promise<GitHubUser>;
  /** Whether `login` is a member of the organization. */
  checkMembership(login: string): Promise<boolean>;
  /** The installation's ID, granted permissions and any forbidden ones (SR8). */
  checkInstallation(): Promise<InstallationCheck>;
  /**
   * The user's access to `repository` (owner/name). Cached 5 minutes per user
   * ID and repository; `fresh` skips and refreshes the cache. Errors are never
   * cached and surface as GitHubAppError.
   */
  checkPermission(user: GitHubUser, repository: string, options?: { fresh?: boolean }): Promise<RepositoryPermission>;
  /** The user with this login, or null when GitHub knows none. Errors surface as GitHubAppError. */
  findUser(login: string): Promise<GitHubUser | null>;
  /**
   * The current login of this user ID, or null when GitHub knows none.
   * Cached 5 minutes per ID; errors are never cached and surface as GitHubAppError.
   */
  userLogin(githubUserId: number): Promise<string | null>;
  /**
   * The debug context file of `repository` (owner/name, in the organization)
   * on its default branch, with a token narrowed to contents read on that one
   * repository. A repository in another form or organization throws a
   * GitHubAppError before any token is requested.
   */
  readContextFile(repository: string): Promise<ContextFileAnswer>;
  /**
   * The workflow run `runId` of `repository` (owner/name, in the
   * organization), with a token narrowed to actions read on that one
   * repository. A repository in another form or organization throws a
   * GitHubAppError before any token is requested; an unknown run (404)
   * throws a GitHubAppError too.
   */
  readWorkflowRun(repository: string, runId: number, options?: { workflowFile?: boolean }): Promise<WorkflowRunInfo>;
  /**
   * The last `maxBytes` of job `jobId`'s log in `repository` (owner/name, in
   * the organization), with a token narrowed to actions read on that one
   * repository. A cut log starts at a line. The log host's redirect is
   * followed without the token. Unknown or expired logs throw a GitHubAppError.
   */
  readLog(repository: string, jobId: number, maxBytes: number): Promise<JobLog>;
  /**
   * Resolves `ref` (null: the default branch) of `repository` to a commit and
   * starts its tarball download, with a token narrowed to contents and
   * metadata read on that one repository. The tarball is fetched from the
   * redirect target without the token and returned as a stream, never buffered.
   */
  downloadTarball(repository: string, ref: string | null): Promise<Tarball>;
  /**
   * Whether the default branch of `repository` is covered by an active
   * ruleset that blocks updates or requires an approving review and that
   * the App can never bypass, with a token narrowed to metadata read on that
   * one repository. Classic branch protection does not count.
   */
  checkRuleset(repository: string): Promise<RulesetCheck>;
  /**
   * Opens a draft fix pull request (the only GitHub write of Debug it), with
   * one token narrowed to contents and pull requests write on that one
   * repository. It reads the original files at `commitSha`, applies the
   * sections in memory, writes blobs, one tree, one commit and a ref under
   * debug-it/, then one draft pull request. An existing branch with an open
   * pull request answers that pull request; one without is force-moved.
   */
  openFixPullRequest(input: FixPullRequestInput): Promise<FixPullRequestOutcome>;
}

const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);
const READ_ROLES = new Set(['triage', 'read']);

/** Maps a collaborator permission answer to what Debug it needs. */
export function permissionFromAnswer(body: { role_name?: unknown; permission?: unknown }): RepositoryPermission {
  const role = typeof body.role_name === 'string' ? body.role_name.toLowerCase() : '';
  if (WRITE_ROLES.has(role)) return 'write';
  if (READ_ROLES.has(role)) return 'read';
  const permission = typeof body.permission === 'string' ? body.permission.toLowerCase() : '';
  if (permission === 'admin' || permission === 'write') return 'write';
  if (permission === 'read') return 'read';
  return 'none';
}

// Loads the SDK only when first used, so tests and mock mode never need it.
function lazyAppAuth(options: GitHubAppOptions): AppAuth {
  let loaded: Promise<AppAuth> | undefined;
  return async (authOptions) => {
    if (!loaded) {
      loaded = import('@octokit/auth-app').then(
        (sdk) =>
          sdk.createAppAuth({
            appId: options.appId,
            privateKey: options.privateKey,
            clientId: options.clientId,
            clientSecret: options.clientSecret,
          }) as unknown as AppAuth,
      );
      loaded.catch(() => {
        loaded = undefined;
      });
    }
    return (await loaded)(authOptions);
  };
}

function headers(token: string, scheme: 'Bearer' | 'token'): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `${scheme} ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-runner-monitor-debug-it',
  };
}

// Headers for a redirect target (the log host or codeload): no credential.
function plainHeaders(): Record<string, string> {
  return { 'User-Agent': 'github-runner-monitor-debug-it' };
}

const FETCH_TIMEOUT_MS = 10000;

// Each path segment encoded on its own, so `/` keeps separating segments.
function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function isWorkflowPath(path: string | null): path is string {
  return path !== null && WORKFLOW_PATH.test(path) && !path.split('/').some((part) => part === '..' || part === '.' || part === '');
}

// The https URL a 3xx answer points to; anything else throws.
function redirectTarget(res: Response, what: string): string {
  const location = res.headers.get('location');
  let url: URL;
  try {
    url = new URL(location ?? '');
  } catch {
    throw new GitHubAppError(`GitHub answered the ${what} request with a redirect without a valid address.`);
  }
  if (url.protocol !== 'https:') {
    throw new GitHubAppError(`GitHub answered the ${what} request with a redirect that is not https.`);
  }
  return url.toString();
}

/**
 * Reads a stream keeping only its last `maxBytes`. A cut text starts after
 * its first newline, so it starts at a line.
 */
export async function keepTail(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<JobLog> {
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  for await (const raw of source) {
    const chunk = Buffer.from(raw);
    total += chunk.length;
    chunks.push(chunk);
    kept += chunk.length;
    // Drop whole chunks that lie entirely before the last maxBytes.
    // Keeps one byte more than maxBytes, so the byte before the cut is known.
    while (chunks.length > 1 && kept - chunks[0]!.length >= maxBytes + 1) kept -= chunks.shift()!.length;
  }
  const buffer = Buffer.concat(chunks);
  // Only when the kept part is exactly the stream does nothing lie before it.
  return cutTail(buffer, maxBytes, total > buffer.length);
}

/** The last `maxBytes` of `text`, starting at a line when cut. */
export function cutTail(text: Buffer, maxBytes: number, alreadyCut = false): JobLog {
  const cutAt = text.length > maxBytes ? text.length - maxBytes : 0;
  let tail = text.subarray(cutAt);
  const truncated = alreadyCut || text.length > maxBytes;
  // A cut that lands on a line start keeps that line. When the bytes before
  // the cut are unknown (alreadyCut with nothing cut here), the first line may be partial.
  const atLineStart = cutAt > 0 ? text[cutAt - 1] === 0x0a : false;
  if (truncated && !atLineStart) {
    const newline = tail.indexOf(0x0a);
    if (newline !== -1 && newline + 1 < tail.length) tail = tail.subarray(newline + 1);
  }
  return { text: Buffer.from(tail), truncated };
}

// Splits owner/name and refuses anything outside the organization, before any token is requested.
function organizationRepository(repository: string, organization: string): [string, string] {
  const parts = typeof repository === 'string' ? repository.split('/') : [];
  if (parts.length !== 2 || !parts[0] || !REPOSITORY_NAME.test(parts[1]!)) {
    throw new GitHubAppError('The repository is not in owner/name form.');
  }
  if (parts[0].toLowerCase() !== organization.toLowerCase()) {
    throw new GitHubAppError('The repository is outside the configured organization.');
  }
  return [parts[0], parts[1]!];
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

// A branch name Debug it may put in a path: valid characters and no empty, `.` or `..` part.
function isRefName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    REF_NAME.test(value) &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..') &&
    !value.endsWith('.lock')
  );
}

// A file path inside a repository: plain parts, no control characters.
function isRepositoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Thrown inside openFixPullRequest; answered as a refusal, never as an error.
class FixRefusal {
  constructor(readonly reason: 'not-a-file' | 'does-not-apply') {}
}

const BLOB_MODES: ReadonlySet<string> = new Set(['100644', '100755']);
const TREE_MODE = '040000';
const NEW_FILE_MODE = '100644';
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function createGitHubApp(options: GitHubAppOptions): GitHubApp {
  const auth = options.auth ?? lazyAppAuth(options);
  const rawFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  // A stalled GitHub aborts after 10 s; step() turns that into a GitHubAppError.
  const doFetch: FetchLike = (url, init) => rawFetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  // A log or tarball body may take up to 10 minutes to arrive.
  const longFetch: FetchLike = (url, init) => rawFetch(url, { ...init, signal: AbortSignal.timeout(BODY_TIMEOUT_MS) });
  const org = encodeURIComponent(options.organization);
  const now = options.now ?? Date.now;
  let installationId: number | undefined;
  // Per user ID and lowercase repository; expiry is checked against `now`.
  const permissions = new LRUCache<string, { value: RepositoryPermission; at: number }>({ max: PERMISSION_CACHE_MAX });
  // Per user ID; same expiry rule as the permission cache.
  const logins = new LRUCache<number, { value: string | null; at: number }>({ max: PERMISSION_CACHE_MAX });

  // Wraps a step so any failure surfaces as a GitHubAppError whose message
  // holds no code, token or key.
  async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GitHubAppError) throw error;
      throw new GitHubAppError(`GitHub did not answer the ${what} request.`);
    }
  }

  async function installation(): Promise<{ id: number; permissions: Record<string, string>; suspended: boolean }> {
    const { token } = await auth({ type: 'app' });
    const res = await doFetch(`${GITHUB_API}/orgs/${org}/installation`, { headers: headers(token, 'Bearer') });
    if (!res.ok) {
      throw new GitHubAppError(`The Debug it GitHub App is not installed on the organization (GitHub answered ${res.status}).`);
    }
    const body = (await res.json()) as { id?: unknown; permissions?: unknown; suspended_at?: unknown };
    if (typeof body.id !== 'number') {
      throw new GitHubAppError('GitHub returned an installation without an ID.');
    }
    const permissions: Record<string, string> = {};
    if (body.permissions && typeof body.permissions === 'object') {
      for (const [name, level] of Object.entries(body.permissions as Record<string, unknown>)) {
        if (typeof level === 'string') permissions[name] = level;
      }
    }
    installationId = body.id;
    return { id: body.id, permissions, suspended: body.suspended_at != null };
  }

  async function installationIdCached(): Promise<number> {
    if (installationId !== undefined) return installationId;
    return (await installation()).id;
  }

  // An organization token narrowed to members read, the same one checkMembership uses.
  async function membersToken(): Promise<string> {
    const id = await installationIdCached();
    const { token } = await auth({ type: 'installation', installationId: id, permissions: { members: 'read' } });
    return token;
  }

  // Reads a user answer; 404 is null, anything else not ok throws.
  async function userAnswer(path: string, what: string): Promise<GitHubUser | null> {
    const token = await membersToken();
    const res = await doFetch(`${GITHUB_API}${path}`, { headers: headers(token, 'token') });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubAppError(`GitHub did not answer the ${what} (GitHub answered ${res.status}).`);
    const body = (await res.json()) as { id?: unknown; login?: unknown };
    if (typeof body.id !== 'number' || typeof body.login !== 'string' || body.login === '') {
      throw new GitHubAppError('GitHub returned a user without an ID or login.');
    }
    return { githubUserId: body.id, login: body.login };
  }

  // A token narrowed to one repository of the organization and these permissions.
  async function repositoryToken(name: string, permissions: Record<string, string>): Promise<string> {
    const id = await installationIdCached();
    const { token } = await auth({ type: 'installation', installationId: id, repositoryNames: [name], permissions });
    return token;
  }

  // The workflow file at `sha`, or null when it cannot be read safely.
  async function workflowFile(parts: [string, string], path: string | null, sha: string | null): Promise<WorkflowFile | null> {
    if (!isWorkflowPath(path) || sha === null || !COMMIT_SHA.test(sha)) return null;
    const token = await repositoryToken(parts[1], { contents: 'read' });
    const [owner, repo] = parts.map((part) => encodeURIComponent(part));
    const res = await doFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(sha)}`,
      { headers: headers(token, 'token') },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubAppError(`GitHub did not answer the workflow file request (GitHub answered ${res.status}).`);
    const body = (await res.json()) as { type?: unknown; size?: unknown; content?: unknown; encoding?: unknown };
    if (Array.isArray(body) || body.type !== 'file') return null;
    if (typeof body.size !== 'number' || body.size > WORKFLOW_FILE_MAX_BYTES) return null;
    if (typeof body.content !== 'string' || (body.encoding !== undefined && body.encoding !== 'base64')) return null;
    const bytes = Buffer.from(body.content, 'base64');
    if (bytes.length > WORKFLOW_FILE_MAX_BYTES) return null;
    return { path, text: bytes.toString('utf8') };
  }

  return {
    exchangeCode(code, redirectUrl) {
      return step('sign in', async () => {
        const { token } = await auth({ type: 'oauth-user', code, redirectUrl });
        const res = await doFetch(`${GITHUB_API}/user`, { headers: headers(token, 'token') });
        if (!res.ok) {
          throw new GitHubAppError(`GitHub did not return the signed in user (GitHub answered ${res.status}).`);
        }
        const body = (await res.json()) as { id?: unknown; login?: unknown };
        if (typeof body.id !== 'number' || typeof body.login !== 'string' || body.login === '') {
          throw new GitHubAppError('GitHub returned a user without an ID or login.');
        }
        return { githubUserId: body.id, login: body.login };
      });
    },

    checkMembership(login) {
      return step('membership', async () => {
        const id = await installationIdCached();
        const { token } = await auth({ type: 'installation', installationId: id, permissions: { members: 'read' } });
        const res = await doFetch(`${GITHUB_API}/orgs/${org}/members/${encodeURIComponent(login)}`, {
          headers: headers(token, 'token'),
          redirect: 'manual',
        });
        if (res.status === 204) return true;
        if (res.status === 404 || res.status === 302) return false;
        throw new GitHubAppError(`GitHub did not answer the membership check (GitHub answered ${res.status}).`);
      });
    },

    checkInstallation() {
      return step('installation', async () => {
        const { id, permissions, suspended } = await installation();
        if (suspended) throw new GitHubAppError('The Debug it GitHub App installation is suspended.');
        const forbidden = FORBIDDEN_PERMISSIONS.filter((name) => permissions[name] !== undefined);
        return { installationId: id, permissions, forbidden };
      });
    },

    async checkPermission(user, repository, opts = {}) {
      const parts = repository.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1] || !user.login) return 'none';
      if (parts[0].toLowerCase() !== options.organization.toLowerCase()) return 'none';
      const name = parts[1];
      const cacheKey = `${user.githubUserId}:${repository.toLowerCase()}`;
      if (!opts.fresh) {
        const hit = permissions.get(cacheKey);
        const age = hit ? now() - hit.at : -1;
        // A clock behind the entry's time counts as a miss, so nothing is served forever.
        if (hit && age >= 0 && age < PERMISSION_CACHE_TTL_MS) return hit.value;
      }
      const value = await step('repository permission', async (): Promise<RepositoryPermission> => {
        const id = await installationIdCached();
        let token: string;
        try {
          ({ token } = await auth({
            type: 'installation',
            installationId: id,
            repositoryNames: [name],
            permissions: { metadata: 'read' },
          }));
        } catch (error) {
          if ((error as { status?: unknown } | null)?.status === 422) return 'none';
          throw error;
        }
        const [owner, repo] = parts.map((part) => encodeURIComponent(part));
        const res = await doFetch(
          `${GITHUB_API}/repos/${owner}/${repo}/collaborators/${encodeURIComponent(user.login)}/permission`,
          { headers: headers(token, 'token') },
        );
        if (res.status === 404) return 'none';
        if (!res.ok) {
          throw new GitHubAppError(`GitHub did not answer the repository permission check (GitHub answered ${res.status}).`);
        }
        const body = (await res.json()) as { role_name?: unknown; permission?: unknown; user?: { id?: unknown } | null };
        // A login now held by someone else must not lend them its access.
        if (body.user?.id !== user.githubUserId) return 'none';
        return permissionFromAnswer(body);
      });
      permissions.set(cacheKey, { value, at: now() });
      return value;
    },

    findUser(login) {
      return step('user lookup', () => userAnswer(`/users/${encodeURIComponent(login)}`, 'user lookup'));
    },

    async userLogin(githubUserId) {
      if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) return null;
      const hit = logins.get(githubUserId);
      const age = hit ? now() - hit.at : -1;
      if (hit && age >= 0 && age < PERMISSION_CACHE_TTL_MS) return hit.value;
      const value = await step('user login lookup', async () => {
        const user = await userAnswer(`/user/${githubUserId}`, 'user login lookup');
        // An answer about another ID is no answer.
        return user && user.githubUserId === githubUserId ? user.login : null;
      });
      logins.set(githubUserId, { value, at: now() });
      return value;
    },

    async readContextFile(repository) {
      const parts = organizationRepository(repository, options.organization);
      const name = parts[1];
      return step('debug context file', async (): Promise<ContextFileAnswer> => {
        const id = await installationIdCached();
        let token: string;
        try {
          ({ token } = await auth({
            type: 'installation',
            installationId: id,
            repositoryNames: [name],
            permissions: { contents: 'read' },
          }));
        } catch (error) {
          // 422: the App is not installed on that repository.
          if ((error as { status?: unknown } | null)?.status === 422) return { status: 'missing' };
          throw error;
        }
        const [owner, repo] = parts.map((part) => encodeURIComponent(part));
        // No ref: GitHub answers from the default branch.
        const res = await doFetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${CONTEXT_FILE_PATH}`, {
          headers: headers(token, 'token'),
        });
        if (res.status === 404) return { status: 'missing' };
        if (!res.ok) {
          throw new GitHubAppError(`GitHub did not answer the debug context file request (GitHub answered ${res.status}).`);
        }
        const body = (await res.json()) as { type?: unknown; size?: unknown; content?: unknown; encoding?: unknown };
        if (Array.isArray(body) || body.type !== 'file') return { status: 'missing' };
        if (typeof body.size !== 'number') throw new GitHubAppError('GitHub returned the debug context file without its size.');
        if (body.size > CONTEXT_FILE_MAX_BYTES) return { status: 'too-large' };
        if (typeof body.content !== 'string' || (body.encoding !== undefined && body.encoding !== 'base64')) {
          throw new GitHubAppError('GitHub returned the debug context file without its content.');
        }
        const bytes = Buffer.from(body.content, 'base64');
        if (bytes.length > CONTEXT_FILE_MAX_BYTES) return { status: 'too-large' };
        return { status: 'found', text: bytes.toString('utf8') };
      });
    },

    async readWorkflowRun(repository, runId, runOptions = {}) {
      const parts = organizationRepository(repository, options.organization);
      if (!Number.isSafeInteger(runId) || runId <= 0) {
        throw new GitHubAppError('The workflow run ID is not a positive whole number.');
      }
      return step('workflow run', async (): Promise<WorkflowRunInfo> => {
        const id = await installationIdCached();
        const { token } = await auth({
          type: 'installation',
          installationId: id,
          repositoryNames: [parts[1]],
          permissions: { actions: 'read' },
        });
        const [owner, repo] = parts.map((part) => encodeURIComponent(part));
        const res = await doFetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}`, {
          headers: headers(token, 'token'),
        });
        if (res.status === 404) throw new GitHubAppError('GitHub knows no such workflow run.');
        if (!res.ok) {
          throw new GitHubAppError(`GitHub did not answer the workflow run request (GitHub answered ${res.status}).`);
        }
        const body = (await res.json()) as {
          id?: unknown;
          head_sha?: unknown;
          head_branch?: unknown;
          head_repository?: { full_name?: unknown } | null;
          path?: unknown;
        };
        if (body.id !== runId) throw new GitHubAppError('GitHub returned another workflow run than the one asked for.');
        const info: WorkflowRunInfo = {
          id: runId,
          headRepository: textOrNull(body.head_repository?.full_name),
          headSha: textOrNull(body.head_sha),
          headBranch: textOrNull(body.head_branch),
          path: textOrNull(body.path),
        };
        if (!runOptions.workflowFile) return info;
        // GitHub's API offers no error message for a run that failed before any job (see story 3.8).
        return { ...info, workflowFile: await workflowFile(parts, info.path, info.headSha), errorMessage: null };
      });
    },

    async readLog(repository, jobId, maxBytes) {
      const parts = organizationRepository(repository, options.organization);
      if (!Number.isSafeInteger(jobId) || jobId <= 0) {
        throw new GitHubAppError('The job ID is not a positive whole number.');
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new GitHubAppError('The log limit is not a positive whole number.');
      }
      return step('job log', async (): Promise<JobLog> => {
        const token = await repositoryToken(parts[1], { actions: 'read' });
        const [owner, repo] = parts.map((part) => encodeURIComponent(part));
        let res = await longFetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
          headers: headers(token, 'token'),
          redirect: 'manual',
        });
        if (res.status === 404 || res.status === 410) throw new GitHubAppError('GitHub has no log for this job.');
        if (res.status >= 300 && res.status < 400) {
          const target = redirectTarget(res, 'job log');
          await res.body?.cancel().catch(() => undefined);
          // The log host gets no Authorization header: the address carries its own short-lived grant.
          res = await longFetch(target, { headers: plainHeaders(), redirect: 'error' });
          if (res.status === 404 || res.status === 410) throw new GitHubAppError('GitHub has no log for this job.');
        }
        if (res.status !== 200 || !res.body) {
          throw new GitHubAppError(`GitHub did not answer the job log request (GitHub answered ${res.status}).`);
        }
        return keepTail(res.body as unknown as AsyncIterable<Uint8Array>, maxBytes);
      });
    },

    async downloadTarball(repository, ref) {
      const parts = organizationRepository(repository, options.organization);
      if (ref !== null && (typeof ref !== 'string' || !REF_NAME.test(ref) || ref.split('/').some((p) => p === '' || p === '.' || p === '..'))) {
        throw new GitHubAppError('The commit or branch to download is not a valid name.');
      }
      return step('repository download', async (): Promise<Tarball> => {
        const token = await repositoryToken(parts[1], { contents: 'read', metadata: 'read' });
        const [owner, repo] = parts.map((part) => encodeURIComponent(part));
        const commit = await doFetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${encodePath(ref ?? 'HEAD')}`, {
          headers: { ...headers(token, 'token'), Accept: 'application/vnd.github.sha' },
        });
        if (commit.status === 404 || commit.status === 422) throw new GitHubAppError('GitHub knows no such commit.');
        if (!commit.ok) {
          throw new GitHubAppError(`GitHub did not answer the commit request (GitHub answered ${commit.status}).`);
        }
        const commitSha = (await commit.text()).trim().toLowerCase();
        if (!COMMIT_SHA.test(commitSha)) throw new GitHubAppError('GitHub returned a commit that is not a full SHA.');
        if (ref !== null && COMMIT_SHA.test(ref) && ref.toLowerCase() !== commitSha) {
          throw new GitHubAppError('GitHub resolved another commit than the one asked for.');
        }
        let res = await longFetch(`${GITHUB_API}/repos/${owner}/${repo}/tarball/${commitSha}`, {
          headers: headers(token, 'token'),
          redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) {
          const target = redirectTarget(res, 'repository download');
          await res.body?.cancel().catch(() => undefined);
          // codeload gets no Authorization header; its address is never stored or forwarded.
          res = await longFetch(target, { headers: plainHeaders(), redirect: 'error' });
        }
        if (res.status !== 200 || !res.body) {
          throw new GitHubAppError(`GitHub did not answer the repository download (GitHub answered ${res.status}).`);
        }
        return { commitSha, body: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]) };
      });
    },

    async checkRuleset(repository) {
      const parts = organizationRepository(repository, options.organization);
      return step('ruleset', async (): Promise<RulesetCheck> => {
        const token = await repositoryToken(parts[1], { metadata: 'read' });
        const api = repositoryApi(parts, token);
        const branch = await api.defaultBranch();
        const rules = await api.json('ruleset', `/rules/branches/${encodePath(branch)}?per_page=100`);
        if (!Array.isArray(rules)) throw new GitHubAppError('GitHub returned branch rules that are not a list.');
        const ids = new Set<number>();
        for (const rule of rules) {
          if (!isRecord(rule) || typeof rule.ruleset_id !== 'number' || !Number.isSafeInteger(rule.ruleset_id)) continue;
          const parameters = isRecord(rule.parameters) ? rule.parameters : {};
          const reviews = parameters.required_approving_review_count;
          if (rule.type === 'update' || (rule.type === 'pull_request' && typeof reviews === 'number' && reviews >= 1)) {
            ids.add(rule.ruleset_id);
          }
        }
        for (const id of ids) {
          const ruleset = await api.json('ruleset', `/rulesets/${id}?includes_parents=true`);
          if (isRecord(ruleset) && ruleset.enforcement === 'active' && ruleset.current_user_can_bypass === 'never') {
            return { protected: true };
          }
        }
        return { protected: false };
      });
    },

    async openFixPullRequest(input) {
      const parts = organizationRepository(input.repository, options.organization);
      if (typeof input.commitSha !== 'string' || !COMMIT_SHA.test(input.commitSha)) {
        throw new GitHubAppError('The commit to fix is not a full SHA.');
      }
      if (!isRefName(input.branch) || !input.branch.startsWith(FIX_BRANCH_PREFIX)) {
        throw new GitHubAppError('The fix branch is not a valid name under debug-it/.');
      }
      if (input.base !== null && !isRefName(input.base)) throw new GitHubAppError('The base branch is not a valid name.');
      if (typeof input.title !== 'string' || typeof input.body !== 'string' || !Array.isArray(input.sections)) {
        throw new GitHubAppError('The fix pull request input is malformed.');
      }
      return step('fix pull request', async (): Promise<FixPullRequestOutcome> => {
        const token = await repositoryToken(parts[1], { contents: 'write', pull_requests: 'write' });
        const api = repositoryApi(parts, token);
        const branchPath = `/git/ref/heads/${encodePath(input.branch)}`;

        // An open pull request from the branch, or null.
        const openPullRequest = async (): Promise<FixPullRequestOutcome | null> => {
          const head = encodeURIComponent(`${parts[0]}:${input.branch}`);
          const list = await api.json('pull request', `/pulls?state=open&head=${head}&per_page=1`);
          if (!Array.isArray(list) || list.length === 0) return null;
          return pullRequestOutcome(list[0], true);
        };

        // 1. A retry finds the branch and its pull request.
        const ref = await api.fetch(branchPath);
        await ref.body?.cancel().catch(() => undefined);
        let branchExists = false;
        if (ref.status === 200) {
          branchExists = true;
          const existing = await openPullRequest();
          if (existing) return existing;
        } else if (ref.status !== 404) {
          throw new GitHubAppError(`GitHub did not answer the branch request (GitHub answered ${ref.status}).`);
        }

        // 2. Read the original files at the commit and apply the sections in memory.
        let entries: Array<{ path: string; mode: string; type: 'blob'; sha: string | null }>;
        let baseTree: string;
        try {
          ({ entries, baseTree } = await applyFix(api, input));
        } catch (error) {
          if (error instanceof FixRefusal) return { status: 'refused', reason: error.reason };
          throw error;
        }

        // 3. Blobs, one tree, one commit.
        const treeAnswer = await api.send('tree', 'POST', '/git/trees', { base_tree: baseTree, tree: entries });
        const treeSha = shaOf(treeAnswer, 'tree');
        const commitAnswer = await api.send('commit', 'POST', '/git/commits', {
          message: input.title,
          tree: treeSha,
          parents: [input.commitSha.toLowerCase()],
        });
        const commitSha = shaOf(commitAnswer, 'commit');

        // 4. The branch, under debug-it/ only.
        if (branchExists) {
          await api.send('branch', 'PATCH', `/git/refs/heads/${encodePath(input.branch)}`, { sha: commitSha, force: true });
        } else {
          const created = await api.fetch('/git/refs', 'POST', { ref: `refs/heads/${input.branch}`, sha: commitSha });
          await created.body?.cancel().catch(() => undefined);
          if (created.status === 422) {
            await api.send('branch', 'PATCH', `/git/refs/heads/${encodePath(input.branch)}`, { sha: commitSha, force: true });
          } else if (!created.ok) {
            throw new GitHubAppError(`GitHub did not answer the branch request (GitHub answered ${created.status}).`);
          }
        }

        // 5. One draft pull request.
        const base = input.base ?? (await api.defaultBranch());
        const pull = await api.fetch('/pulls', 'POST', {
          title: input.title,
          body: input.body,
          head: input.branch,
          base,
          draft: true,
        });
        if (pull.status === 422) {
          await pull.body?.cancel().catch(() => undefined);
          const existing = await openPullRequest();
          if (existing) return existing;
        }
        if (!pull.ok) {
          await pull.body?.cancel().catch(() => undefined);
          throw new GitHubAppError(`GitHub did not answer the pull request request (GitHub answered ${pull.status}).`);
        }
        return pullRequestOutcome(await pull.json(), false);
      });
    },
  };

  // Calls on one repository with one token; the token never leaves here.
  function repositoryApi(parts: [string, string], token: string) {
    const [owner, repo] = parts.map((part) => encodeURIComponent(part));
    const base = `${GITHUB_API}/repos/${owner}/${repo}`;
    const fetchPath = (path: string, method = 'GET', body?: unknown): Promise<Response> =>
      doFetch(`${base}${path}`, {
        method,
        headers: body === undefined ? headers(token, 'token') : { ...headers(token, 'token'), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const send = async (what: string, method: string, path: string, body?: unknown): Promise<unknown> => {
      const res = await fetchPath(path, method, body);
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new GitHubAppError(`GitHub did not answer the ${what} request (GitHub answered ${res.status}).`);
      }
      return res.json();
    };
    return {
      fetch: fetchPath,
      send,
      json: (what: string, path: string) => send(what, 'GET', path),
      async defaultBranch(): Promise<string> {
        const body = await send('repository', 'GET', '');
        const branch = isRecord(body) ? body.default_branch : undefined;
        if (!isRefName(branch)) throw new GitHubAppError('GitHub returned a repository without a valid default branch.');
        return branch;
      },
    };
  }

  // Reads every file the sections touch at the commit, applies them and
  // answers the tree entries to write (blobs already created).
  async function applyFix(
    api: ReturnType<typeof repositoryApi>,
    input: FixPullRequestInput,
  ): Promise<{ entries: Array<{ path: string; mode: string; type: 'blob'; sha: string | null }>; baseTree: string }> {
    const commit = await api.json('commit', `/git/commits/${input.commitSha.toLowerCase()}`);
    const baseTree = shaOf(isRecord(commit) ? commit.tree : null, 'commit');
    const trees = new Map<string, Array<Record<string, unknown>>>();

    const treeEntries = async (sha: string): Promise<Array<Record<string, unknown>>> => {
      const cached = trees.get(sha);
      if (cached) return cached;
      const body = await api.json('tree', `/git/trees/${sha}`);
      if (!isRecord(body) || !Array.isArray(body.tree) || body.truncated === true) {
        throw new GitHubAppError('GitHub returned a tree that is not complete.');
      }
      const entries = body.tree.filter(isRecord);
      trees.set(sha, entries);
      return entries;
    };

    // The file at `path` in the commit: its mode and blob SHA, or null when it is not there.
    const lookup = async (path: string): Promise<{ mode: string; sha: string } | null> => {
      if (!isRepositoryPath(path)) throw new FixRefusal('not-a-file');
      const segments = path.split('/');
      let treeSha = baseTree;
      for (let i = 0; i < segments.length; i += 1) {
        const entry = (await treeEntries(treeSha)).find((e) => e.path === segments[i]);
        if (!entry) return null;
        const mode = typeof entry.mode === 'string' ? entry.mode : '';
        const sha = typeof entry.sha === 'string' && COMMIT_SHA.test(entry.sha) ? entry.sha : null;
        if (i < segments.length - 1) {
          if (mode !== TREE_MODE || entry.type !== 'tree' || sha === null) throw new FixRefusal('not-a-file');
          treeSha = sha;
        } else {
          if (!BLOB_MODES.has(mode) || entry.type !== 'blob' || sha === null) throw new FixRefusal('not-a-file');
          return { mode, sha };
        }
      }
      return null;
    };

    const readBlob = async (sha: string): Promise<string> => {
      const body = await api.json('file', `/git/blobs/${sha}`);
      if (!isRecord(body) || typeof body.size !== 'number' || typeof body.content !== 'string') {
        throw new GitHubAppError('GitHub returned a file without its content.');
      }
      if (body.size > FIX_FILE_MAX_BYTES || (body.encoding !== undefined && body.encoding !== 'base64')) {
        throw new FixRefusal('not-a-file');
      }
      const bytes = Buffer.from(body.content, 'base64');
      if (bytes.length > FIX_FILE_MAX_BYTES) throw new FixRefusal('not-a-file');
      try {
        return STRICT_UTF8.decode(bytes);
      } catch {
        throw new FixRefusal('not-a-file');
      }
    };

    // Each path's text as the sections leave it; null is no file. `mode` is the mode at the commit.
    const files = new Map<string, { text: string | null; mode: string | null; changed: boolean }>();
    const fileAt = async (path: string): Promise<{ text: string | null; mode: string | null; changed: boolean }> => {
      const known = files.get(path);
      if (known) return known;
      const found = await lookup(path);
      const file = { text: found ? await readBlob(found.sha) : null, mode: found?.mode ?? null, changed: false };
      files.set(path, file);
      return file;
    };
    const write = (path: string, text: string | null, mode: string | null): void => {
      const file = files.get(path)!;
      files.set(path, { text, mode: file.mode ?? mode, changed: true });
    };

    for (const section of input.sections) {
      const source = section.oldPath ?? section.newPath;
      if (source === null || typeof section.text !== 'string') throw new FixRefusal('does-not-apply');
      const before = await fileAt(source);
      let after: string | null;
      try {
        after = input.apply(before.text, section.text);
      } catch {
        throw new FixRefusal('does-not-apply');
      }
      const moved = section.oldPath !== null && section.newPath !== null && section.oldPath !== section.newPath;
      if (moved) {
        const target = await fileAt(section.newPath!);
        if (target.text !== null || after === null || before.text === null) throw new FixRefusal('does-not-apply');
        write(section.newPath!, after, before.mode);
        if (section.copy !== true) write(section.oldPath!, null, null);
      } else {
        write(source, after, NEW_FILE_MODE);
      }
    }

    const entries: Array<{ path: string; mode: string; type: 'blob'; sha: string | null }> = [];
    for (const [path, file] of files) {
      if (!file.changed) continue;
      if (file.text === null) {
        // A file added and deleted by the sections never existed at the commit.
        if (file.mode !== null) entries.push({ path, mode: file.mode, type: 'blob', sha: null });
        continue;
      }
      const blob = await api.send('file', 'POST', '/git/blobs', {
        content: Buffer.from(file.text, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      entries.push({ path, mode: file.mode ?? NEW_FILE_MODE, type: 'blob', sha: shaOf(blob, 'file') });
    }
    if (entries.length === 0) throw new FixRefusal('does-not-apply');
    return { entries, baseTree };
  }
}

// The `sha` of a Git Data API answer, checked.
function shaOf(body: unknown, what: string): string {
  const sha = isRecord(body) ? body.sha : undefined;
  if (typeof sha !== 'string' || !COMMIT_SHA.test(sha)) throw new GitHubAppError(`GitHub returned a ${what} without a valid SHA.`);
  return sha;
}

function pullRequestOutcome(body: unknown, existing: boolean): FixPullRequestOutcome {
  const url = isRecord(body) ? body.html_url : undefined;
  const number = isRecord(body) ? body.number : undefined;
  if (typeof url !== 'string' || !url.startsWith('https://github.com/') || typeof number !== 'number') {
    throw new GitHubAppError('GitHub returned a pull request without its address.');
  }
  return { status: 'opened', url, number, existing };
}

/** The debug context file mock mode serves; the same text as docs/debug-context/claude-debug-context.example.md. */
export const MOCK_CONTEXT_FILE = `# Debug context for acme/payments-api

## About this repo

payments-api is the Node.js service that takes card payments for the acme web shop.
CI runs on the self-hosted \`linux-large\` pool: \`npm ci\`, then lint, unit tests and an
integration suite that starts Postgres 16 in a service container.

## Common failures

- **Integration tests time out**: the Postgres service container is still starting.
  The \`wait-for-db\` step must run before \`npm run test:integration\`.
- **\`npm ci\` fails with EINTEGRITY**: \`package-lock.json\` was edited by hand.
  Regenerate it with \`npm install\` and commit the result.
- **Docker build fails on \`COPY shared/\`**: the shared configuration now comes from
  the \`acme/shared-config\` package; update the Dockerfile, not the workflow.

## Extra repositories

- shared-actions  the composite actions our workflows call
- acme/shared-config  the configuration package the Docker build installs
`;

/** The job log mock mode serves (invented). */
export const MOCK_JOB_LOG = `2026-11-05T09:58:01.0000000Z ##[group]Run npm run test:integration
2026-11-05T09:58:02.0000000Z > payments-api@1.4.0 test:integration
2026-11-05T09:58:32.0000000Z Error: connect ECONNREFUSED 127.0.0.1:5432
2026-11-05T09:58:32.0000000Z     at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)
2026-11-05T09:58:33.0000000Z ##[error]Process completed with exit code 1.
`;

/** The workflow file mock mode serves (invented). */
export const MOCK_WORKFLOW_FILE: WorkflowFile = {
  path: '.github/workflows/ci.yml',
  text: `name: CI
on: [push]
jobs:
  test:
    runs-on: [self-hosted, linux-large]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run test:integration
`,
};

/** The commit every mock tarball resolves to. */
export const MOCK_TARBALL_SHA = '0123456789abcdef0123456789abcdef01234567';

// One ustar header block for a regular file or directory.
function tarHeader(name: string, size: number, type: '0' | '5'): Buffer {
  const block = Buffer.alloc(512);
  const octal = (offset: number, length: number, value: number): void => {
    block.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, 'latin1');
  };
  block.write(name, 0, 'utf8');
  octal(100, 8, type === '5' ? 0o755 : 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 1762336800);
  block.write(type, 156, 'latin1');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return block;
}

// A tiny gzip tarball shaped like GitHub's: one top folder, one README.
function mockTarball(repository: string): Buffer {
  const top = `${repository.replace('/', '-')}-${MOCK_TARBALL_SHA.slice(0, 7)}/`;
  const readme = Buffer.from(`# ${repository}\n\nInvented mock repository for Debug it demo mode.\n`, 'utf8');
  const padding = Buffer.alloc((512 - (readme.length % 512)) % 512);
  return gzipSync(
    Buffer.concat([tarHeader(top, 0, '5'), tarHeader(`${top}README.md`, readme.length, '0'), readme, padding, Buffer.alloc(1024)]),
  );
}

// Invented users the mock App knows (AD-16).
const MOCK_USERS: readonly GitHubUser[] = [
  { githubUserId: 1000001, login: 'dana' },
  { githubUserId: 1000002, login: 'lee' },
  { githubUserId: 1000003, login: 'sam' },
];

/** A GitHub App for USE_MOCK_DATA=true: a fixed invented member, no GitHub call. */
export function createMockGitHubApp(): GitHubApp {
  return {
    async exchangeCode() {
      return { githubUserId: 1000001, login: 'dana' };
    },
    async checkMembership() {
      return true;
    },
    async checkInstallation() {
      return {
        installationId: 1,
        permissions: {
          actions: 'read',
          contents: 'write',
          members: 'read',
          metadata: 'read',
          pull_requests: 'write',
        },
        forbidden: [],
      };
    },
    async checkPermission() {
      // Mock mode: checks pass (AD-16).
      return 'write';
    },
    async findUser(login) {
      const user = MOCK_USERS.find((u) => u.login.toLowerCase() === login.toLowerCase());
      return user ? { ...user } : null;
    },
    async readContextFile() {
      // Mock mode: every repository opts in with the invented example (AD-16).
      return { status: 'found', text: MOCK_CONTEXT_FILE };
    },
    async readWorkflowRun(repository, runId, runOptions = {}) {
      // Mock mode: the run's commit comes from the repository itself (AD-16).
      const info: WorkflowRunInfo = { id: runId, headRepository: repository, headSha: null, headBranch: null, path: MOCK_WORKFLOW_FILE.path };
      if (!runOptions.workflowFile) return info;
      return { ...info, workflowFile: { ...MOCK_WORKFLOW_FILE }, errorMessage: null };
    },
    async readLog(_repository, _jobId, maxBytes) {
      return cutTail(Buffer.from(MOCK_JOB_LOG, 'utf8'), maxBytes);
    },
    async downloadTarball(repository) {
      return { commitSha: MOCK_TARBALL_SHA, body: Readable.from([mockTarball(repository)]) };
    },
    async checkRuleset() {
      // Mock mode: every repository is protected (AD-16).
      return { protected: true };
    },
    async openFixPullRequest(input) {
      // Mock mode: an invented address, no GitHub call (AD-16).
      return { status: 'opened', url: `https://github.com/${input.repository}/pull/1`, number: 1, existing: false };
    },
    async userLogin(githubUserId) {
      return MOCK_USERS.find((u) => u.githubUserId === githubUserId)?.login ?? null;
    },
  };
}

let singleton: GitHubApp | undefined;

/** The GitHub App for this process, built from the environment on first use. */
export function getGitHubApp(env: Record<string, string | undefined> = process.env): GitHubApp {
  if (singleton) return singleton;
  if (env.USE_MOCK_DATA === 'true') {
    singleton = createMockGitHubApp();
    return singleton;
  }
  const appId = env.DEBUG_IT_GITHUB_APP_ID?.trim();
  const clientId = env.DEBUG_IT_GITHUB_APP_CLIENT_ID?.trim();
  const privateKey = env.DEBUG_IT_GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientSecret = env.DEBUG_IT_GITHUB_APP_CLIENT_SECRET;
  const organization = env.GITHUB_ORGANIZATION?.trim();
  if (!appId || !clientId || !privateKey || !clientSecret || !organization) {
    throw new GitHubAppError('The Debug it GitHub App or the GitHub organization is not configured.');
  }
  singleton = createGitHubApp({ appId, clientId, privateKey, clientSecret, organization });
  return singleton;
}

/** Test helper: forget the process-wide GitHub App. */
export function resetGitHubApp(): void {
  singleton = undefined;
}
