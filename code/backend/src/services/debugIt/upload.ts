// The upload client for a Debug Job's receiver (AD-17). The backend streams
// the log and each repository tarball to the pod's receiver: PUT /upload/log
// (text), PUT /upload/repo/{folder} (gzip tar), then POST /upload/done with
// the manifest. Each request carries only the run's upload code as a Bearer
// credential and a content type; no GitHub token or address is ever sent.
// Bodies are piped, never buffered whole.
import http from 'http';
import https from 'https';
import type { Readable } from 'stream';

/** Where a run's receiver listens and the code it accepts. */
export interface UploadTarget {
  /** The receiver's base address, for example http://10.0.0.12:8080. */
  baseUrl: string;
  uploadCode: string;
}

export interface UploadManifest {
  folders: string[];
  logTruncated: boolean;
}

export interface Uploader {
  putLog(target: UploadTarget, text: Buffer | string): Promise<void>;
  /** Pipes `body` (a gzip tarball) to the receiver as /work/repos/{folder}. */
  putRepo(target: UploadTarget, folder: string, body: Readable): Promise<void>;
  done(target: UploadTarget, manifest: UploadManifest): Promise<void>;
}

/** The receiver refused a request or could not be reached. Holds only the status. */
export class UploadError extends Error {
  /** The HTTP status the receiver answered, or null when it gave none. */
  readonly status: number | null;

  constructor(status: number | null) {
    super(
      status === null
        ? 'The Debug Job receiver could not be reached.'
        : `The Debug Job receiver refused the upload (status ${status}).`,
    );
    this.name = 'UploadError';
    this.status = status;
  }
}

// The same rule the receiver applies to a folder name.
const FOLDER = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** How long an upload's socket may sit idle before the upload is abandoned (10 minutes); not a limit on the whole upload. */
export const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

type Body = { kind: 'buffer'; data: Buffer } | { kind: 'stream'; data: Readable };

function send(target: UploadTarget, method: 'PUT' | 'POST', path: string, contentType: string, body: Body): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, target.baseUrl);
    } catch {
      reject(new UploadError(null));
      return;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      reject(new UploadError(null));
      return;
    }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) {
        req.destroy();
        if (body.kind === 'stream') body.data.destroy();
        reject(error);
      } else {
        resolve();
      }
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${target.uploadCode}`,
      'Content-Type': contentType,
    };
    if (body.kind === 'buffer') headers['Content-Length'] = String(body.data.length);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers, timeout: UPLOAD_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      // The answer body is not needed; drain it so the socket is freed.
      res.resume();
      if (status < 200 || status > 299) {
        finish(new UploadError(status || null));
        return;
      }
      res.once('end', () => finish());
      res.once('error', () => finish(new UploadError(status)));
    });
    req.once('timeout', () => finish(new UploadError(null)));
    req.once('error', () => finish(new UploadError(null)));
    if (body.kind === 'buffer') {
      req.end(body.data);
      return;
    }
    // A failing source (GitHub, or the size counter) rejects with its own error.
    body.data.once('error', (error: Error) => finish(error));
    body.data.pipe(req);
  });
}

/** An uploader over Node's http client. */
export function createHttpUploader(): Uploader {
  return {
    putLog(target, text) {
      const data = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
      return send(target, 'PUT', '/upload/log', 'text/plain; charset=utf-8', { kind: 'buffer', data });
    },
    putRepo(target, folder, body) {
      if (!FOLDER.test(folder)) {
        body.destroy();
        return Promise.reject(new UploadError(null));
      }
      return send(target, 'PUT', `/upload/repo/${folder}`, 'application/gzip', { kind: 'stream', data: body });
    },
    done(target, manifest) {
      const data = Buffer.from(JSON.stringify({ folders: manifest.folders, logTruncated: manifest.logTruncated }), 'utf8');
      return send(target, 'POST', '/upload/done', 'application/json', { kind: 'buffer', data });
    },
  };
}
