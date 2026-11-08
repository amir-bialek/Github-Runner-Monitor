// Debug Job receiver (init container). Accepts the backend's upload of the
// failing log and repository tarballs into WORK_DIR, then exits 0 on
// POST /upload/done. Any upload error makes it exit 1 so the run fails and no
// half-filled /work is handed on. Logs only fixed status lines.
//
// Done body: {"folders": [...], "logTruncated": bool}. folders[0] is the
// failing repository, the others are extra repositories; logTruncated
// (optional, default false) says the log was cut to its last part. Both are
// written to WORK_DIR/manifest.json for the Claude wrapper.

import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, promises as fsp, readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { basename, join, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { readTar, TarError } from './tar.ts';

const FOLDER_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const MAX_DONE_BODY = 64 * 1024;
const MAX_WRONG_CODES = 5;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
// Errors that mean "something already sits at this path": drop the entry.
// ENAMETOOLONG: a path the filesystem cannot hold is dropped like a collision.
const COLLISION_CODES = new Set(['EEXIST', 'ENOTDIR', 'EISDIR', 'ELOOP', 'ENAMETOOLONG']);

export interface ReceiverOptions {
  workDir: string;
  uploadCode: string;
  maxBytes: number;
  maxFiles: number;
  onExit: (code: number) => void;
  /** No successful done within this time → exit 1. Omit for no timer. */
  timeoutMs?: number;
}

class UploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function log(line: string): void {
  console.log(`receiver: ${line}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown, done?: () => void): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    connection: 'close',
  });
  if (done) res.end(text, done);
  else res.end(text);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Turns a tar entry name into a safe path relative to the repository folder,
 * with the first component (GitHub's owner-repo-sha/ root) removed. Returns
 * null when the entry must be dropped.
 */
export function safeRelativePath(name: string): string | null {
  if (name === '' || name.includes('\0') || name.includes('\\')) return null;
  if (name.startsWith('/')) return null;
  const parts = name.split('/');
  if (parts.includes('..')) return null;
  const kept = parts.filter((part) => part !== '' && part !== '.');
  if (kept.length < 2) return null;
  return kept.slice(1).join('/');
}

/** Pipes the request body into dest; an interrupted request errors dest. */
function pipeBody(req: IncomingMessage, dest: Writable): void {
  const interrupted = (): void => {
    if (!req.complete) dest.destroy(new UploadError(400, 'upload was interrupted'));
  };
  req.once('aborted', interrupted);
  req.once('error', interrupted);
  req.once('close', interrupted);
  req.pipe(dest);
}

/** Stops feeding dest and drains the rest of the request so the client can read the response. */
function releaseBody(req: IncomingMessage, dest: Writable): void {
  req.unpipe(dest);
  dest.destroy();
  req.resume();
}

function isCollision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && COLLISION_CODES.has(code);
}

export function createReceiver(options: ReceiverOptions): Server {
  const workDir = resolve(options.workDir);
  const reposDir = join(workDir, 'repos');
  const expectedDigest = digest(options.uploadCode);

  const claimed = new Set<string>();
  const completed: string[] = [];
  let logClaimed = false;
  let logDone = false;
  let activeUploads = 0;
  let totalBytes = 0;
  let totalEntries = 0;
  let wrongCodes = 0;
  let closed = false;
  // Set once a done request is accepted; every later request gets 503.
  let finishing = false;
  const refusing = (): boolean => closed || finishing;

  const exit = (code: number): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    options.onExit(code);
  };

  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          log('no upload completed in time, exiting');
          exit(1);
        }, options.timeoutMs)
      : undefined;

  const countBytes = (count: number): void => {
    totalBytes += count;
    if (totalBytes > options.maxBytes) throw new UploadError(413, 'upload is larger than the size limit');
  };

  const countEntry = (): void => {
    totalEntries += 1;
    if (totalEntries > options.maxFiles) throw new UploadError(413, 'upload has too many files');
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
    const given = match?.[1];
    if (given === undefined) return false;
    return timingSafeEqual(digest(given.trim()), expectedDigest);
  };

  const failUpload = (res: ServerResponse, error: unknown): void => {
    let status = 500;
    let message = 'upload failed';
    if (error instanceof UploadError) {
      status = error.status;
      message = error.message;
    } else if (error instanceof TarError) {
      status = 400;
      message = 'upload is not a valid tar archive';
    } else if ((error as { code?: string } | undefined)?.code?.startsWith('Z_')) {
      status = 400;
      message = 'upload is not valid gzip';
    }
    log(`upload failed with status ${status}, exiting`);
    if (res.headersSent || res.destroyed || !res.socket || res.socket.destroyed) {
      res.destroy();
      exit(1);
      return;
    }
    sendJson(res, status, { error: message }, () => exit(1));
    // If the client never reads the response, still exit.
    res.once('close', () => exit(1));
  };

  // --- directory and file helpers (only ever create real files and dirs) ---

  const knownDirs = new Set<string>();

  const ensureDir = async (dir: string, root: string): Promise<boolean> => {
    if (dir === root || knownDirs.has(dir)) return true;
    const parent = resolve(dir, '..');
    if (!(await ensureDir(parent, root))) return false;
    try {
      countEntry();
      await fsp.mkdir(dir, { mode: DIR_MODE });
      await fsp.chmod(dir, DIR_MODE);
    } catch (error) {
      if (error instanceof UploadError) throw error;
      totalEntries -= 1;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (isCollision(error)) return false;
        throw error;
      }
      const stat = await fsp.lstat(dir);
      if (!stat.isDirectory()) return false;
    }
    knownDirs.add(dir);
    return true;
  };

  const writeFile = async (target: string, data: AsyncIterable<Buffer>): Promise<boolean> => {
    let handle: FileHandle;
    try {
      handle = await fsp.open(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        FILE_MODE,
      );
    } catch (error) {
      if (isCollision(error)) return false;
      throw error;
    }
    try {
      await handle.chmod(FILE_MODE);
      for await (const chunk of data) {
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    return true;
  };

  // --- routes ---

  const handleRepo = async (req: IncomingMessage, res: ServerResponse, folder: string): Promise<void> => {
    if (!FOLDER_PATTERN.test(folder)) {
      sendJson(res, 400, { error: 'invalid folder name' });
      return;
    }
    if (claimed.has(folder)) {
      sendJson(res, 409, { error: 'folder already uploaded' });
      return;
    }
    claimed.add(folder);
    activeUploads += 1;
    const folderDir = join(reposDir, folder);
    const gunzip = createGunzip();
    try {
      await fsp.mkdir(reposDir, { recursive: true, mode: DIR_MODE });
      await fsp.mkdir(folderDir, { mode: DIR_MODE });
      await fsp.chmod(folderDir, DIR_MODE);

      pipeBody(req, gunzip);

      for await (const entry of readTar(gunzip, { onDataBytes: countBytes })) {
        if (refusing()) throw new UploadError(503, 'receiver is closed');
        const isFile = entry.type === '0' || entry.type === '\0';
        const isDir = entry.type === '5';
        if (!isFile && !isDir) continue;
        if (isFile && entry.path.endsWith('/')) continue;
        const rel = safeRelativePath(entry.path);
        if (rel === null) continue;
        const target = resolve(folderDir, rel);
        if (!target.startsWith(folderDir + sep)) continue;
        if (isFile && totalBytes + entry.size > options.maxBytes) {
          throw new UploadError(413, 'upload is larger than the size limit');
        }

        if (isDir) {
          await ensureDir(target, folderDir);
          continue;
        }
        if (!(await ensureDir(resolve(target, '..'), folderDir))) continue;
        countEntry();
        if (!(await writeFile(target, entry.data))) totalEntries -= 1;
      }
      completed.push(folder);
      sendJson(res, 200, { ok: true });
      log('repository upload received');
    } catch (error) {
      failUpload(res, error);
    } finally {
      activeUploads -= 1;
      releaseBody(req, gunzip);
    }
  };

  const handleLog = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (logClaimed) {
      sendJson(res, 409, { error: 'log already uploaded' });
      return;
    }
    logClaimed = true;
    activeUploads += 1;
    const body = new PassThrough();
    try {
      await fsp.mkdir(workDir, { recursive: true, mode: DIR_MODE });
      countEntry();
      pipeBody(req, body);
      const counted = async function* (): AsyncGenerator<Buffer> {
        for await (const chunk of body as AsyncIterable<Buffer>) {
          countBytes(chunk.length);
          yield chunk;
        }
      };
      const written = await writeFile(join(workDir, 'log.txt'), counted());
      if (!written) throw new UploadError(409, 'log already present');
      logDone = true;
      sendJson(res, 200, { ok: true });
      log('log upload received');
    } catch (error) {
      failUpload(res, error);
    } finally {
      activeUploads -= 1;
      releaseBody(req, body);
    }
  };

  const readSmallBody = async (req: IncomingMessage): Promise<string | null> => {
    const body = new PassThrough();
    pipeBody(req, body);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_DONE_BODY) return null;
        chunks.push(chunk);
      }
    } finally {
      releaseBody(req, body);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

  const handleDone = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const text = await readSmallBody(req);
    if (text === null) {
      sendJson(res, 413, { error: 'done body is too large' });
      return;
    }
    if (refusing()) {
      sendJson(res, 503, { error: 'receiver is closed' });
      return;
    }
    let folders: unknown;
    let logTruncated: unknown;
    try {
      const body = JSON.parse(text) as { folders?: unknown; logTruncated?: unknown } | null;
      folders = body?.folders;
      logTruncated = body?.logTruncated === undefined ? false : body.logTruncated;
    } catch {
      folders = undefined;
    }
    if (
      !Array.isArray(folders) ||
      !folders.every((f) => typeof f === 'string') ||
      typeof logTruncated !== 'boolean'
    ) {
      sendJson(res, 400, { error: 'body must be {"folders": [...], "logTruncated": true|false}' });
      return;
    }
    const listed = folders as string[];
    const listedSet = new Set(listed);
    const matches =
      logDone &&
      activeUploads === 0 &&
      listedSet.size === listed.length &&
      listed.length === completed.length &&
      completed.length === claimed.size &&
      completed.every((folder) => listedSet.has(folder));
    if (!matches) {
      sendJson(res, 400, { error: 'uploads do not match the done list' });
      return;
    }
    finishing = true;
    await fsp.writeFile(join(workDir, 'manifest.json'), JSON.stringify({ folders: listed, logTruncated }), {
      flag: 'wx',
      mode: FILE_MODE,
    });
    log('all uploads received, exiting');
    sendJson(res, 200, { ok: true }, () => exit(0));
    res.once('close', () => exit(0));
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '';
    const path = url.split('?')[0] ?? '';
    let method: string;
    let action: () => Promise<void>;

    const repoMatch = /^\/upload\/repo\/(.*)$/.exec(path);
    if (repoMatch) {
      method = 'PUT';
      action = () => handleRepo(req, res, repoMatch[1] ?? '');
    } else if (path === '/upload/log') {
      method = 'PUT';
      action = () => handleLog(req, res);
    } else if (path === '/upload/done') {
      method = 'POST';
      action = () => handleDone(req, res);
    } else {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== method) {
      res.setHeader('allow', method);
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (refusing()) {
      sendJson(res, 503, { error: 'receiver is closed' });
      return;
    }
    if (!authorized(req)) {
      wrongCodes += 1;
      log('rejected a request with a missing or wrong upload code');
      if (wrongCodes >= MAX_WRONG_CODES) {
        log('too many wrong upload codes, exiting');
        sendJson(res, 401, { error: 'unauthorized' }, () => exit(1));
        res.once('close', () => exit(1));
        return;
      }
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    await action();
  };

  const server = createServer((req, res) => {
    route(req, res)
      .catch((error: unknown) => {
        failUpload(res, error);
      })
      .finally(() => {
        // Drain any body a rejected request still sends.
        req.resume();
      });
  });
  // Large uploads may take longer than Node's default request timeout;
  // RECEIVE_TIMEOUT_SECONDS bounds the whole receive instead.
  server.requestTimeout = 0;
  server.on('close', () => {
    if (timer) clearTimeout(timer);
  });
  return server;
}

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export function main(): void {
  const env = process.env;
  const codeFile = env.UPLOAD_CODE_FILE || '/secrets/upload/upload-code';
  let uploadCode = '';
  try {
    uploadCode = readFileSync(codeFile, 'utf8').trim();
  } catch {
    uploadCode = '';
  }
  if (uploadCode === '') {
    console.error('receiver: upload code file is missing or empty, exiting');
    process.exit(1);
  }
  const port = positiveInt(env.UPLOAD_PORT, 8080, 65535);
  const server = createReceiver({
    workDir: env.WORK_DIR || '/work',
    uploadCode,
    maxBytes: positiveInt(env.MAX_UPLOAD_BYTES, 524288000),
    maxFiles: positiveInt(env.MAX_UPLOAD_FILES, 200000),
    timeoutMs: positiveInt(env.RECEIVE_TIMEOUT_SECONDS, 600) * 1000,
    onExit: (code) => process.exit(code),
  });
  server.on('error', () => {
    console.error('receiver: could not listen, exiting');
    process.exit(1);
  });
  server.listen(port, () => log('listening'));
}

if (process.argv[1] !== undefined && basename(process.argv[1]) === 'receiver.ts') {
  main();
}
