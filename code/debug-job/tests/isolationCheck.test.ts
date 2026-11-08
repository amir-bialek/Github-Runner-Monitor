import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  CONFIG_ERROR,
  EXIT_ANTHROPIC_UNREACHED,
  EXIT_BOTH,
  EXIT_FORBIDDEN_REACHED,
  EXIT_PASSED,
  parseCheckConfig,
  reachesHttp,
  runIsolationCheck,
} from '../src/isolationCheck.ts';
import type { Probes } from '../src/wrapper.ts';

// A response body that must never be printed.
const BODY_MARKER = 'invented-anthropic-body-marker-acme';

let anthropic: Server;
let anthropicUrl: string;
let closedTcpPort: number;
let closedHttpUrl: string;
let silent: Socket;
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

function silentProbes(): Probes {
  return {
    tcp: [{ host: '127.0.0.1', port: closedTcpPort }],
    dns: [{ host: '127.0.0.1', port: silentUdpPort }],
    dnsName: 'github.com',
  };
}

function consoleLines(): string[] {
  const mocks = [console.log, console.info, console.warn, console.error] as unknown as jest.Mock[];
  return mocks.flatMap((m) => m.mock.calls.map((call: unknown[]) => call.map(String).join(' ')));
}

beforeAll(async () => {
  // Stand-in for the Anthropic API: any status counts as reached.
  anthropic = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: BODY_MARKER }));
  });
  anthropicUrl = `http://127.0.0.1:${await listen(anthropic)}/v1/models`;
  closedTcpPort = await freeTcpPort();
  closedHttpUrl = `http://127.0.0.1:${await freeTcpPort()}/v1/models`;
  silent = createSocket('udp4');
  silentUdpPort = await new Promise<number>((done) => silent.bind(0, '127.0.0.1', () => done(silent.address().port)));
});

afterAll(async () => {
  await close(anthropic);
  silent.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runIsolationCheck', () => {
  it('exits 0 when every forbidden target is silent and Anthropic answers', async () => {
    expect(await runIsolationCheck({ probes: silentProbes(), anthropicUrl, timeoutMs: 300 })).toBe(EXIT_PASSED);
    expect(consoleLines()).toEqual([
      'isolation check: every forbidden target stayed silent',
      'isolation check: the Anthropic API answered',
      'isolation check: passed',
    ]);
  });

  it('exits 3 when a forbidden TCP target answers', async () => {
    const forbidden = createServer();
    const port = await listen(forbidden);
    try {
      const probes = silentProbes();
      probes.tcp.push({ host: '127.0.0.1', port });
      expect(await runIsolationCheck({ probes, anthropicUrl, timeoutMs: 300 })).toBe(EXIT_FORBIDDEN_REACHED);
    } finally {
      await close(forbidden);
    }
    expect(consoleLines()).toContain('isolation check: a forbidden target answered');
  });

  it('exits 3 when an outside DNS server answers', async () => {
    const dns: Socket = createSocket('udp4');
    dns.on('message', (msg, rinfo) => {
      const reply = Buffer.from(msg);
      reply.writeUInt16BE(0x8183, 2);
      dns.send(reply, rinfo.port, rinfo.address);
    });
    const port = await new Promise<number>((done) => dns.bind(0, '127.0.0.1', () => done(dns.address().port)));
    try {
      const probes = silentProbes();
      probes.dns.push({ host: '127.0.0.1', port });
      expect(await runIsolationCheck({ probes, anthropicUrl, timeoutMs: 300 })).toBe(EXIT_FORBIDDEN_REACHED);
    } finally {
      dns.close();
    }
  });

  it('exits 4 when Anthropic is down', async () => {
    expect(await runIsolationCheck({ probes: silentProbes(), anthropicUrl: closedHttpUrl, timeoutMs: 300 })).toBe(
      EXIT_ANTHROPIC_UNREACHED,
    );
    expect(consoleLines()).toContain('isolation check: the Anthropic API could not be reached');
  });

  it('exits 4 when Anthropic never answers within the timeout', async () => {
    const hanging = createServer(() => {
      // never answers
    });
    const port = await listen(hanging);
    try {
      const started = Date.now();
      expect(
        await runIsolationCheck({ probes: silentProbes(), anthropicUrl: `http://127.0.0.1:${port}/v1/models`, timeoutMs: 300 }),
      ).toBe(EXIT_ANTHROPIC_UNREACHED);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await close(hanging);
    }
  });

  it('exits 5 when a forbidden target answers and Anthropic is down', async () => {
    const forbidden = createServer();
    const port = await listen(forbidden);
    try {
      const probes = silentProbes();
      probes.tcp.push({ host: '127.0.0.1', port });
      expect(await runIsolationCheck({ probes, anthropicUrl: closedHttpUrl, timeoutMs: 300 })).toBe(EXIT_BOTH);
    } finally {
      await close(forbidden);
    }
  });

  it('never prints a response body', async () => {
    await runIsolationCheck({ probes: silentProbes(), anthropicUrl, timeoutMs: 300 });
    expect(consoleLines().join('\n')).not.toContain(BODY_MARKER);
    expect(consoleLines().every((line) => line.startsWith('isolation check: '))).toBe(true);
  });
});

describe('reachesHttp', () => {
  it('refuses a URL that is not http or https', async () => {
    expect(await reachesHttp('ftp://127.0.0.1/', 300)).toBe(false);
    expect(await reachesHttp('not a url', 300)).toBe(false);
  });
});

describe('parseCheckConfig', () => {
  it('reads the backend host URL and main port', () => {
    expect(
      parseCheckConfig({ RESULTS_URL: 'http://backend.acme.svc.cluster.local:3002', BACKEND_MAIN_PORT: '8080' }),
    ).toEqual({ resultsUrl: 'http://backend.acme.svc.cluster.local:3002', backendMainPort: 8080 });
  });

  it('defaults the main port to 3001', () => {
    expect(parseCheckConfig({ RESULTS_URL: 'http://backend.acme.svc.cluster.local:3002' })?.backendMainPort).toBe(3001);
  });

  it.each([
    [{}],
    [{ RESULTS_URL: 'not a url' }],
    [{ RESULTS_URL: 'ftp://backend.acme:3002' }],
    [{ RESULTS_URL: 'http://user:pass@backend.acme:3002' }],
    [{ RESULTS_URL: 'http://backend.acme:3002', BACKEND_MAIN_PORT: '70000' }],
    [{ RESULTS_URL: 'http://backend.acme:3002', BACKEND_MAIN_PORT: 'abc' }],
  ])('refuses %p', (env) => {
    expect(parseCheckConfig(env)).toBeNull();
  });

  it('has a fixed configuration error line', () => {
    expect(CONFIG_ERROR).toBe('isolation check: configuration is missing or invalid, exiting');
  });
});

describe('the script entry point', () => {
  it('exits 2 with the fixed line when RESULTS_URL is missing', () => {
    const script = resolve(__dirname, '../src/isolationCheck.ts');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
    // Node 22 needs the flag to run .ts files; Node 24 strips types by default.
    const major = Number(process.versions.node.split('.')[0]);
    const args = major < 23 ? ['--experimental-strip-types', '--no-warnings', script] : [script];
    const run = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(2);
    const lines = `${run.stdout}${run.stderr}`.trim().split('\n');
    expect(lines[lines.length - 1]).toBe(CONFIG_ERROR);
  });
});
