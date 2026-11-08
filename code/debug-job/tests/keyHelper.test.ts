import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createKeyHelper, UPSTREAM } from '../src/keyHelper.ts';

const REAL_KEY = 'sk-ant-invented-real-key-0123456789';
const DUMMY_KEY = 'dummy';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server;
let upstreamPort: number;
let helper: Server;
let helperPort: number;
let seen: Seen[];
let upstreamHandler: (res: ServerResponse) => void;

function listen(server: Server): Promise<number> {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}

beforeEach(async () => {
  jest.clearAllMocks();
  seen = [];
  upstreamHandler = (res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end('{"ok":true}');
  };
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      upstreamHandler(res);
    });
  });
  upstreamPort = await listen(upstream);
  helper = createKeyHelper({ apiKey: REAL_KEY, upstream: { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort } });
  helperPort = await listen(helper);
});

afterEach(async () => {
  await close(helper);
  if (upstream.listening) await close(upstream);
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port: helperPort, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Sends a raw HTTP request line, for targets the http client will not send. */
function raw(text: string): Promise<string> {
  return new Promise((done, reject) => {
    const socket = connect(helperPort, '127.0.0.1', () => socket.write(text));
    let out = '';
    socket.on('data', (c) => {
      out += c.toString();
    });
    socket.on('end', () => done(out));
    socket.on('close', () => done(out));
    socket.on('error', reject);
  });
}

function consoleText(): string {
  const mocks = [console.log, console.info, console.warn, console.error] as unknown as jest.Mock[];
  return mocks.map((m) => JSON.stringify(m.mock.calls)).join('\n');
}

describe('key helper forwarding', () => {
  it('forwards method, path, query and body with only the real key', async () => {
    const body = JSON.stringify({ model: 'invented-model', messages: [{ role: 'user', content: 'hi' }] });
    const reply = await call(
      'POST',
      '/v1/messages?beta=true',
      {
        'content-type': 'application/json',
        'x-api-key': DUMMY_KEY,
        authorization: 'Bearer invented-bearer',
        'proxy-authorization': 'Basic invented',
        'anthropic-version': '2023-06-01',
        connection: 'keep-alive, x-drop-me',
        'x-drop-me': 'listed in connection',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        upgrade: 'websocket',
      },
      body,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"ok":true}');
    expect(reply.headers['x-upstream']).toBe('yes');
    expect(seen).toHaveLength(1);
    const got = seen[0]!;
    expect(got.method).toBe('POST');
    expect(got.url).toBe('/v1/messages?beta=true');
    expect(got.body).toBe(body);
    expect(got.headers['x-api-key']).toBe(REAL_KEY);
    expect(got.headers['anthropic-version']).toBe('2023-06-01');
    expect(got.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
    for (const name of ['authorization', 'proxy-authorization', 'x-drop-me', 'keep-alive', 'te', 'upgrade']) {
      expect(got.headers[name]).toBeUndefined();
    }
    expect(Object.values(got.headers)).not.toContain(DUMMY_KEY);
    expect(JSON.stringify(got.headers)).not.toContain('invented-bearer');
  });

  it('streams the response back and drops hop-by-hop response headers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    upstreamHandler = (res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive, x-hop',
        'x-hop': 'hop',
        'keep-alive': 'timeout=99',
        'x-request-id': 'req-invented',
      });
      res.write('event: one\n\n');
      void gate.then(() => res.end('event: two\n\n'));
    };
    const result = await new Promise<{ first: string; all: string; headers: IncomingHttpHeaders }>((done, reject) => {
      const req = request(
        { host: '127.0.0.1', port: helperPort, method: 'POST', path: '/v1/messages', headers: { 'x-api-key': DUMMY_KEY } },
        (res) => {
          let all = '';
          let first = '';
          res.on('data', (c: Buffer) => {
            all += c.toString();
            if (!first) {
              first = all;
              // The first event arrived while upstream is still open.
              release();
            }
          });
          res.on('end', () => done({ first, all, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end('{"stream":true}');
    });
    expect(result.first).toBe('event: one\n\n');
    expect(result.all).toBe('event: one\n\nevent: two\n\n');
    expect(result.headers['x-request-id']).toBe('req-invented');
    expect(result.headers['x-hop']).toBeUndefined();
    // The helper's own server may add its own Keep-Alive; the upstream one is not copied.
    expect(result.headers['keep-alive']).not.toBe('timeout=99');
  });

  it('passes the upstream status through', async () => {
    upstreamHandler = (res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"type":"error"}');
    };
    const reply = await call('POST', '/v1/messages', { 'x-api-key': DUMMY_KEY }, '{}');
    expect(reply.status).toBe(429);
    expect(reply.body).toBe('{"type":"error"}');
  });

  it('answers 502 when the upstream is unreachable', async () => {
    await close(upstream);
    const reply = await call('POST', '/v1/messages', { 'x-api-key': DUMMY_KEY }, '{}');
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body)).toEqual({ error: expect.any(String) });
  });
});

describe('key helper request targets', () => {
  it.each(['GET http://evil.example/ HTTP/1.1', 'GET //evil.example/x HTTP/1.1', 'OPTIONS * HTTP/1.1'])(
    'answers 400 and forwards nothing for %s',
    async (line) => {
      const out = await raw(`${line}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
      expect(out.startsWith('HTTP/1.1 400')).toBe(true);
      expect(seen).toHaveLength(0);
    },
  );
});

describe('key helper logging', () => {
  it('never logs the key, the dummy key or header values', async () => {
    await call('POST', '/v1/messages', { 'x-api-key': DUMMY_KEY, authorization: 'Bearer invented-bearer' }, '{}');
    await raw('GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    await close(upstream);
    await call('POST', '/v1/messages', { 'x-api-key': DUMMY_KEY }, '{}');
    const text = consoleText();
    expect(text).toContain('key helper: ');
    for (const value of [REAL_KEY, 'invented-bearer', 'evil.example', '/v1/messages']) {
      expect(text).not.toContain(value);
    }
  });
});

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, host);
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.on('error', () => done(false));
    socket.on('timeout', () => {
      socket.destroy();
      done(false);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

describe('key helper main', () => {
  const script = resolve(__dirname, '../src/keyHelper.ts');
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'key-helper-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('always forwards to https api.anthropic.com:443', () => {
    expect(UPSTREAM).toEqual({ protocol: 'https:', hostname: 'api.anthropic.com', port: 443 });
  });

  it('listens on 127.0.0.1 only', async () => {
    const keyFile = join(dir, 'api-key');
    writeFileSync(keyFile, `${REAL_KEY}\n`);
    const port = await freePort();
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', ANTHROPIC_KEY_FILE: keyFile, KEY_HELPER_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('key helper did not start')), 15000);
        const onData = (c: Buffer): void => {
          output += c.toString();
          if (output.includes('key helper: listening')) {
            clearTimeout(timer);
            done();
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', () => reject(new Error('key helper exited')));
      });
      expect(await canConnect('127.0.0.1', port)).toBe(true);
      const outside = Object.values(networkInterfaces())
        .flat()
        .find((a) => a !== undefined && a.family === 'IPv4' && !a.internal);
      if (outside) {
        expect(await canConnect(outside.address, port)).toBe(false);
      }
      expect(output).not.toContain(REAL_KEY);
    } finally {
      child.kill();
    }
  });

  it.each([
    ['missing', null],
    ['empty', '  \n'],
  ])('prints a fixed line and exits 1 when the key file is %s', (_label, content) => {
    const keyFile = join(dir, 'api-key');
    if (content !== null) writeFileSync(keyFile, content);
    const result = spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', ANTHROPIC_KEY_FILE: keyFile },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n').pop()).toBe('key helper: key file is missing or empty, exiting');
    expect(result.stdout).toBe('');
  });
});
