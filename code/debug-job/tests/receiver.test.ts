import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createReceiver, safeRelativePath } from '../src/receiver.ts';
import { readTar, TarError } from '../src/tar.ts';
import { dir, entry, file, gnuLongName, link, pax, tar } from './tarFixtures.ts';

const CODE = 'invented-upload-code-7f3a9c';
const ROOT = 'acme-payments-api-1a2b3c';

interface Reply {
  status: number;
  body: string;
}

let workDir: string;
let server: Server | undefined;
let port: number;
let onExit: jest.Mock;

async function start(overrides: { maxBytes?: number; maxFiles?: number; timeoutMs?: number } = {}): Promise<void> {
  onExit = jest.fn();
  server = createReceiver({
    workDir,
    uploadCode: CODE,
    maxBytes: overrides.maxBytes ?? 10 * 1024 * 1024,
    maxFiles: overrides.maxFiles ?? 1000,
    onExit,
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  port = (server!.address() as AddressInfo).port;
}

function send(method: string, path: string, body?: Buffer | string, code: string | null = CODE): Promise<Reply> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = {};
    if (code !== null) headers.authorization = `Bearer ${code}`;
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const putRepo = (folder: string, archive: Buffer, code: string | null = CODE): Promise<Reply> =>
  send('PUT', `/upload/repo/${folder}`, gzipSync(archive), code);
const putLog = (text = 'Error: build failed\n'): Promise<Reply> => send('PUT', '/upload/log', text);
const done = (folders: unknown): Promise<Reply> => send('POST', '/upload/done', JSON.stringify({ folders }));

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Starts a repo upload, sends part of the body and leaves the request open. */
function partialUpload(folder: string, body: Buffer): { req: import('node:http').ClientRequest; reply: Promise<Reply> } {
  let req!: import('node:http').ClientRequest;
  const reply = new Promise<Reply>((resolvePromise, reject) => {
    req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/upload/repo/${folder}`,
        headers: { authorization: `Bearer ${CODE}`, 'content-length': String(body.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
  });
  req.write(body.subarray(0, Math.floor(body.length / 2)));
  return { req, reply };
}

/** An incompressible gzipped archive, big enough to arrive in several chunks. */
function bigArchive(): Buffer {
  return gzipSync(tar(file(`${ROOT}/big.bin`, randomBytes(150000).toString('base64'))));
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => done(free));
    });
  });
}

/** Every path under dir, relative, with a trailing / for directories. */
function tree(root: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, base)).sort()) {
    const rel = base ? `${base}/${name}` : name;
    const stat = lstatSync(join(root, rel));
    if (stat.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...tree(root, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function consoleText(): string {
  const mocks = [console.log, console.info, console.warn, console.error] as unknown as jest.Mock[];
  return mocks.map((m) => JSON.stringify(m.mock.calls)).join('\n');
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'receiver-test-'));
  jest.clearAllMocks();
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('safeRelativePath', () => {
  it.each([
    [`${ROOT}/a.txt`, 'a.txt'],
    [`${ROOT}/src/b.ts`, 'src/b.ts'],
    [`./${ROOT}/src/./b.ts`, 'src/b.ts'],
    [`${ROOT}/dir/`, 'dir'],
  ])('keeps %s as %s', (name, expected) => {
    expect(safeRelativePath(name)).toBe(expected);
  });

  it.each([
    '/etc/x',
    `${ROOT}/../x`,
    `${ROOT}/a/../../x`,
    `${ROOT}/a\\b`,
    `${ROOT}/a\0b`,
    ROOT,
    `${ROOT}/`,
    '',
  ])('drops %j', (name) => {
    expect(safeRelativePath(name)).toBeNull();
  });
});

/** Feeds a buffer in small uneven chunks to exercise the reader's buffering. */
async function* chunks(buf: Buffer): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += 77) yield buf.subarray(i, i + 77);
}

describe('readTar', () => {
  it('reads base-256 sizes and skips data the consumer does not read', async () => {
    const archive = tar(
      entry({ name: `${ROOT}/big.bin`, type: '0', base256Size: true }, 'x'.repeat(700)),
      file(`${ROOT}/next.txt`, 'next'),
    );
    const seen: Array<{ path: string; size: number }> = [];
    let last = '';
    for await (const e of readTar(chunks(archive))) {
      seen.push({ path: e.path, size: e.size });
      if (e.path.endsWith('next.txt')) {
        for await (const chunk of e.data) last += chunk.toString();
      }
    }
    expect(seen).toEqual([
      { path: `${ROOT}/big.bin`, size: 700 },
      { path: `${ROOT}/next.txt`, size: 4 },
    ]);
    expect(last).toBe('next');
  });

  it('applies pax size and ignores global pax headers', async () => {
    const archive = tar(
      pax({ path: 'ignored-global' }, 'g'),
      pax({ size: '3' }),
      entry({ name: `${ROOT}/a.txt`, type: '0', size: 99 }, 'abc'),
    );
    const seen: Array<{ path: string; size: number }> = [];
    for await (const e of readTar(chunks(archive))) seen.push({ path: e.path, size: e.size });
    expect(seen).toEqual([{ path: `${ROOT}/a.txt`, size: 3 }]);
  });

  it('rejects a bad checksum and a truncated archive', async () => {
    const drain = async (buf: Buffer): Promise<void> => {
      for await (const e of readTar(chunks(buf))) void e;
    };
    await expect(drain(tar(entry({ name: 'a', checksumDelta: 1 }, 'x')))).rejects.toBeInstanceOf(TarError);
    await expect(drain(file(`${ROOT}/a.txt`, 'abc').subarray(0, 600))).rejects.toBeInstanceOf(TarError);
    await expect(drain(Buffer.alloc(0))).rejects.toBeInstanceOf(TarError);
  });

  it('accepts zero padding after the end marker but rejects other trailing data', async () => {
    const drain = async (buf: Buffer): Promise<void> => {
      for await (const e of readTar(chunks(buf))) void e;
    };
    await expect(drain(Buffer.concat([tar(file(`${ROOT}/a`, 'a')), Buffer.alloc(9000)]))).resolves.toBeUndefined();
    await expect(drain(Buffer.concat([tar(file(`${ROOT}/a`, 'a')), Buffer.from('junk')]))).rejects.toBeInstanceOf(TarError);
  });

  it('counts pax and GNU long name bytes as data bytes', async () => {
    const paxEntry = pax({ path: `${ROOT}/p.txt` });
    const longEntry = gnuLongName(`${ROOT}/g.txt`);
    const sizeOf = (e: Buffer): number => parseInt(e.subarray(124, 135).toString('latin1'), 8);
    const archive = tar(paxEntry, file('x', 'ab'), longEntry, file('y', 'cd'));
    let counted = 0;
    for await (const e of readTar(chunks(archive), { onDataBytes: (n) => (counted += n) })) void e;
    // Two 2-byte files, the pax records, the GNU name and the 1024 zero bytes after the end marker.
    expect(counted).toBe(4 + sizeOf(paxEntry) + sizeOf(longEntry) + 512);
  });
});

describe('receiver uploads', () => {
  it('unpacks a repository without its root folder, with fixed modes', async () => {
    await start();
    const reply = await putRepo(
      'payments-api',
      tar(dir(`${ROOT}/`), file(`${ROOT}/a.txt`, 'alpha'), dir(`${ROOT}/src/`), file(`${ROOT}/src/b.ts`, 'export {};')),
    );
    expect(reply.status).toBe(200);
    const repo = join(workDir, 'repos', 'payments-api');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(repo, 'src', 'b.ts'), 'utf8')).toBe('export {};');
    expect(statSync(join(repo, 'a.txt')).mode & 0o777).toBe(0o644);
    expect(statSync(join(repo, 'src', 'b.ts')).mode & 0o777).toBe(0o644);
    expect(statSync(join(repo, 'src')).mode & 0o777).toBe(0o755);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('creates parent folders that the archive does not list', async () => {
    await start();
    expect((await putRepo('payments-api', tar(file(`${ROOT}/deep/er/c.txt`, 'c')))).status).toBe(200);
    expect(readFileSync(join(workDir, 'repos/payments-api/deep/er/c.txt'), 'utf8')).toBe('c');
  });

  it('drops links, devices, FIFOs, unsafe paths and unknown types but writes the rest', async () => {
    await start();
    const reply = await putRepo(
      'payments-api',
      tar(
        file(`${ROOT}/kept.txt`, 'kept'),
        link(`${ROOT}/sym`, '2', '/etc/passwd'),
        link(`${ROOT}/hard`, '1', `${ROOT}/kept.txt`),
        link(`${ROOT}/chr`, '3'),
        link(`${ROOT}/blk`, '4'),
        link(`${ROOT}/fifo`, '6'),
        entry({ name: `${ROOT}/contig`, type: '7' }, 'data'),
        file('/etc/x', 'abs'),
        file(`${ROOT}/../x`, 'up'),
        file(`${ROOT}/a/../../x`, 'up2'),
        file(`${ROOT}/back\\slash`, 'bs'),
        file(`${ROOT}`, 'root-only'),
        file(`${ROOT}/also-kept.txt`, 'also'),
      ),
    );
    expect(reply.status).toBe(200);
    expect(tree(join(workDir, 'repos'))).toEqual(['payments-api/', 'payments-api/also-kept.txt', 'payments-api/kept.txt']);
    expect(readdirSync(workDir)).toEqual(['repos']);
  });

  it('drops entries that collide with an existing path', async () => {
    await start();
    const reply = await putRepo(
      'payments-api',
      tar(
        file(`${ROOT}/a`, 'file first'),
        dir(`${ROOT}/a/`),
        file(`${ROOT}/a/b`, 'under a file'),
        dir(`${ROOT}/d/`),
        file(`${ROOT}/d`, 'file over dir'),
        file(`${ROOT}/a`, 'second copy'),
      ),
    );
    expect(reply.status).toBe(200);
    expect(tree(join(workDir, 'repos/payments-api'))).toEqual(['a', 'd/']);
    expect(readFileSync(join(workDir, 'repos/payments-api/a'), 'utf8')).toBe('file first');
  });

  it('writes pax path, GNU long name and ustar prefix entries under the long name', async () => {
    await start();
    const longDir = 'l'.repeat(90);
    const reply = await putRepo(
      'payments-api',
      tar(
        pax({ path: `${ROOT}/${longDir}/pax-name-${'p'.repeat(60)}.txt` }),
        file('short-pax', 'from pax'),
        gnuLongName(`${ROOT}/${longDir}/gnu-name-${'g'.repeat(60)}.txt`),
        file('short-gnu', 'from gnu'),
        file('prefixed.txt', 'from prefix', { prefix: `${ROOT}/${longDir}` }),
      ),
    );
    expect(reply.status).toBe(200);
    const base = join(workDir, 'repos/payments-api', longDir);
    expect(readFileSync(join(base, `pax-name-${'p'.repeat(60)}.txt`), 'utf8')).toBe('from pax');
    expect(readFileSync(join(base, `gnu-name-${'g'.repeat(60)}.txt`), 'utf8')).toBe('from gnu');
    expect(readFileSync(join(base, 'prefixed.txt'), 'utf8')).toBe('from prefix');
  });

  it('drops a pax path with a NUL in it', async () => {
    await start();
    const reply = await putRepo('payments-api', tar(pax({ path: `${ROOT}/a\0b` }), file('x', 'nul'), file(`${ROOT}/ok`, 'ok')));
    expect(reply.status).toBe(200);
    expect(tree(join(workDir, 'repos/payments-api'))).toEqual(['ok']);
  });

  it('drops entries whose names are too long for the filesystem', async () => {
    await start();
    const long = 'n'.repeat(300);
    const reply = await putRepo(
      'payments-api',
      tar(pax({ path: `${ROOT}/${long}.txt` }), file('x', 'too long'), pax({ path: `${ROOT}/${'d'.repeat(300)}/` }),
        dir('y/'), file(`${ROOT}/ok`, 'ok')),
    );
    expect(reply.status).toBe(200);
    expect(tree(join(workDir, 'repos/payments-api'))).toEqual(['ok']);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('writes the log to log.txt with mode 0644', async () => {
    await start();
    expect((await putLog('line 1\nline 2\n')).status).toBe(200);
    expect(readFileSync(join(workDir, 'log.txt'), 'utf8')).toBe('line 1\nline 2\n');
    expect(statSync(join(workDir, 'log.txt')).mode & 0o777).toBe(0o644);
  });
});

describe('receiver authentication', () => {
  it('returns 401 and writes nothing for a wrong or missing code', async () => {
    await start();
    const archive = tar(file(`${ROOT}/a.txt`, 'alpha'));
    expect((await putRepo('payments-api', archive, 'invented-wrong-code')).status).toBe(401);
    expect((await putRepo('payments-api', archive, null)).status).toBe(401);
    expect((await send('PUT', '/upload/log', 'log', 'invented-wrong-code')).status).toBe(401);
    expect((await send('POST', '/upload/done', '{"folders":[]}', null)).status).toBe(401);
    expect(readdirSync(workDir)).toEqual([]);
    expect(onExit).not.toHaveBeenCalled();
    // The folder was not claimed by the rejected request.
    expect((await putRepo('payments-api', archive)).status).toBe(200);
  });

  it('exits 1 after the fifth wrong code', async () => {
    await start();
    for (let i = 0; i < 4; i++) {
      expect((await send('PUT', '/upload/log', 'x', 'nope')).status).toBe(401);
    }
    expect(onExit).not.toHaveBeenCalled();
    expect((await send('PUT', '/upload/log', 'x', 'nope')).status).toBe(401);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});

describe('receiver routing', () => {
  it('answers 404 for unknown paths and 405 for wrong methods', async () => {
    await start();
    expect((await send('GET', '/')).status).toBe(404);
    expect((await send('PUT', '/upload/other')).status).toBe(404);
    expect((await send('GET', '/upload/log')).status).toBe(405);
    expect((await send('POST', '/upload/repo/payments-api')).status).toBe(405);
    expect((await send('PUT', '/upload/done')).status).toBe(405);
  });

  it.each(['..', '.', 'a/b', '', 'a%2Fb', 'x'.repeat(101), 'bad%20name', 'a:b'])('rejects folder %j with 400', async (folder) => {
    await start();
    expect((await putRepo(folder, tar(file(`${ROOT}/a.txt`, 'a')))).status).toBe(400);
    expect(onExit).not.toHaveBeenCalled();
    expect(readdirSync(workDir)).toEqual([]);
  });

  it('answers 409 for a folder or the log uploaded twice', async () => {
    await start();
    const archive = tar(file(`${ROOT}/a.txt`, 'a'));
    expect((await putRepo('payments-api', archive)).status).toBe(200);
    expect((await putRepo('payments-api', archive)).status).toBe(409);
    expect((await putLog()).status).toBe(200);
    expect((await putLog()).status).toBe(409);
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('receiver limits and corrupt uploads', () => {
  it('answers 413 and exits 1 when unpacked bytes pass the limit', async () => {
    await start({ maxBytes: 1000 });
    const reply = await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a'.repeat(600)), file(`${ROOT}/b.txt`, 'b'.repeat(600))));
    expect(reply.status).toBe(413);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('counts the log against the same budget', async () => {
    // The repo uses 600 file bytes plus 512 bytes of zero padding after its end marker.
    await start({ maxBytes: 1500 });
    expect((await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a'.repeat(600))))).status).toBe(200);
    expect((await putLog('l'.repeat(600))).status).toBe(413);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('counts dropped entry data too, so a huge skipped entry still hits the limit', async () => {
    await start({ maxBytes: 1000 });
    const reply = await putRepo('payments-api', tar(entry({ name: `${ROOT}/c`, type: '7' }, 'c'.repeat(5000))));
    expect(reply.status).toBe(413);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('answers 413 and exits 1 when there are too many entries', async () => {
    await start({ maxFiles: 3 });
    const files = Array.from({ length: 5 }, (_, i) => file(`${ROOT}/f${i}.txt`, 'x'));
    expect((await putRepo('payments-api', tar(...files))).status).toBe(413);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('answers 413 and exits 1 for a folder-only archive with too many entries', async () => {
    await start({ maxFiles: 3 });
    const dirs = Array.from({ length: 5 }, (_, i) => dir(`${ROOT}/d${i}/`));
    expect((await putRepo('payments-api', tar(...dirs))).status).toBe(413);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('answers 400 and exits 1 when the gzip CRC trailer is wrong', async () => {
    await start();
    const body = gzipSync(tar(file(`${ROOT}/a.txt`, 'alpha')));
    const crcAt = body.length - 8;
    body[crcAt] = (body[crcAt] ?? 0) ^ 0xff;
    expect((await send('PUT', '/upload/repo/payments-api', body)).status).toBe(400);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 promptly when the client drops the connection partway', async () => {
    await start();
    const { req, reply } = partialUpload('payments-api', bigArchive());
    reply.catch(() => {});
    await waitFor(() => existsSync(join(workDir, 'repos/payments-api')));
    req.destroy();
    await waitFor(() => onExit.mock.calls.length > 0, 2000);
    expect(onExit.mock.calls).toEqual([[1]]);
  });

  it('answers 400 and exits 1 for a body that is not gzip', async () => {
    await start();
    expect((await send('PUT', '/upload/repo/payments-api', 'not a gzip body')).status).toBe(400);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('answers 400 and exits 1 for a bad header checksum', async () => {
    await start();
    const reply = await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a', { checksumDelta: 3 })));
    expect(reply.status).toBe(400);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('answers 400 and exits 1 for a truncated archive', async () => {
    await start();
    const reply = await putRepo('payments-api', file(`${ROOT}/a.txt`, 'a'.repeat(2000)).subarray(0, 900));
    expect(reply.status).toBe(400);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('refuses later requests once it has exited', async () => {
    await start({ maxBytes: 10 });
    expect((await putLog('l'.repeat(50))).status).toBe(413);
    expect((await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a')))).status).toBe(503);
  });

  it('exits 1 when done does not arrive in time', async () => {
    await start({ timeoutMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    expect(onExit).toHaveBeenCalledWith(1);
  });
});

describe('receiver done', () => {
  it('writes the manifest and exits 0 when the list matches the uploads', async () => {
    await start();
    expect((await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a'), link(`${ROOT}/s`, '2')))).status).toBe(200);
    expect((await putRepo('shared-lib', tar(file('acme-shared-lib-9f8e7d/lib.ts', 'lib')))).status).toBe(200);
    expect((await putLog()).status).toBe(200);
    const reply = await done(['payments-api', 'shared-lib']);
    expect(reply.status).toBe(200);
    expect(JSON.parse(readFileSync(join(workDir, 'manifest.json'), 'utf8'))).toEqual({
      folders: ['payments-api', 'shared-lib'],
      logTruncated: false,
    });
    await new Promise((r) => setImmediate(r));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(tree(workDir)).toEqual([
      'log.txt',
      'manifest.json',
      'repos/',
      'repos/payments-api/',
      'repos/payments-api/a.txt',
      'repos/shared-lib/',
      'repos/shared-lib/lib.ts',
    ]);
    for (const path of tree(workDir)) {
      const stat = lstatSync(join(workDir, path));
      expect(stat.isFile() || stat.isDirectory()).toBe(true);
    }
  });

  it.each([
    ['a folder missing from the list', ['payments-api'], true],
    ['a folder that was not uploaded', ['payments-api', 'shared-lib', 'other'], true],
    ['a duplicate folder', ['payments-api', 'shared-lib', 'shared-lib'], true],
    ['no log upload', ['payments-api', 'shared-lib'], false],
  ])('answers 400 and keeps waiting for %s', async (_label, folders, withLog) => {
    await start();
    await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a')));
    await putRepo('shared-lib', tar(file('acme-shared-lib-9f8e7d/lib.ts', 'lib')));
    if (withLog) await putLog();
    expect((await done(folders)).status).toBe(400);
    expect(onExit).not.toHaveBeenCalled();
    expect(readdirSync(workDir)).not.toContain('manifest.json');
    if (!withLog) expect((await putLog()).status).toBe(200);
    expect((await done(['payments-api', 'shared-lib'])).status).toBe(200);
  });

  it('answers 400 to done while an upload is still in progress', async () => {
    await start();
    expect((await putLog()).status).toBe(200);
    const archive = bigArchive();
    const { req, reply } = partialUpload('payments-api', archive);
    await waitFor(() => existsSync(join(workDir, 'repos/payments-api')));
    expect((await done(['payments-api'])).status).toBe(400);
    req.end(archive.subarray(Math.floor(archive.length / 2)));
    expect((await reply).status).toBe(200);
    expect((await done(['payments-api'])).status).toBe(200);
    expect(onExit.mock.calls).toEqual([[0]]);
  });

  it('refuses uploads and a second done while the first done finishes', async () => {
    await start();
    expect((await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a')))).status).toBe(200);
    expect((await putLog()).status).toBe(200);
    const original = fsPromises.writeFile;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const writing = new Promise<void>((r) => {
      entered = r;
    });
    const spy = jest.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args: Parameters<typeof original>) => {
      entered();
      await gate;
      return original.apply(fsPromises, args);
    });
    try {
      const first = done(['payments-api']);
      await writing;
      expect((await putRepo('shared-lib', tar(file('acme-shared-lib-9f8e7d/lib.ts', 'lib')))).status).toBe(503);
      expect((await done(['payments-api'])).status).toBe(503);
      release();
      expect((await first).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    await new Promise((r) => setImmediate(r));
    expect(onExit.mock.calls).toEqual([[0]]);
    expect(existsSync(join(workDir, 'repos/shared-lib'))).toBe(false);
  });

  it('writes logTruncated true to the manifest when the backend says the log was cut', async () => {
    await start();
    await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a')));
    await putLog();
    const reply = await send('POST', '/upload/done', JSON.stringify({ folders: ['payments-api'], logTruncated: true }));
    expect(reply.status).toBe(200);
    expect(JSON.parse(readFileSync(join(workDir, 'manifest.json'), 'utf8'))).toEqual({
      folders: ['payments-api'],
      logTruncated: true,
    });
  });

  it.each([['"yes"'], ['1'], ['null'], ['{}']])('answers 400 and keeps waiting for logTruncated %s', async (value) => {
    await start();
    await putRepo('payments-api', tar(file(`${ROOT}/a.txt`, 'a')));
    await putLog();
    expect((await send('POST', '/upload/done', `{"folders":["payments-api"],"logTruncated":${value}}`)).status).toBe(400);
    expect(onExit).not.toHaveBeenCalled();
    expect(readdirSync(workDir)).not.toContain('manifest.json');
    expect((await done(['payments-api'])).status).toBe(200);
    expect(JSON.parse(readFileSync(join(workDir, 'manifest.json'), 'utf8')).logTruncated).toBe(false);
  });

  it('answers 400 for a body that is not the expected JSON', async () => {
    await start();
    await putLog();
    expect((await send('POST', '/upload/done', 'not json')).status).toBe(400);
    expect((await send('POST', '/upload/done', '{"folders":"payments-api"}')).status).toBe(400);
    expect((await send('POST', '/upload/done', '{"folders":[1]}')).status).toBe(400);
    expect((await send('POST', '/upload/done', `{"folders":[],"pad":"${'p'.repeat(70 * 1024)}"}`)).status).toBe(413);
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('receiver logging', () => {
  it('never logs the upload code, file names or contents', async () => {
    await start();
    await putRepo('payments-api', tar(file(`${ROOT}/secret-name.txt`, 'secret-contents')));
    await putLog('log-contents');
    await send('PUT', '/upload/log', 'x', 'invented-wrong-code');
    await done(['payments-api']);
    const text = consoleText();
    expect(text).toContain('receiver: ');
    for (const value of [CODE, 'invented-wrong-code', 'secret-name', 'secret-contents', 'log-contents', 'payments-api']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('receiver main', () => {
  it('prints a fixed line and exits 1 without an upload code file', () => {
    const script = resolve(__dirname, '../src/receiver.ts');
    const result = spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', UPLOAD_CODE_FILE: join(workDir, 'missing'), UPLOAD_PORT: '0' },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n').pop()).toBe('receiver: upload code file is missing or empty, exiting');
  });

  it('exits 1 with a fixed line when no done arrives within RECEIVE_TIMEOUT_SECONDS', async () => {
    const codeFile = join(workDir, 'upload-code');
    writeFileSync(codeFile, `${CODE}\n`);
    const work = join(workDir, 'work');
    const started = Date.now();
    const result = spawnSync(process.execPath, [resolve(__dirname, '../src/receiver.ts')], {
      env: {
        PATH: process.env.PATH ?? '',
        UPLOAD_CODE_FILE: codeFile,
        UPLOAD_PORT: String(await freePort()),
        WORK_DIR: work,
        RECEIVE_TIMEOUT_SECONDS: '1',
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(result.stdout.trim().split('\n')).toEqual(['receiver: listening', 'receiver: no upload completed in time, exiting']);
    expect(result.stdout + result.stderr).not.toContain(CODE);
  });
});
