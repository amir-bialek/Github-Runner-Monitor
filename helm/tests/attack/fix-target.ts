// Story 7.2 (SR14): where would Open a PR send the fix of a captured result?
// Validates the result with the backend's own result schema, then runs the
// backend's own createFixPullRequestService over a run record of the
// inject-target scenario (failing repository acme/payments-api on branch
// RUN_BRANCH, extra repository acme/billing-api), with an in-memory store and
// a recording fake GitHub App. Opens the fix for every downloaded repository,
// as if the requester clicked Open a PR for each, and prints what the service
// asked GitHub for, as JSON on stdout. Nothing reaches GitHub.
//
//   cd code/backend && npm ci     (once: the backend runs under tsx)
//   node helm/tests/attack/fix-target.ts <result.json> [runId]
//
// Output: { valid, errors, causeLocation, patchEmpty, runBranch, rulesetChecks,
// openFixPullRequest: [{ repository, base, branch, commitSha }], outcomes }.
// The backend's own log lines go to stderr.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUN_BRANCH = 'feature/refund-fee';
const DEFAULT_RUN_ID = 'a77ac000-0000-4000-8000-000000000014';
const REPOSITORY = 'acme/payments-api';
const EXTRA = 'acme/billing-api';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const EXTRA_SHA = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const USER = { githubUserId: 1000001, login: 'dana' };

const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, '../../../code/backend');
const schemaPath = resolve(here, '../../../code/debug-job/schema/result.v1.json');

const [resultFile, runIdArg] = process.argv.slice(2);
if (!resultFile) {
  console.error('usage: node fix-target.ts <result.json> [runId]');
  process.exit(2);
}
const runId = runIdArg ?? DEFAULT_RUN_ID;

// The backend is written for tsx (extensionless imports, parameter
// properties), so load it through the backend's own tsx.
const requireBackend = createRequire(resolve(backend, 'package.json'));
let tsImport: (specifier: string, parent: string) => Promise<any>;
try {
  ({ tsImport } = await import(pathToFileURL(requireBackend.resolve('tsx/esm/api')).href));
} catch {
  console.error('fix-target: tsx not found; run npm ci in code/backend first');
  process.exit(2);
}
const load = (path: string) => tsImport(pathToFileURL(resolve(backend, path)).href, import.meta.url);

// The service's [AUDIT]/[ERROR] lines must not mix with the JSON answer.
const print = console.log.bind(console);
console.log = console.error.bind(console);

const { createResultValidator, loadResultSchema } = await load('src/services/debugIt/resultSchema.ts');
const { createFixPullRequestService } = await load('src/services/debugIt/fixPullRequest.ts');
const { createMemoryS3Client, createS3Store } = await load('src/adapters/s3Store.ts');
const { createMockGitHubApp } = await load('src/adapters/githubApp.ts');
const { DEBUG_IT_DEFAULTS } = await load('src/services/debugItConfig.ts');

const raw = readFileSync(resultFile);
const outcome = createResultValidator(loadResultSchema(schemaPath))(raw);
const result = outcome.ok ? outcome.result : null;

const rulesetChecks: string[] = [];
const opened: Array<{ repository: string; base: string | null; branch: string; commitSha: string }> = [];
const outcomes: Array<{ repository: string; status: number; error?: string }> = [];

if (result !== null) {
  const usageKey = `usage/2026-11/${USER.githubUserId}.json`;
  const record = {
    runId,
    target: { kind: 'job', id: 900001 },
    requester: USER,
    state: 'finished',
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:10:00.000Z',
    repository: REPOSITORY,
    headRepository: REPOSITORY,
    headSha: SHA,
    branch: RUN_BRANCH,
    jobName: 'test',
    downloads: [
      { repository: REPOSITORY, commitSha: SHA, folder: 'payments-api' },
      { repository: EXTRA, commitSha: EXTRA_SHA, folder: 'billing-api' },
    ],
    usageKey,
    resultCodeHash: 'f'.repeat(64),
    result,
    feedback: null,
    fixPullRequests: [],
    failureReason: null,
  };
  const store = createS3Store({ bucket: 'acme-attack-test', client: createMemoryS3Client() });
  await store.create(`runs/${runId}.json`, record);
  await store.create(usageKey, { entries: [{ runId, costUsd: 0.1, fixPullRequests: 0 }] });
  const mock = createMockGitHubApp();
  const githubApp = {
    ...mock,
    async checkRuleset(repository: string) {
      rulesetChecks.push(repository);
      return { protected: true };
    },
    async openFixPullRequest(input: { repository: string; base: string | null; branch: string; commitSha: string }) {
      opened.push({ repository: input.repository, base: input.base, branch: input.branch, commitSha: input.commitSha });
      return { status: 'opened', url: `https://github.com/${input.repository}/pull/1`, number: 1, existing: false };
    },
  };
  const service = createFixPullRequestService({ store, githubApp, config: DEBUG_IT_DEFAULTS });
  for (const repository of [REPOSITORY, EXTRA]) {
    const answer = await service.open(record, repository, USER);
    outcomes.push({ repository, status: answer.status, ...(answer.body.error ? { error: answer.body.error } : {}) });
  }
}

print(
  JSON.stringify(
    {
      valid: outcome.ok,
      errors: outcome.ok ? [] : outcome.errors,
      causeLocation: result?.causeLocation ?? null,
      patchEmpty: result === null ? null : result.patch === '',
      runBranch: RUN_BRANCH,
      rulesetChecks,
      openFixPullRequest: opened,
      outcomes,
    },
    null,
    2,
  ),
);
