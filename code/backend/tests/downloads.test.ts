import http from 'http';
import type { AddressInfo } from 'net';
import { PassThrough, Readable } from 'stream';
import { gzipSync } from 'zlib';
import { createMemoryS3Client, createS3Store, type S3Store } from '../src/adapters/s3Store';
import { createGitHubApp, GitHubAppError, type AppAuth, type FetchLike, type GitHubApp } from '../src/adapters/githubApp';
import { createDownloadStep, DEFAULT_DOWNLOAD_LIMIT_BYTES, DOWNLOAD_ERRORS } from '../src/services/debugIt/downloads';
import { createHttpUploader, UploadError } from '../src/services/debugIt/upload';
import { createSettingsService } from '../src/services/debugIt/settings';
import type { RunRecord } from '../src/services/debugIt/runs';

const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHARED_SHA = 'c'.repeat(40);
const UPLOAD_CODE = 'fake-upload-code-666';
const INSTALLATION_TOKEN = 'fake-installation-token-333';
const APP_JWT = 'fake-app-jwt-111';
const CODELOAD_TOKEN = 'fake-codeload-token-555';
const LOG_SIGNATURE = 'fake-log-signature-444';
const SECRETS = [UPLOAD_CODE, INSTALLATION_TOKEN, APP_JWT, CODELOAD_TOKEN, LOG_SIGNATURE];
const SECRETS_BUT_CODE = SECRETS.filter((s) => s !== UPLOAD_CODE);

const CONTEXT_FILE = `# Debug context for acme/payments-api

## About this repo

payments-api takes card payments for the invented acme shop.

## Common failures

- Integration tests time out while Postgres starts.

## Extra repositories

- shared-config  the configuration package
- billing  not on the allowed list
- ledger  the requester cannot read it
- other-org/x  outside the organization
`;

// ---------------------------------------------------------------------------
// Fixtures: a tiny gzip tarball

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

function tarball(top: string, files: Record<string, string>): Buffer {
  const parts = [tarHeader(`${top}/`, 0, '5')];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    parts.push(tarHeader(`${top}/${name}`, data.length, '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const PAYMENTS_TAR = tarball('acme-payments-api-a1b2c3d', { 'package.json': '{"name":"payments-api"}\n' });
const SHARED_TAR = tarball('acme-shared-config-ccccccc', { 'config.json': '{"region":"invented"}\n' });

// ---------------------------------------------------------------------------
// A fake receiver: a real http server recording URL, headers and bodies.

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface Receiver {
  baseUrl: string;
  requests: Received[];
  /** Status per path; 200 when unset. */
  status: Map<string, number>;
  /** Called with each body chunk as it arrives. */
  onData: (path: string, chunk: Buffer) => void;
  close(): Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const requests: Received[] = [];
  const status = new Map<string, number>();
  const receiver = {} as Receiver;
  receiver.onData = () => undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    const path = req.url ?? '';
    const code = status.get(path) ?? 200;
    if (code !== 200) {
      // Refuse early, as the real receiver does on a size limit.
      res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end('{"error":"refused"}');
      requests.push({ method: req.method ?? '', url: path, headers: req.headers, body: Buffer.alloc(0) });
      req.resume();
      return;
    }
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      receiver.onData(path, chunk);
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: path, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  Object.assign(receiver, {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    status,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return receiver;
}

// ---------------------------------------------------------------------------
// A real adapter over fake auth and fetch, with GitHub's redirects.

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function streamOf(...parts: Buffer[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new Uint8Array(part));
      controller.close();
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

const LOG_HOST = `https://results-receiver.actions.githubusercontent.com/job/900001?sig=${LOG_SIGNATURE}`;
const codeload = (repo: string, sha: string) =>
  `https://codeload.github.com/acme/${repo}/legacy.tar.gz/${sha}?token=${CODELOAD_TOKEN}`;

function permission(role: string): Route {
  return () => json({ role_name: role, permission: role, user: { id: 1000001 } });
}

function githubRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  const contextContent = Buffer.from(CONTEXT_FILE).toString('base64');
  return {
    '/orgs/acme/installation': () => json({ id: 4242, permissions: {} }),
    '/repos/acme/payments-api/contents/.github/claude-debug-context.md': () =>
      json({ type: 'file', size: CONTEXT_FILE.length, encoding: 'base64', content: contextContent }),
    '/repos/acme/payments-api/actions/jobs/900001/logs': () => redirect(LOG_HOST),
    [LOG_HOST]: () => new Response(streamOf(Buffer.from('Run npm test\nError: invented failure\n'))),
    '/repos/acme/shared-config/collaborators/dana/permission': permission('read'),
    '/repos/acme/ledger/collaborators/dana/permission': permission('none'),
    [`/repos/acme/payments-api/commits/${SHA}`]: () => new Response(SHA),
    [`/repos/acme/payments-api/tarball/${SHA}`]: () => redirect(codeload('payments-api', SHA)),
    [codeload('payments-api', SHA)]: () => new Response(streamOf(PAYMENTS_TAR)),
    '/repos/acme/shared-config/commits/HEAD': () => new Response(SHARED_SHA),
    [`/repos/acme/shared-config/tarball/${SHARED_SHA}`]: () => redirect(codeload('shared-config', SHARED_SHA)),
    [codeload('shared-config', SHARED_SHA)]: () => new Response(streamOf(SHARED_TAR)),
    ...overrides,
  };
}

function realGitHub(routes: Record<string, Route>) {
  const auth: AppAuth = async (options) => (options.type === 'app' ? { token: APP_JWT } : { token: INSTALLATION_TOKEN });
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    const route = routes[url.replace('https://api.github.com', '')];
    if (!route) throw new Error(`unexpected request ${url}`);
    return route(url, init);
  };
  const app = createGitHubApp({
    appId: '1',
    privateKey: 'fake-private-key',
    clientId: 'Iv1.acme',
    clientSecret: 'fake-client-secret',
    organization: 'acme',
    auth,
    fetch,
  });
  return { app, requests };
}

// ---------------------------------------------------------------------------

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: RUN_ID,
    target: { kind: 'job', id: 900001 },
    requester: { githubUserId: 1000001, login: 'dana' },
    state: 'cloning',
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:05.000Z',
    repository: 'acme/payments-api',
    headRepository: 'acme/payments-api',
    headSha: SHA,
    branch: 'main',
    jobName: 'test',
    downloads: [],
    usageKey: 'usage/2026-11/1000001.json',
    resultCodeHash: null,
    result: null,
    feedback: null,
    fixPullRequests: [],
    failureReason: null,
    ...overrides,
  };
}

interface Setup {
  github?: Pick<GitHubApp, 'readLog' | 'readWorkflowRun' | 'readContextFile' | 'checkPermission' | 'downloadTarball'>;
  routes?: Record<string, Route>;
  record?: RunRecord | null;
  allowed?: string[];
  logLimitBytes?: number;
  downloadLimitBytes?: number;
}

let receiver: Receiver;

beforeEach(async () => {
  log.mockClear();
  error.mockClear();
  receiver = await startReceiver();
});

afterEach(async () => {
  await receiver.close();
});

async function setup(options: Setup = {}) {
  const store: S3Store = createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() });
  if (options.record !== null) await store.create(`runs/${RUN_ID}.json`, options.record ?? record());
  const real = realGitHub(options.routes ?? githubRoutes());
  const github = options.github ?? real.app;
  const settings = createSettingsService({
    store: createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() }),
    config: {
      administrators: [],
      allowedUsers: [],
      allowedRepositories: options.allowed ?? ['acme/payments-api', 'acme/shared-config', 'acme/ledger'],
    },
  });
  const step = createDownloadStep({
    store,
    githubApp: github,
    settings,
    organization: 'acme',
    logLimitBytes: options.logLimitBytes ?? 2097152,
    ...(options.downloadLimitBytes !== undefined ? { downloadLimitBytes: options.downloadLimitBytes } : {}),
  });
  const target = { baseUrl: receiver.baseUrl, uploadCode: UPLOAD_CODE };
  const stored = async () => (await store.read<RunRecord>(`runs/${RUN_ID}.json`))?.value ?? null;
  return { step, store, target, stored, githubRequests: real.requests };
}

function allLogs(): string {
  return [...log.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

// Every request the receiver saw carries only the upload code, and no GitHub secret anywhere.
function expectOnlyUploadCode(): void {
  for (const r of receiver.requests) {
    expect(r.headers.authorization).toBe(`Bearer ${UPLOAD_CODE}`);
    const text = `${r.url}\n${JSON.stringify(r.headers)}\n${r.body.toString('latin1')}`;
    for (const secret of SECRETS_BUT_CODE) expect(text).not.toContain(secret);
    expect(text).not.toContain('codeload');
    const allowedHeaders = new Set(['authorization', 'content-type', 'content-length', 'transfer-encoding', 'host', 'connection']);
    for (const name of Object.keys(r.headers)) expect(allowedHeaders.has(name)).toBe(true);
  }
  const logs = allLogs();
  for (const secret of SECRETS) expect(logs).not.toContain(secret);
}

function paths(): string[] {
  return receiver.requests.map((r) => `${r.method} ${r.url}`);
}

function fakeGitHub(overrides: Partial<NonNullable<Setup['github']>> = {}): NonNullable<Setup['github']> {
  const { app } = realGitHub(githubRoutes());
  return {
    readContextFile: app.readContextFile,
    checkPermission: app.checkPermission,
    readWorkflowRun: jest.fn(async () => {
      throw new GitHubAppError('not used');
    }),
    readLog: jest.fn(async () => ({ text: Buffer.from('log\n'), truncated: false })),
    downloadTarball: jest.fn(async (repository: string) => ({
      commitSha: repository === 'acme/payments-api' ? SHA : SHARED_SHA,
      body: Readable.from([repository === 'acme/payments-api' ? PAYMENTS_TAR : SHARED_TAR]),
    })),
    ...overrides,
  };
}

describe('fetchRunInputs', () => {
  test('job without extras: log, failing repository and done reach the receiver; the record lists the download', async () => {
    const routes = githubRoutes({
      '/repos/acme/payments-api/contents/.github/claude-debug-context.md': () =>
        json({ type: 'file', size: 30, encoding: 'base64', content: Buffer.from('## About this repo\n\nInvented.\n').toString('base64') }),
    });
    const { step, target, stored } = await setup({ routes });
    const outcome = await step.fetchRunInputs(RUN_ID, target);
    expect(outcome).toEqual({
      ok: true,
      downloads: [{ repository: 'acme/payments-api', commitSha: SHA, folder: 'payments-api' }],
      skippedRepositories: [],
      logTruncated: false,
    });
    expect(paths()).toEqual(['PUT /upload/log', 'PUT /upload/repo/payments-api', 'POST /upload/done']);
    const [logReq, repoReq, doneReq] = receiver.requests;
    expect(logReq!.body.toString()).toBe('Run npm test\nError: invented failure\n');
    expect(logReq!.headers['content-type']).toMatch(/^text\/plain/);
    expect(repoReq!.headers['content-type']).toBe('application/gzip');
    expect(repoReq!.body.equals(PAYMENTS_TAR)).toBe(true);
    expect(doneReq!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(doneReq!.body.toString())).toEqual({ folders: ['payments-api'], logTruncated: false });
    const after = await stored();
    expect(after).toMatchObject({
      state: 'cloning',
      downloads: [{ repository: 'acme/payments-api', commitSha: SHA, folder: 'payments-api' }],
      skippedRepositories: [],
      logTruncated: false,
      updatedAt: '2026-11-05T10:00:05.000Z',
    });
    expectOnlyUploadCode();
    expect(JSON.stringify(after)).not.toContain(CODELOAD_TOKEN);
    expect(log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[INFO]'))).toHaveLength(1);
  });

  test('extras: allowed and readable downloaded at its default branch; others skipped with reasons', async () => {
    const { step, target, stored, githubRequests } = await setup();
    const outcome = await step.fetchRunInputs(RUN_ID, target);
    expect(outcome).toEqual({
      ok: true,
      downloads: [
        { repository: 'acme/payments-api', commitSha: SHA, folder: 'payments-api' },
        { repository: 'acme/shared-config', commitSha: SHARED_SHA, folder: 'shared-config' },
      ],
      skippedRepositories: [
        { repository: 'other-org/x', reason: 'outside-organization' },
        { repository: 'acme/billing', reason: 'not-allowed' },
        { repository: 'acme/ledger', reason: 'no-read-access' },
      ],
      logTruncated: false,
    });
    expect(paths()).toEqual([
      'PUT /upload/log',
      'PUT /upload/repo/payments-api',
      'PUT /upload/repo/shared-config',
      'POST /upload/done',
    ]);
    expect(JSON.parse(receiver.requests[3]!.body.toString())).toEqual({
      folders: ['payments-api', 'shared-config'],
      logTruncated: false,
    });
    expect(receiver.requests[2]!.body.equals(SHARED_TAR)).toBe(true);
    const after = await stored();
    expect(after?.downloads.map((d) => d.repository)).toEqual(['acme/payments-api', 'acme/shared-config']);
    expect(after?.skippedRepositories).toEqual(outcome.ok ? outcome.skippedRepositories : null);
    // Redirect targets were fetched without the token.
    for (const r of githubRequests.filter((q) => !q.url.startsWith('https://api.github.com'))) {
      expect(JSON.stringify(r.init?.headers)).not.toContain(INSTALLATION_TOKEN);
    }
    expectOnlyUploadCode();
  });

  test('a permission check error skips the extra as no-read-access', async () => {
    const routes = githubRoutes({ '/repos/acme/shared-config/collaborators/dana/permission': () => json({}, 500) });
    const { step, target } = await setup({ routes });
    const outcome = await step.fetchRunInputs(RUN_ID, target);
    expect(outcome.ok && outcome.skippedRepositories).toContainEqual({ repository: 'acme/shared-config', reason: 'no-read-access' });
    expect(paths()).toEqual(['PUT /upload/log', 'PUT /upload/repo/payments-api', 'POST /upload/done']);
  });

  test('run without jobs: log.txt holds the workflow file', async () => {
    const github = fakeGitHub({
      readWorkflowRun: jest.fn(async (_r: string, id: number) => ({
        id,
        headRepository: 'acme/payments-api',
        headSha: SHA,
        headBranch: 'main',
        path: '.github/workflows/ci.yml',
        workflowFile: { path: '.github/workflows/ci.yml', text: 'name: CI\non: [push]\n' },
        errorMessage: null,
      })),
    });
    const { step, target } = await setup({ github, record: record({ target: { kind: 'run', id: 810001 } }) });
    const outcome = await step.fetchRunInputs(RUN_ID, target);
    expect(outcome.ok).toBe(true);
    expect(github.readWorkflowRun).toHaveBeenCalledWith('acme/payments-api', 810001, { workflowFile: true });
    expect(github.readLog).not.toHaveBeenCalled();
    expect(receiver.requests[0]!.body.toString()).toBe('Workflow file: .github/workflows/ci.yml\n\nname: CI\non: [push]\n');
  });

  test('run without jobs with an error message appends it', async () => {
    const github = fakeGitHub({
      readWorkflowRun: jest.fn(async (_r: string, id: number) => ({
        id,
        headRepository: null,
        headSha: SHA,
        headBranch: null,
        path: '.github/workflows/ci.yml',
        workflowFile: { path: '.github/workflows/ci.yml', text: 'name: CI\n' },
        errorMessage: 'Invalid workflow file',
      })),
    });
    const { step, target } = await setup({ github, record: record({ target: { kind: 'run', id: 810001 } }) });
    await step.fetchRunInputs(RUN_ID, target);
    expect(receiver.requests[0]!.body.toString()).toBe(
      "Workflow file: .github/workflows/ci.yml\n\nname: CI\n\n\nGitHub's error message:\nInvalid workflow file",
    );
  });

  test('run without jobs and no workflow file: fail, nothing uploaded', async () => {
    const github = fakeGitHub({
      readWorkflowRun: jest.fn(async (_r: string, id: number) => ({
        id,
        headRepository: null,
        headSha: SHA,
        headBranch: null,
        path: null,
        workflowFile: null,
        errorMessage: null,
      })),
    });
    const { step, target } = await setup({ github, record: record({ target: { kind: 'run', id: 810001 } }) });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.workflowFile });
    expect(receiver.requests).toHaveLength(0);
  });

  test('big log: the tail under the limit, starting at a line, logTruncated in done and record', async () => {
    const line = 'x'.repeat(99) + '\n';
    const big = Buffer.from(line.repeat(30000)); // 3 MB
    const routes = githubRoutes({ [LOG_HOST]: () => new Response(streamOf(big)) });
    const limit = 2 * 1024 * 1024;
    const { step, target, stored } = await setup({ routes, logLimitBytes: limit });
    const outcome = await step.fetchRunInputs(RUN_ID, target);
    expect(outcome.ok && outcome.logTruncated).toBe(true);
    const sent = receiver.requests[0]!.body;
    expect(sent.length).toBeLessThanOrEqual(limit);
    expect(sent.length).toBeGreaterThan(limit - 100);
    expect(sent.toString().startsWith('x'.repeat(99) + '\n')).toBe(true);
    expect(JSON.parse(receiver.requests[receiver.requests.length - 1]!.body.toString()).logTruncated).toBe(true);
    expect((await stored())?.logTruncated).toBe(true);
  });

  test.each([
    ['tarball 500', { [`/repos/acme/payments-api/tarball/${SHA}`]: () => json({ message: 'boom' }, 500) }],
    ['commit 404', { [`/repos/acme/payments-api/commits/${SHA}`]: () => json({ message: 'Not Found' }, 404) }],
  ])('download error (%s): fail, no done', async (_name, override) => {
    const { step, target } = await setup({ routes: githubRoutes(override) });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.download });
    expect(paths()).toEqual(['PUT /upload/log']);
    const errors = error.mock.calls.map((a) => a.join(' '));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`[ERROR] Debug it run ${RUN_ID}`);
    expect(errors[0]).not.toContain('boom');
    expectOnlyUploadCode();
  });

  test('over the size limit summed across repositories: stream stopped, fail, no done', async () => {
    const limit = PAYMENTS_TAR.length + Math.floor(SHARED_TAR.length / 2);
    const { step, target, stored } = await setup({ downloadLimitBytes: limit });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.tooLarge(limit) });
    expect(paths()).not.toContain('POST /upload/done');
    expect(paths()).toContain('PUT /upload/repo/payments-api');
    // The second download was recorded before its upload started.
    expect((await stored())?.downloads.map((d) => d.folder)).toEqual(['payments-api', 'shared-config']);
  });

  test('the default size limit is 500 MB', () => {
    expect(DEFAULT_DOWNLOAD_LIMIT_BYTES).toBe(524288000);
  });

  test('receiver refuses the repository with 413: fail', async () => {
    receiver.status.set('/upload/repo/payments-api', 413);
    const { step, target } = await setup();
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.upload });
    expect(paths()).not.toContain('POST /upload/done');
  });

  test('receiver refuses the log: fail before any download', async () => {
    receiver.status.set('/upload/log', 503);
    const github = fakeGitHub();
    const { step, target } = await setup({ github });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.upload });
    expect(github.downloadTarball).not.toHaveBeenCalled();
  });

  test.each([
    ['waiting', record({ state: 'waiting' }), DOWNLOAD_ERRORS.notCloning],
    ['missing', null, DOWNLOAD_ERRORS.runNotFound],
  ])('not cloning (%s): fail, nothing uploaded', async (_name, start, reason) => {
    const github = fakeGitHub();
    const { step, target } = await setup({ github, record: start });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason });
    expect(receiver.requests).toHaveLength(0);
    expect(github.readLog).not.toHaveBeenCalled();
  });

  test('a run that leaves cloning mid-way stops before its next upload', async () => {
    let store: S3Store | undefined;
    const github = fakeGitHub({
      downloadTarball: jest.fn(async () => {
        // The lifecycle fails the run while GitHub answers.
        await store!.modify<RunRecord>(`runs/${RUN_ID}.json`, (c) => (c ? { ...c, state: 'failed' } : undefined));
        return { commitSha: SHA, body: Readable.from([PAYMENTS_TAR]) };
      }),
    });
    const built = await setup({ github });
    store = built.store;
    expect(await built.step.fetchRunInputs(RUN_ID, built.target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.notCloning });
    expect(paths()).toEqual(['PUT /upload/log']);
    expect((await built.stored())?.downloads).toEqual([]);
  });

  test('no failed commit: fail, nothing uploaded', async () => {
    const { step, target } = await setup({ record: record({ headSha: null }) });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.noCommit });
    expect(receiver.requests).toHaveLength(0);
  });

  test('a context file that is gone: fail', async () => {
    const routes = githubRoutes({
      '/repos/acme/payments-api/contents/.github/claude-debug-context.md': () => json({ message: 'Not Found' }, 404),
    });
    const { step, target } = await setup({ routes });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.contextFile });
    expect(receiver.requests).toHaveLength(0);
  });

  test('a log GitHub cannot give: fail', async () => {
    const routes = githubRoutes({ '/repos/acme/payments-api/actions/jobs/900001/logs': () => json({}, 410) });
    const { step, target } = await setup({ routes });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.log });
  });

  test('a slow tarball is streamed, not buffered whole', async () => {
    const source = new PassThrough();
    const first = PAYMENTS_TAR.subarray(0, 100);
    const rest = PAYMENTS_TAR.subarray(100);
    let receivedBeforeEnd = false;
    receiver.onData = (path) => {
      if (path === '/upload/repo/payments-api' && !receivedBeforeEnd) {
        receivedBeforeEnd = true;
        // Only now does the source finish.
        source.end(rest);
      }
    };
    const github = fakeGitHub({
      downloadTarball: jest.fn(async () => {
        setImmediate(() => source.write(first));
        return { commitSha: SHA, body: source };
      }),
    });
    const routes = githubRoutes({
      '/repos/acme/payments-api/contents/.github/claude-debug-context.md': () =>
        json({ type: 'file', size: 20, encoding: 'base64', content: Buffer.from('## About this repo\nx\n').toString('base64') }),
    });
    const { app } = realGitHub(routes);
    github.readContextFile = app.readContextFile;
    const { step, target } = await setup({ github });
    const outcome = await step.fetchRunInputs(RUN_ID, target);
    expect(outcome.ok).toBe(true);
    expect(receivedBeforeEnd).toBe(true);
    expect(receiver.requests[1]!.body.equals(PAYMENTS_TAR)).toBe(true);
  });

  test('a tarball source that errors after streaming started: fail, no done, one error line', async () => {
    const source = new PassThrough();
    const github = fakeGitHub({
      downloadTarball: jest.fn(async () => {
        setImmediate(() => {
          source.write(PAYMENTS_TAR.subarray(0, 50));
          setImmediate(() => source.destroy(new Error('reset')));
        });
        return { commitSha: SHA, body: source };
      }),
    });
    const { step, target } = await setup({ github });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.download });
    expect(paths()).not.toContain('POST /upload/done');
    const errors = error.mock.calls.map((a) => a.join(' '));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`[ERROR] Debug it run ${RUN_ID}`);
    expect(errors[0]).not.toContain('reset');
  });

  test('a branch-shaped headSha fails without any download', async () => {
    const github = fakeGitHub();
    const { step, target } = await setup({ github, record: record({ headSha: 'main' }) });
    expect(await step.fetchRunInputs(RUN_ID, target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.noCommit });
    expect(github.downloadTarball).not.toHaveBeenCalled();
    expect(receiver.requests).toHaveLength(0);
  });

  test('run without jobs with a long workflow file keeps the header and cuts only the file', async () => {
    const fileText = 'y'.repeat(500);
    const github = fakeGitHub({
      readWorkflowRun: jest.fn(async (_r: string, id: number) => ({
        id,
        headRepository: null,
        headSha: SHA,
        headBranch: null,
        path: '.github/workflows/ci.yml',
        workflowFile: { path: '.github/workflows/ci.yml', text: fileText },
        errorMessage: 'Invalid workflow file',
      })),
    });
    const { step, target } = await setup({ github, record: record({ target: { kind: 'run', id: 810001 } }), logLimitBytes: 200 });
    const outcome = await step.fetchRunInputs(RUN_ID, target);
    expect(outcome.ok && outcome.logTruncated).toBe(true);
    const sent = receiver.requests[0]!.body.toString();
    expect(sent.length).toBe(200);
    expect(sent.startsWith('Workflow file: .github/workflows/ci.yml\n\ny')).toBe(true);
    expect(sent.endsWith("\n\nGitHub's error message:\nInvalid workflow file")).toBe(true);
  });

  test('the size limit sentence names MiB', () => {
    expect(DOWNLOAD_ERRORS.tooLarge(DEFAULT_DOWNLOAD_LIMIT_BYTES)).toContain('500 MiB');
  });

  test('a run ID that is not a UUID fails without any read', async () => {
    const github = fakeGitHub();
    const { step, target } = await setup({ github });
    expect(await step.fetchRunInputs('../settings', target)).toEqual({ ok: false, reason: DOWNLOAD_ERRORS.runNotFound });
    expect(github.readLog).not.toHaveBeenCalled();
  });
});

describe('createHttpUploader', () => {
  test('a refused request rejects with an UploadError holding only the status', async () => {
    receiver.status.set('/upload/done', 400);
    const error = await createHttpUploader()
      .done({ baseUrl: receiver.baseUrl, uploadCode: UPLOAD_CODE }, { folders: [], logTruncated: false })
      .catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error.status).toBe(400);
    expect(error.message).not.toContain(UPLOAD_CODE);
    expect(error.message).not.toContain(receiver.baseUrl);
  });

  test('an unreachable receiver rejects with an UploadError without status', async () => {
    const baseUrl = receiver.baseUrl;
    await receiver.close();
    receiver = await startReceiver();
    const error = await createHttpUploader().putLog({ baseUrl, uploadCode: UPLOAD_CODE }, 'x').catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error.status).toBeNull();
  });

  test('a folder the receiver would refuse is not sent', async () => {
    const body = Readable.from([Buffer.from('x')]);
    const error = await createHttpUploader()
      .putRepo({ baseUrl: receiver.baseUrl, uploadCode: UPLOAD_CODE }, '..', body)
      .catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(receiver.requests).toHaveLength(0);
  });
});
