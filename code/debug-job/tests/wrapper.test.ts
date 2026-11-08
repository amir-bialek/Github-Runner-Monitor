import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createResultValidator, loadResultSchema } from '../../backend/src/services/debugIt/resultSchema';
import {
  buildPrompt,
  buildResult,
  buildSettings,
  checkIsolation,
  claudeArgs,
  CONFIG_ERROR,
  defaultProbes,
  DUMMY_API_KEY,
  extractAnswer,
  FALLBACK_EXPLANATIONS,
  FIXED_DENY,
  formatBudget,
  MAX_BODY_BYTES,
  parseClaudeOutput,
  parseClaudeStream,
  toolCallsLine,
  parseConfig,
  PATCH_LEFT_OUT,
  readManifest,
  runWrapper,
  validCause,
} from '../src/wrapper.ts';
import type { Probes, WrapperOptions } from '../src/wrapper.ts';

const RUN_ID = '3f1c2b7a-9d4e-4a5b-8c6d-0e1f2a3b4c5d';
const RESULT_CODE = 'invented-result-code-5b8e1d';
const SCHEMA_PATH = resolve(__dirname, '../schema/result.v1.json');
const FAKE = resolve(__dirname, 'fakeClaude.cjs');
const validate = createResultValidator(loadResultSchema(SCHEMA_PATH));

const APP_TS = "import { start } from './server';\n\nconst port = '3000';\nstart(port);\n";
const CONTEXT = '# About this repo\n\nPayments API for acme. Owners: the payments team.\n';
const LOG = 'Error: invented-log-marker type string is not assignable to number\n';

interface Posted {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let root: string;
let workDir: string;
let stateDir: string;
let captureFile: string;
let results: Server;
let resultsPort: number;
let posted: Posted[];
let statuses: number[];
let closedTcpPort: number;
let silentUdpPort: number;

function listen(server: Server): Promise<number> {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}

function freeTcpPort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

function freeUdpPort(): Promise<number> {
  return new Promise((done) => {
    const socket = createSocket('udp4');
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => done(port));
    });
  });
}

function write(path: string, text: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function silentProbes(): Probes {
  return {
    tcp: [{ host: '127.0.0.1', port: closedTcpPort }],
    dns: [{ host: '127.0.0.1', port: silentUdpPort }],
    dnsName: 'github.com',
  };
}

function options(mode: string, overrides: Partial<WrapperOptions> = {}): WrapperOptions {
  return {
    runId: RUN_ID,
    resultsUrl: `http://127.0.0.1:${resultsPort}`,
    deadlineAt: Date.now() + 120_000,
    budgetUsd: 1.9,
    resultCode: RESULT_CODE,
    workDir,
    stateDir,
    keyHelperPort: 8081,
    path: process.env.PATH ?? '',
    rootEntries: ['bin', 'etc', 'work', 'wrapper', 'usr', 'lost+found'],
    probes: silentProbes(),
    claude: { file: process.execPath, args: [FAKE, captureFile, mode] },
    probeTimeoutMs: 500,
    retryInitialMs: 20,
    retryMaxMs: 50,
    ...overrides,
  };
}

function capture(): { argv: string[]; stdin: string; cwd: string; env: Record<string, string> } {
  return JSON.parse(readFileSync(captureFile, 'utf8')) as { argv: string[]; stdin: string; cwd: string; env: Record<string, string> };
}

function onlyResult(): Record<string, unknown> {
  expect(posted).toHaveLength(1);
  const body = posted[0]!.body;
  const outcome = validate(body);
  expect(outcome).toEqual(expect.objectContaining({ ok: true }));
  return JSON.parse(body) as Record<string, unknown>;
}

function consoleLines(): string[] {
  const mocks = [console.log, console.info, console.warn, console.error] as unknown as jest.Mock[];
  return mocks.flatMap((m) => m.mock.calls.map((call: unknown[]) => call.map(String).join(' ')));
}

beforeEach(async () => {
  jest.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'wrapper-test-'));
  workDir = join(root, 'work');
  stateDir = join(root, 'state');
  captureFile = join(root, 'capture.json');
  write(join(workDir, 'log.txt'), LOG);
  write(join(workDir, 'manifest.json'), JSON.stringify({ folders: ['payments-api', 'shared-actions'], logTruncated: false }));
  write(join(workDir, 'repos/payments-api/src/app.ts'), APP_TS);
  write(join(workDir, 'repos/payments-api/README.md'), '# payments-api\n');
  write(join(workDir, 'repos/payments-api/.github/claude-debug-context.md'), CONTEXT);
  write(join(workDir, 'repos/shared-actions/action.yml'), 'name: setup\n');

  posted = [];
  statuses = [];
  results = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      posted.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const status = statuses.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  resultsPort = await listen(results);
  closedTcpPort = await freeTcpPort();
  silentUdpPort = await freeUdpPort();
});

afterEach(async () => {
  await close(results);
  rmSync(root, { recursive: true, force: true });
});

describe('wrapper happy path', () => {
  it('runs claude with the fixed argv, env, cwd and settings and posts one schema-valid result', async () => {
    process.env.INVENTED_WRAPPER_ONLY = 'invented-env-marker';
    try {
      expect(await runWrapper(options('success'))).toBe(0);
    } finally {
      delete process.env.INVENTED_WRAPPER_ONLY;
    }
    const seen = capture();
    const settingsPath = join(stateDir, 'settings.json');
    expect(seen.argv).toEqual([
      '-p', '--restricted', '--strict-mcp-config',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--tools', 'Read,Grep,Glob,Edit',
      '--allowedTools', 'Read,Grep,Glob,Edit',
      '--permission-mode', 'dontAsk',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-budget-usd', '1.9',
      '--settings', settingsPath,
    ]);
    expect(seen.cwd).toBe(workDir);
    expect(seen.env).toEqual({
      PATH: process.env.PATH ?? '',
      HOME: join(stateDir, 'home'),
      CLAUDE_CONFIG_DIR: join(stateDir, 'home', '.claude'),
      TMPDIR: join(stateDir, 'tmp'),
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8081',
      ANTHROPIC_API_KEY: DUMMY_API_KEY,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    });
    expect(JSON.stringify(seen.env)).not.toContain(RESULT_CODE);
    expect(existsSync(join(stateDir, 'home', '.claude'))).toBe(true);
    expect(existsSync(join(stateDir, 'tmp'))).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(
      JSON.parse(buildSettings(workDir, ['bin', 'etc', 'work', 'wrapper', 'usr', 'lost+found'], [stateDir])),
    );
    expect(seen.stdin).toBe(
      buildPrompt({ workDir, manifest: { folders: ['payments-api', 'shared-actions'], logTruncated: false }, context: CONTEXT.trim() }),
    );

    expect(posted[0]!.url).toBe(`/results/${RUN_ID}`);
    expect(posted[0]!.headers.authorization).toBe(`Bearer ${RESULT_CODE}`);
    expect(posted[0]!.headers['content-type']).toBe('application/json');
    const result = onlyResult();
    expect(result).toEqual({
      schemaVersion: 1,
      explanation: 'The port was a string.',
      causeLocation: { kind: 'this-repository' },
      patch: [
        '--- a/payments-api/src/app.ts',
        '+++ b/payments-api/src/app.ts',
        '@@ -1,4 +1,4 @@',
        " import { start } from './server';",
        ' ',
        "-const port = '3000';",
        '+const port = 3000;',
        ' start(port);',
        '',
      ].join('\n'),
      costUsd: 0.4321,
      inputTokens: 123,
      outputTokens: 45,
      durationMs: expect.any(Number) as number,
      logTruncated: false,
      failureReason: 'none',
    });
    // The untouched copy is kept outside the work folder.
    expect(readFileSync(join(stateDir, 'pristine/payments-api/src/app.ts'), 'utf8')).toBe(APP_TS);
  });

  it('keeps a valid extra-repository cause and passes logTruncated through', async () => {
    write(join(workDir, 'manifest.json'), JSON.stringify({ folders: ['payments-api', 'shared-actions'], logTruncated: true }));
    expect(await runWrapper(options('extra'))).toBe(0);
    const result = onlyResult();
    expect(result.causeLocation).toEqual({ kind: 'extra-repository', repository: 'shared-actions' });
    expect(result.logTruncated).toBe(true);
    expect(result.patch).toBe('');
    expect(capture().stdin).toContain('only its last part');
  });

  it('uses plain prose as the explanation with cause unknown', async () => {
    expect(await runWrapper(options('prose'))).toBe(0);
    const result = onlyResult();
    expect(result.explanation).toBe('The runner ran out of disk. Ask the platform team to clean it.');
    expect(result.causeLocation).toEqual({ kind: 'unknown' });
    expect(result.failureReason).toBe('none');
  });

  it('reads the whole result text as JSON when there is no json block', async () => {
    expect(await runWrapper(options('plainjson'))).toBe(0);
    const result = onlyResult();
    expect(result.explanation).toBe('Whole text answer.');
    expect(result.causeLocation).toEqual({ kind: 'runner' });
  });

  it('drops an extra-repository cause naming a folder that was not downloaded', async () => {
    expect(await runWrapper(options('badcause'))).toBe(0);
    expect(onlyResult().causeLocation).toEqual({ kind: 'unknown' });
  });

  it('posts an empty patch when nothing was edited', async () => {
    expect(await runWrapper(options('noedit'))).toBe(0);
    const result = onlyResult();
    expect(result.patch).toBe('');
    expect(result.causeLocation).toEqual({ kind: 'infrastructure' });
  });

  it('uses /dev/null headers for added and deleted files', async () => {
    expect(await runWrapper(options('adddelete'))).toBe(0);
    expect(onlyResult().patch).toBe(
      [
        '--- a/payments-api/README.md',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-# payments-api',
        '--- /dev/null',
        '+++ b/payments-api/src/new.ts',
        '@@ -0,0 +1 @@',
        '+export const added = 1;',
        '',
      ].join('\n'),
    );
  });

  it('leaves out a patch that would push the body over the size limit', async () => {
    expect(await runWrapper(options('huge'))).toBe(0);
    const result = onlyResult();
    expect(result.patch).toBe('');
    expect(result.explanation).toBe(`Generated a large file.\n\n${PATCH_LEFT_OUT}`);
    expect(Buffer.byteLength(posted[0]!.body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });
});

describe('wrapper failures', () => {
  it('stops claude 60 s before the deadline and reports time-limit with the edits so far', async () => {
    const started = Date.now();
    expect(await runWrapper(options('sleep', { deadlineAt: Date.now() + 61_500 }))).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const result = onlyResult();
    expect(result.failureReason).toBe('time-limit');
    expect(result.explanation).toBe(FALLBACK_EXPLANATIONS['time-limit']);
    expect(result.patch).toContain("+const port = 3000;");
    expect(result.costUsd).toBe(0);
    expect(consoleLines()).toContain('wrapper: stopping claude before the deadline');
  }, 20_000);

  it('kills claude with SIGKILL when it ignores SIGTERM', async () => {
    const started = Date.now();
    expect(await runWrapper(options('stubborn', { deadlineAt: Date.now() + 61_500, killGraceMs: 300 }))).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(onlyResult().failureReason).toBe('time-limit');
  }, 20_000);

  it('reports spend-limit when claude hits its budget', async () => {
    expect(await runWrapper(options('budget'))).toBe(0);
    const result = onlyResult();
    expect(result.failureReason).toBe('spend-limit');
    expect(result.explanation).toBe(FALLBACK_EXPLANATIONS['spend-limit']);
    expect(result.costUsd).toBe(1.9);
  });

  it('reports error with a fixed explanation when claude exits 1 with garbage', async () => {
    expect(await runWrapper(options('error'))).toBe(0);
    const result = onlyResult();
    expect(result.failureReason).toBe('error');
    expect(result.explanation).toBe(FALLBACK_EXPLANATIONS.error);
    expect(result.causeLocation).toEqual({ kind: 'unknown' });
  });

  it('reports error but keeps the text when claude says is_error', async () => {
    expect(await runWrapper(options('iserror'))).toBe(0);
    const result = onlyResult();
    expect(result.failureReason).toBe('error');
    expect(result.explanation).toBe('Partial thoughts.');
  });

  it('reports error when the claude command cannot be started', async () => {
    expect(await runWrapper(options('success', { claude: { file: join(root, 'missing-claude'), args: [] } }))).toBe(0);
    expect(onlyResult().failureReason).toBe('error');
  });

  it('posts time-limit without starting claude when the early stop has already passed', async () => {
    expect(await runWrapper(options('success', { deadlineAt: Date.now() + 30_000 }))).toBe(0);
    expect(existsSync(captureFile)).toBe(false);
    const result = onlyResult();
    expect(result.failureReason).toBe('time-limit');
    expect(result.explanation).toBe(FALLBACK_EXPLANATIONS['time-limit']);
    expect(result.patch).toBe('');
    expect(consoleLines()).toContain('wrapper: no time left to start claude');
  });

  it('posts error without starting claude when its files cannot be prepared', async () => {
    writeFileSync(stateDir, 'not a folder');
    expect(await runWrapper(options('success'))).toBe(0);
    expect(existsSync(captureFile)).toBe(false);
    const result = onlyResult();
    expect(result.failureReason).toBe('error');
    expect(result.explanation).toBe(FALLBACK_EXPLANATIONS.error);
    expect(result.patch).toBe('');
    expect(consoleLines()).toContain('wrapper: could not prepare the files for claude');
  });

  it('exits 1 without starting claude when the manifest is missing', async () => {
    rmSync(join(workDir, 'manifest.json'));
    expect(await runWrapper(options('success'))).toBe(1);
    expect(existsSync(captureFile)).toBe(false);
    expect(posted).toHaveLength(0);
  });
});

describe('wrapper isolation check', () => {
  it('exits 2, never starts claude and posts nothing when a TCP target answers', async () => {
    const open = createServer();
    const openPort = await listen(open);
    try {
      const probes = silentProbes();
      probes.tcp.push({ host: '127.0.0.1', port: openPort });
      expect(await runWrapper(options('success', { probes }))).toBe(2);
    } finally {
      await close(open);
    }
    expect(existsSync(captureFile)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
    expect(posted).toHaveLength(0);
    expect(consoleLines()).toContain('wrapper: isolation check failed, not starting claude');
  });

  it('exits 2 when an outside DNS server answers, even with NXDOMAIN', async () => {
    const dns: Socket = createSocket('udp4');
    dns.on('message', (msg, rinfo) => {
      const reply = Buffer.from(msg);
      reply.writeUInt16BE(0x8183, 2); // response, NXDOMAIN
      dns.send(reply, rinfo.port, rinfo.address);
    });
    const port = await new Promise<number>((done) => dns.bind(0, '127.0.0.1', () => done(dns.address().port)));
    try {
      const probes = silentProbes();
      probes.dns.push({ host: '127.0.0.1', port });
      expect(await runWrapper(options('success', { probes }))).toBe(2);
    } finally {
      dns.close();
    }
    expect(existsSync(captureFile)).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it('passes when every target refuses or stays silent until the timeout', async () => {
    const silent: Socket = createSocket('udp4');
    const port = await new Promise<number>((done) => silent.bind(0, '127.0.0.1', () => done(silent.address().port)));
    try {
      const started = Date.now();
      const probes = silentProbes();
      probes.dns.push({ host: '127.0.0.1', port });
      expect(await checkIsolation(probes, 300)).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      silent.close();
    }
  });

  it('builds the default targets from the environment', () => {
    const probes = defaultProbes(
      { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '6443' },
      'http://github-runner-monitor-backend.acme.svc:3002',
      3001,
    );
    expect(probes.tcp).toEqual([
      { host: 'github.com', port: 443 },
      { host: 'api.github.com', port: 443 },
      { host: '169.254.169.254', port: 80 },
      { host: '10.96.0.1', port: 6443 },
      { host: 'github-runner-monitor-backend.acme.svc', port: 3001 },
    ]);
    expect(probes.dns).toEqual([
      { host: '1.1.1.1', port: 53 },
      { host: '8.8.8.8', port: 53 },
    ]);
    expect(probes.dnsName).toBe('github.com');
    expect(defaultProbes({}, 'http://[fd00::5]:3002', 3001).tcp.slice(3)).toEqual([
      { host: 'kubernetes.default.svc', port: 443 },
      { host: 'fd00::5', port: 3001 },
    ]);
  });
});

describe('wrapper posting', () => {
  it('retries 503 twice and then posts', async () => {
    statuses = [503, 503, 200];
    expect(await runWrapper(options('noedit'))).toBe(0);
    expect(posted).toHaveLength(3);
    expect(new Set(posted.map((p) => p.body)).size).toBe(1);
    expect(consoleLines().filter((l) => l === 'wrapper: result post failed, retrying')).toHaveLength(2);
  });

  it('retries 429', async () => {
    statuses = [429, 200];
    expect(await runWrapper(options('noedit'))).toBe(0);
    expect(posted).toHaveLength(2);
  });

  it('stops after one post on 401', async () => {
    statuses = [401, 200];
    expect(await runWrapper(options('noedit'))).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it('retries network errors until the deadline and then exits 1', async () => {
    const port = await freeTcpPort();
    const started = Date.now();
    const code = await runWrapper(
      options('noedit', { resultsUrl: `http://127.0.0.1:${port}/`, deadlineAt: Date.now() + 2500, earlyStopMs: 1500 }),
    );
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(consoleLines()).toContain('wrapper: deadline passed before the result was posted, exiting');
  }, 20_000);
});

describe('wrapper output', () => {
  it('prints only fixed wrapper lines even when claude echoes the prompt, log and env', async () => {
    const outSpy = jest.spyOn(process.stdout, 'write');
    const errSpy = jest.spyOn(process.stderr, 'write');
    process.env.INVENTED_WRAPPER_ONLY = 'invented-env-marker';
    try {
      expect(await runWrapper(options('leak'))).toBe(0);
    } finally {
      delete process.env.INVENTED_WRAPPER_ONLY;
    }
    const written = [...outSpy.mock.calls, ...errSpy.mock.calls].map((call) => String(call[0])).join('');
    outSpy.mockRestore();
    errSpy.mockRestore();
    const lines = consoleLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^wrapper: ([a-z ,]+|tool calls: Read=\d+ Grep=\d+ Glob=\d+ Edit=\d+ other=\d+)$/);
    const text = `${lines.join('\n')}\n${written}`;
    for (const value of [RESULT_CODE, 'invented-log-marker', 'invented-env-marker', 'payments-api', 'Payments API', DUMMY_API_KEY]) {
      expect(text).not.toContain(value);
    }
    // Claude's own output never becomes the explanation: it is not a JSON result.
    expect(onlyResult().failureReason).toBe('error');
  });
});

describe('wrapper tool call line', () => {
  it('counts the tool calls of the stream and takes the final result line', async () => {
    const outSpy = jest.spyOn(process.stdout, 'write');
    try {
      expect(await runWrapper(options('tools'))).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
    const lines = consoleLines();
    expect(lines.filter((l) => l.startsWith('wrapper: tool calls:'))).toEqual([
      'wrapper: tool calls: Read=3 Grep=1 Glob=1 Edit=1 other=2',
    ]);
    const text = `${lines.join('\n')}\n${outSpy.mock.calls.map((c) => String(c[0])).join('')}`;
    for (const value of ['Bash', 'invented-tool-name', 'invented-claude-text']) expect(text).not.toContain(value);
    const result = onlyResult();
    expect(result.failureReason).toBe('none');
    expect(result.explanation).toBe('The port was a string.');
    expect(result.costUsd).toBe(0.4321);
  });

  it('prints zero counts once when claude gives no stream', async () => {
    expect(await runWrapper(options('error'))).toBe(0);
    expect(consoleLines().filter((l) => l.startsWith('wrapper: tool calls:'))).toEqual([
      'wrapper: tool calls: Read=0 Grep=0 Glob=0 Edit=0 other=0',
    ]);
    expect(onlyResult().failureReason).toBe('error');
  });

  it('parses a stream: assistant tool_use only, the last result line wins', () => {
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep' }, { type: 'tool_use', name: 7 }] } },
      { type: 'user', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
      { type: 'result', result: 'first' },
      { type: 'result', result: 'second' },
    ].map((l) => JSON.stringify(l));
    const parsed = parseClaudeStream(`${lines.join('\r\n')}\n`);
    expect(parsed.toolCalls).toEqual({ Read: 0, Grep: 1, Glob: 0, Edit: 0, other: 1 });
    expect(parseClaudeOutput(parsed.resultLine)?.result).toBe('second');
    expect(parseClaudeStream('{"type":"assistant"}\nnope').resultLine).toBe('');
    const dropped = parseClaudeStream(`${JSON.stringify({ type: 'result', result: 'old' })}\n${'x'.repeat(5 * 1024 * 1024)}\n`);
    expect(dropped.resultLine).toBe('');
    expect(toolCallsLine({ Read: 1, Grep: 2, Glob: 3, Edit: 4, other: 5 })).toBe('tool calls: Read=1 Grep=2 Glob=3 Edit=4 other=5');
  });
});

describe('wrapper pure parts', () => {
  it('keeps MAX_BODY_BYTES equal to the schema x-maxBodyBytes', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
    expect(MAX_BODY_BYTES).toBe(schema['x-maxBodyBytes']);
  });

  it('builds settings that deny Read and Edit outside the work folder', () => {
    const settings = JSON.parse(buildSettings('/work', ['bin', 'work', 'lost+found', 'extra', 'odd name'])) as {
      permissions: { defaultMode: string; allow: string[]; deny: string[] };
    };
    expect(settings.permissions.defaultMode).toBe('dontAsk');
    expect(settings.permissions.allow).toEqual(['Read(//work/**)', 'Edit(//work/repos/**)']);
    const names = [...new Set([...FIXED_DENY, 'bin', 'extra'])].sort();
    expect(settings.permissions.deny).toEqual(names.flatMap((n) => [`Read(//${n}/**)`, `Edit(//${n}/**)`]));
    expect(settings.permissions.deny.join()).not.toContain('//work/');
    expect(settings.permissions.deny).toContain('Read(//secrets/**)');
    expect(settings.permissions.deny).toContain('Read(//wrapper/**)');
  });

  it('denies the state folder and the result code folder when they share a top-level folder with work', () => {
    const settings = JSON.parse(buildSettings('/data/work', ['data', 'bin'], ['/data/state', '/data/secrets/result', '/'])) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.allow).toEqual(['Read(//data/work/**)', 'Edit(//data/work/repos/**)']);
    expect(settings.permissions.deny).not.toContain('Read(//data/**)');
    for (const rule of ['Read(//data/state/**)', 'Edit(//data/state/**)', 'Read(//data/secrets/result/**)', 'Edit(//data/secrets/result/**)']) {
      expect(settings.permissions.deny).toContain(rule);
    }
    expect(settings.permissions.deny.join()).not.toContain('(///**)');
  });

  it('writes the state and result code folders into the settings file', async () => {
    expect(await runWrapper(options('noedit', { resultCodeFile: '/secrets/result/result-code' }))).toBe(0);
    const deny = (JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8')) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain(`Read(/${stateDir}/**)`);
    expect(deny).toContain('Read(//secrets/result/**)');
  });

  it('builds a prompt naming the files, the rules and the answer format', () => {
    const prompt = buildPrompt({ workDir: '/work', manifest: { folders: ['payments-api', 'shared-actions'], logTruncated: false }, context: null });
    expect(prompt).toContain('/work/log.txt');
    expect(prompt).toContain('/work/repos/payments-api/: the failing repository');
    expect(prompt).toContain('/work/repos/shared-actions/: an extra repository');
    expect(prompt).toContain('No debug context file');
    expect(prompt).toContain('Never run any command');
    expect(prompt).toContain('```json');
    expect(prompt).toContain('next step');
    expect(prompt).not.toContain('last part');
  });

  it('cuts the debug context file to 64 KiB in the prompt', async () => {
    write(join(workDir, 'repos/payments-api/.github/claude-debug-context.md'), `${'a'.repeat(70 * 1024)}TAIL`);
    expect(await runWrapper(options('noedit'))).toBe(0);
    const stdin = capture().stdin;
    expect(stdin).toContain('a'.repeat(1000));
    expect(stdin).not.toContain('TAIL');
  });

  it('parses claude output with missing numbers as 0', () => {
    expect(parseClaudeOutput('{"result":"x"}')).toEqual({
      result: 'x', subtype: '', isError: false, costUsd: 0, inputTokens: 0, outputTokens: 0,
    });
    expect(parseClaudeOutput('[1]')).toBeNull();
    expect(parseClaudeOutput('nope')).toBeNull();
  });

  it('takes the last json block', () => {
    const fence = '```';
    const text = `${fence}json\n{"explanation":"first"}\n${fence}\nmore\n${fence}json\n{"explanation":"second","causeLocation":{"kind":"runner"}}\n${fence}`;
    expect(extractAnswer(text)).toEqual({ explanation: 'second', causeLocation: { kind: 'runner' } });
  });

  it('finds the answer when the explanation quotes code with fences', () => {
    const fence = '```';
    const explanation = `Change the step to:\n${fence}yaml\nrun: npm ci\n${fence}\nthen rerun.`;
    const text = `Thinking.\n${fence}json\n${JSON.stringify({ explanation, causeLocation: { kind: 'workflow-file' } })}\n${fence}\n`;
    expect(extractAnswer(text)).toEqual({ explanation, causeLocation: { kind: 'workflow-file' } });
  });

  it('validates cause locations', () => {
    const folders = ['payments-api', 'shared-actions'];
    expect(validCause({ kind: 'extra-repository', repository: 'payments-api' }, folders)).toEqual({ kind: 'unknown' });
    expect(validCause({ kind: 'runner', repository: 'shared-actions' }, folders)).toEqual({ kind: 'runner' });
    expect(validCause({ kind: 'elsewhere' }, folders)).toEqual({ kind: 'unknown' });
    expect(validCause('runner', folders)).toEqual({ kind: 'unknown' });
  });

  it('cuts a long explanation and still fits a body of multi-byte text', () => {
    const run = (text: string): Record<string, unknown> => {
      const result = buildResult(
        { stdout: JSON.stringify({ result: text, subtype: 'success' }), exitCode: 0, timedOut: false, durationMs: 5 },
        { folders: ['payments-api'], logTruncated: false },
        'x'.repeat(200_000),
      );
      const body = JSON.stringify(result);
      expect(validate(body)).toEqual(expect.objectContaining({ ok: true }));
      return result as unknown as Record<string, unknown>;
    };
    const long = run('b'.repeat(70_000));
    expect(Array.from(long.explanation as string).length).toBeLessThanOrEqual(65536);
    expect(long.patch).toBe('');
    const wide = run('\u{1F600}'.repeat(70_000));
    expect((wide.explanation as string).endsWith(PATCH_LEFT_OUT)).toBe(true);
    const control = run('\u0001'.repeat(70_000));
    expect((control.explanation as string).endsWith(PATCH_LEFT_OUT)).toBe(true);
  });

  it('only cuts the explanation, without the patch sentence, when there was no patch', () => {
    const result = buildResult(
      { stdout: JSON.stringify({ result: '\u{1F600}'.repeat(70_000), subtype: 'success' }), exitCode: 0, timedOut: false, durationMs: 5 },
      { folders: ['payments-api'], logTruncated: false },
      '',
    );
    expect(validate(JSON.stringify(result))).toEqual(expect.objectContaining({ ok: true }));
    expect(result.patch).toBe('');
    expect(result.explanation).not.toContain(PATCH_LEFT_OUT);
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('reads the manifest strictly', () => {
    write(join(workDir, 'manifest.json'), JSON.stringify({ folders: ['payments-api'] }));
    expect(readManifest(workDir)).toEqual({ folders: ['payments-api'], logTruncated: false });
    write(join(workDir, 'manifest.json'), JSON.stringify({ folders: ['../etc'] }));
    expect(readManifest(workDir)).toBeNull();
    write(join(workDir, 'manifest.json'), JSON.stringify({ folders: ['payments-api'], logTruncated: 'yes' }));
    expect(readManifest(workDir)).toBeNull();
  });

  it('formats the budget as a plain decimal', () => {
    expect(formatBudget(1.9)).toBe('1.9');
    expect(formatBudget(2)).toBe('2');
    expect(formatBudget(0.19999999999999998)).toBe('0.2');
    expect(claudeArgs(4.9, '/wrapper/settings.json')).toContain('4.9');
  });
});

describe('wrapper config', () => {
  const NOW = Date.parse('2026-11-05T12:00:00Z');
  const good = {
    RUN_ID,
    RESULTS_URL: 'http://github-runner-monitor-backend.acme.svc:3002',
    DEADLINE_AT: '2026-11-05T12:15:00Z',
    SPEND_LIMIT_USD: '2',
  };

  it('reads a valid environment with defaults', () => {
    expect(parseConfig(good, NOW)).toEqual({
      runId: RUN_ID,
      resultsUrl: good.RESULTS_URL,
      deadlineAt: Date.parse(good.DEADLINE_AT),
      budgetUsd: 1.9,
      resultCodeFile: '/secrets/result/result-code',
      workDir: '/work',
      stateDir: '/wrapper',
      keyHelperPort: 8081,
      backendMainPort: 3001,
    });
  });

  it.each([
    ['missing RUN_ID', { RUN_ID: undefined }],
    ['a RUN_ID that is not a UUID', { RUN_ID: 'acme' }],
    ['a non-http RESULTS_URL', { RESULTS_URL: 'ftp://acme.example' }],
    ['a past deadline', { DEADLINE_AT: '2026-11-05T11:59:00Z' }],
    ['a deadline that is not ISO UTC', { DEADLINE_AT: '2026-11-05 12:15' }],
    ['a zero spend limit', { SPEND_LIMIT_USD: '0' }],
    ['a budget at or below 0 after headroom', { SPEND_LIMIT_USD: '0.1' }],
    ['a bad headroom', { BUDGET_HEADROOM_USD: '-1' }],
    ['a bad port', { KEY_HELPER_PORT: '70000' }],
    ['a relative work folder', { WORK_DIR: 'work' }],
    ['a state folder inside the work folder', { WORK_DIR: '/work', STATE_DIR: '/work/state' }],
  ])('refuses %s', (_label, change) => {
    const env: Record<string, string | undefined> = { ...good, ...change };
    expect(parseConfig(env, NOW)).toBeNull();
  });

  it.each([
    ['no environment', {}],
    ['a past deadline', { DEADLINE_AT: '2020-01-01T00:00:00Z' }],
    ['a budget of 0', { SPEND_LIMIT_USD: '0.1' }],
    ['a missing result code file', {}],
  ])('main prints the fixed line and exits 1 for %s', (label, change) => {
    const codeFile = join(root, 'result-code');
    writeFileSync(codeFile, `${RESULT_CODE}\n`);
    const env: Record<string, string> =
      label === 'no environment'
        ? { PATH: process.env.PATH ?? '' }
        : {
            PATH: process.env.PATH ?? '',
            ...good,
            DEADLINE_AT: new Date(Date.now() + 600_000).toISOString(),
            RESULT_CODE_FILE: label === 'a missing result code file' ? join(root, 'missing') : codeFile,
            ...change,
          };
    const result = spawnSync(process.execPath, [resolve(__dirname, '../src/wrapper.ts')], { env, encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n').pop()).toBe(CONFIG_ERROR);
    expect(result.stdout + result.stderr).not.toContain(RESULT_CODE);
  });
});
