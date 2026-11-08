// Open a fix pull request (story 4.2, Epic 4). The only path by which Debug
// it writes to GitHub. The route has passed session, CSRF, allowed user, a run
// loader and a fresh write permission lookup; open() then runs its own checks,
// each refusing with one fixed sentence and writing nothing: requester, a
// result, not a fork, the patch part of this repository exists and passed
// validation (story 4.1), a known base branch and commit. It then asks the
// adapter whether the default branch is protected by a ruleset, and opens the
// draft pull request with the validated sections and the pure applier.
//
// Nothing comes from the request: repository, commit, branch and sections
// come only from the run record and validatePatch. After opening, one
// conditional write adds { repository, url } to the run record and one adds 1
// to the run's usage entry; a failed write is logged and the answer stays 201
// (the adapter's branch lookup keeps a retry idempotent). Clicks for the same
// run and repository run one after another through an in-memory lock.
//
// Several repositories (story 4.3): the body links the other fix pull requests
// of the same run, every other repository whose patch part passed validation
// and has files. Bodies are written once (the App never edits a pull request),
// so an opened one is linked by its stored URL and one not yet opened by a
// GitHub search for its fixed branch name.
import { getS3Store, S3StoreError, type S3Store } from '../../adapters/s3Store.ts';
import { getGitHubApp, GitHubAppError, type FixPullRequestOutcome, type GitHubApp } from '../../adapters/githubApp.ts';
import { debugItConfig, type DebugItConfig } from '../debugItConfig.ts';
import { applySection, isCopySection } from './patchApply.ts';
import { validatePatch } from './patchValidation.ts';
import {
  isRunRecord,
  isUsageRecord,
  readDownloads,
  readFixPullRequests,
  readRunResult,
  runKey,
  type RunRecord,
  type UsageRecord,
} from './runs.ts';

type Env = Record<string, string | undefined>;

export const FIX_PR_ERRORS = {
  notRequester: 'Only the person who started this debug run can open a fix pull request from it.',
  noResult: 'This debug run has no result to open a fix pull request from.',
  fork: 'The failed run came from a fork, so Debug it cannot open a fix pull request for it.',
  noPatch: 'The patch does not change this repository, so there is no fix pull request to open.',
  noBase: 'The branch of the failed run is not known, so Debug it cannot open a fix pull request for it.',
  noCommit: 'The commit downloaded for this repository is not known, so Debug it cannot open a fix pull request for it.',
  ruleset:
    'Debug it opens fix pull requests only where an active ruleset, with no bypass for Debug it, stops it from pushing to and merging into the default branch, and this repository has none.',
  notAFile: 'The patch changes a path that is not a plain text file of at most 1 MiB at the failed commit.',
  doesNotApply: 'The patch no longer applies to the files at the failed commit.',
  github: 'GitHub could not open the fix pull request; please try again.',
  runNotFound: 'This debug run was not found.',
} as const;

/** The longest explanation quoted in the body, in characters. */
export const EXPLANATION_MAX = 20000;
/** The longest pull request title, in characters. */
export const TITLE_MAX = 200;

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const USAGE_KEY = /^usage\/\d{4}-\d{2}\/[1-9]\d*\.json$/;

export interface FixPullRequestEntry {
  repository: string;
  url: string;
}

export type FixPullRequestResult =
  | { status: 201; body: FixPullRequestEntry }
  | { status: 200; body: FixPullRequestEntry & { existing: true } }
  | { status: 403 | 404 | 409 | 502; body: { error: string } };

export interface FixPullRequestService {
  /** Runs its own checks, after the route's check chain, and opens the fix pull request for one repository of the run. */
  open(record: RunRecord, repository: string, user: { githubUserId: number; login: string }): Promise<FixPullRequestResult>;
}

export interface FixPullRequestServiceOptions {
  store: S3Store | (() => S3Store);
  githubApp: GitHubApp | (() => GitHubApp);
  config: Pick<DebugItConfig, 'limits'>;
  now?: () => Date;
}

// Closing keywords GitHub acts on, when followed by an issue reference.
const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[ \t]*:?[ \t]*(?=(?:[\w.-]+\/[\w.-]+)?#\d|gh-\d|https?:\/\/github\.com\/\S+?\/(?:issues|pull)\/\d)/gi;

function cleanOnce(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/@(?=[A-Za-z0-9_-])/g, '')
    .replace(CLOSING, '');
}

// Cuts at `max` characters without leaving half a surrogate pair.
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Text safe to put in a pull request: HTML tags and `<`/`>` removed, `@`
 * dropped before a name, closing keywords removed before an issue reference,
 * at most `max` characters.
 */
export function cleanExplanation(text: string, max = EXPLANATION_MAX): string {
  let current = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
  for (;;) {
    const next = cleanOnce(current);
    if (next === current) break;
    current = next;
  }
  return cut(current, max);
}

/** The pull request title: `Debug it fix: {jobName}`, cleaned, on one line, at most 200 characters. */
export function fixPullRequestTitle(jobName: string): string {
  const name = typeof jobName === 'string' ? jobName : '';
  const line = cleanExplanation(`Debug it fix: ${name}`.replace(/[\u0000-\u001f\u007f]+/g, ' '), Number.MAX_SAFE_INTEGER);
  return cut(line.replace(/\s+/g, ' ').trim(), TITLE_MAX);
}

/** Another fix pull request of the same run: its stored URL once opened, else null. */
export interface OtherFixPullRequest {
  repository: string;
  url: string | null;
  branch: string;
}

/** The branch of a run's fix pull request in one repository: `debug-it/{runId}/{name}`. */
export function fixPullRequestBranch(runId: string, repository: string): string {
  return `debug-it/${runId}/${repository.split('/')[1] ?? ''}`;
}

// The link of another fix pull request: its URL, or a search for its branch.
function otherLink(other: OtherFixPullRequest): string {
  if (other.url !== null) return other.url;
  return `https://github.com/${other.repository}/pulls?q=${encodeURIComponent(`is:pr head:${other.branch}`)}`;
}

/** The pull request body, from a fixed template. */
export function fixPullRequestBody(
  record: Pick<RunRecord, 'runId' | 'repository' | 'target' | 'requester'>,
  explanation: string,
  others: readonly OtherFixPullRequest[] = [],
): string {
  const quoted = cleanExplanation(explanation)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  const isJob = record.target.kind === 'job';
  const link = isJob
    ? `https://github.com/${record.repository}/runs/${record.target.id}`
    : `https://github.com/${record.repository}/actions/runs/${record.target.id}`;
  const login = String(record.requester?.login ?? '').replace(/[^A-Za-z0-9-]/g, '');
  return [
    'Debug it proposes this fix for a failed CI run. Its explanation:',
    '',
    quoted,
    '',
    `Failed ${isJob ? 'job' : 'workflow run'}: ${link}`,
    '',
    `Requested by \`${login}\`.`,
    '',
    `Someone other than \`${login}\` should review and approve this pull request.`,
    '',
    'Debug it did not run any command or test to check this change.',
    '',
    ...(others.length > 0
      ? [
          'Fix pull requests from the same Debug it run:',
          '',
          ...others.map((other) => `- ${other.repository}: ${otherLink(other)}`),
          '',
        ]
      : []),
    `Debug it run ID: ${record.runId}`,
    '',
  ].join('\n');
}

// The stored fix pull requests of a run, read field by field.
function storedEntries(value: unknown): FixPullRequestEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e) =>
    e && typeof e === 'object' && typeof e.repository === 'string' && typeof e.url === 'string'
      ? [{ repository: e.repository as string, url: e.url as string }]
      : [],
  );
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function errorText(error: unknown): string {
  return error instanceof S3StoreError || error instanceof GitHubAppError ? error.message : 'unknown error';
}

export function createFixPullRequestService(options: FixPullRequestServiceOptions): FixPullRequestService {
  const store = (): S3Store => (typeof options.store === 'function' ? options.store() : options.store);
  const github = (): GitHubApp => (typeof options.githubApp === 'function' ? options.githubApp() : options.githubApp);
  const { config } = options;
  // Run and repository key to the tail of its queue.
  const locks = new Map<string, Promise<void>>();
  // Run and repository key to the URL opened by this process (a record write may have failed).
  const opened = new Map<string, string>();

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

  const refuse = (status: 403 | 404 | 409 | 502, error: string): FixPullRequestResult => ({ status, body: { error } });

  // Appends the entry to the run record once; answers what happened.
  async function record(runId: string, entry: FixPullRequestEntry): Promise<'added' | 'present' | 'failed'> {
    let outcome: 'added' | 'present' | 'failed' = 'failed';
    try {
      await store().modify<unknown>(runKey(runId), (current) => {
        outcome = 'failed';
        if (!isRunRecord(current, runId)) return undefined;
        const list = Array.isArray(current.fixPullRequests) ? current.fixPullRequests : [];
        if (storedEntries(list).some((e) => same(e.repository, entry.repository))) {
          outcome = 'present';
          return undefined;
        }
        outcome = 'added';
        return { ...current, fixPullRequests: [...list, { ...entry }] };
      });
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId}: the fix pull request could not be recorded: ${errorText(error)}`);
      return 'failed';
    }
    if (outcome === 'failed') console.error(`[ERROR] Debug it run ${runId}: the fix pull request could not be recorded: the run record is missing or malformed.`);
    return outcome;
  }

  async function count(runId: string, key: unknown): Promise<void> {
    if (typeof key !== 'string' || !USAGE_KEY.test(key)) {
      console.error(`[ERROR] Debug it run ${runId}: the fix pull request could not be counted: the run has no usage key.`);
      return;
    }
    let found = true;
    try {
      await store().modify<UsageRecord>(key, (current) => {
        found = isUsageRecord(current) && current.entries.some((e) => e.runId === runId);
        if (!found || !current) return undefined;
        return {
          ...current,
          entries: current.entries.map((e) =>
            e.runId === runId
              ? {
                  ...e,
                  fixPullRequests:
                    (typeof e.fixPullRequests === 'number' && Number.isFinite(e.fixPullRequests) && e.fixPullRequests >= 0
                      ? e.fixPullRequests
                      : 0) + 1,
                }
              : e,
          ),
        };
      });
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId}: the fix pull request could not be counted: ${errorText(error)}`);
      return;
    }
    if (!found) console.error(`[ERROR] Debug it run ${runId}: the fix pull request could not be counted: no usage entry.`);
  }

  async function openLocked(
    run: RunRecord,
    repository: string,
    user: { githubUserId: number; login: string },
    lockKey: string,
  ): Promise<FixPullRequestResult> {
    // Idempotent: a repository already opened answers its pull request, with no GitHub call.
    const done = storedEntries(run.fixPullRequests).find((e) => same(e.repository, repository));
    const known = done?.url ?? opened.get(lockKey);
    if (known !== undefined) return { status: 200, body: { repository, url: known, existing: true } };

    if (typeof run.headRepository !== 'string' || !same(run.headRepository, run.repository)) {
      return refuse(409, FIX_PR_ERRORS.fork);
    }

    const result = readRunResult(run.result)!;
    const downloads = readDownloads(run.downloads);
    const download = downloads.find((d) => same(d.repository, repository));
    if (!download) return refuse(404, FIX_PR_ERRORS.runNotFound);
    const check = validatePatch(result.patch, downloads, config.limits.patchLimitBytes);
    const part = check.repositories.find((r) => same(r.repository, download.repository));
    if (!part || part.sections.length === 0) return refuse(409, FIX_PR_ERRORS.noPatch);
    if (part.status !== 'passed') return refuse(409, part.message ?? FIX_PR_ERRORS.noPatch);

    const own = same(download.repository, run.repository);
    const base = own ? (typeof run.branch === 'string' && run.branch !== '' ? run.branch : null) : null;
    if (own && base === null) return refuse(409, FIX_PR_ERRORS.noBase);
    if (!COMMIT_SHA.test(download.commitSha)) return refuse(409, FIX_PR_ERRORS.noCommit);

    // Every other repository with a passed, non-empty part, in patch order.
    const openedEntries = readFixPullRequests(run.fixPullRequests);
    const others: OtherFixPullRequest[] = check.repositories
      .filter((r) => r.status === 'passed' && r.sections.length > 0 && !same(r.repository, download.repository))
      .map((r) => ({
        repository: r.repository,
        url: openedEntries.find((e) => same(e.repository, r.repository))?.url ?? null,
        branch: fixPullRequestBranch(run.runId, r.repository),
      }));

    let outcome: FixPullRequestOutcome;
    try {
      const ruleset = await github().checkRuleset(download.repository);
      if (ruleset.protected !== true) return refuse(409, FIX_PR_ERRORS.ruleset);
      outcome = await github().openFixPullRequest({
        repository: download.repository,
        commitSha: download.commitSha,
        base,
        branch: fixPullRequestBranch(run.runId, download.repository),
        title: fixPullRequestTitle(run.jobName),
        body: fixPullRequestBody(run, result.explanation, others),
        sections: part.sections.map((s) => ({
          oldPath: s.oldPath,
          newPath: s.newPath,
          text: s.text,
          ...(isCopySection(s.text) ? { copy: true } : {}),
        })),
        apply: applySection,
      });
    } catch (error) {
      // GitHubAppError messages are built to hold no token; any other error text is not logged.
      console.error(`[ERROR] Debug it run ${run.runId}: the fix pull request could not be opened: ${errorText(error)}`);
      return refuse(502, FIX_PR_ERRORS.github);
    }
    if (outcome.status === 'refused') {
      return refuse(409, outcome.reason === 'not-a-file' ? FIX_PR_ERRORS.notAFile : FIX_PR_ERRORS.doesNotApply);
    }

    const entry: FixPullRequestEntry = { repository: download.repository, url: outcome.url };
    opened.set(lockKey, outcome.url);
    const recorded = await record(run.runId, entry);
    // Once the record holds the entry, the record answers later clicks.
    if (recorded !== 'failed') opened.delete(lockKey);
    // A pull request GitHub already had was counted when it was opened.
    if (outcome.existing) return { status: 200, body: { ...entry, existing: true } };
    if (recorded !== 'present') await count(run.runId, run.usageKey);
    console.log(
      `[AUDIT] Debug it run ${run.runId} opened fix pull request ${outcome.url} in ${download.repository} for GitHub user ${user.githubUserId}`,
    );
    return { status: 201, body: entry };
  }

  return {
    async open(run, repository, user) {
      if (run.requester?.githubUserId !== user.githubUserId) return refuse(403, FIX_PR_ERRORS.notRequester);
      if (readRunResult(run.result) === null) return refuse(409, FIX_PR_ERRORS.noResult);
      const key = `${run.runId}:${repository.toLowerCase()}`;
      return withLock(key, () => openLocked(run, repository, user, key));
    },
  };
}

let singleton: FixPullRequestService | undefined;

/** The fix pull request service of this process, over getS3Store(), getGitHubApp() and debugItConfig. */
export function getFixPullRequestService(env: Env = process.env): FixPullRequestService {
  if (singleton) return singleton;
  singleton = createFixPullRequestService({
    store: () => getS3Store(env),
    githubApp: () => getGitHubApp(env),
    config: debugItConfig,
  });
  return singleton;
}

/** Test helper: forget the process-wide fix pull request service. */
export function resetFixPullRequestService(): void {
  singleton = undefined;
}
