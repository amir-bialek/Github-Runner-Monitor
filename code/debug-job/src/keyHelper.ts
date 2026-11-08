// Debug Job key helper (native sidecar). The only holder of the Anthropic key:
// Claude Code talks to it with a dummy key through ANTHROPIC_BASE_URL, and it
// forwards each request to api.anthropic.com with the real key. Listens only on
// 127.0.0.1. Logs only fixed status lines, never the key or any header value.

import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename } from 'node:path';

const LISTEN_HOST = '127.0.0.1';
/** The only upstream main() ever uses. */
export const UPSTREAM = { protocol: 'https:', hostname: 'api.anthropic.com', port: 443 } as const;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);
const DROPPED_REQUEST_HEADERS = new Set(['x-api-key', 'authorization', 'host', 'proxy-authorization']);

export interface Upstream {
  protocol: 'https:' | 'http:';
  hostname: string;
  port: number;
  ca?: string | Buffer;
}

export interface KeyHelperOptions {
  apiKey: string;
  upstream: Upstream;
}

function log(line: string): void {
  console.log(`key helper: ${line}`);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const text = JSON.stringify({ error: message });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Header names listed in a Connection header are hop-by-hop too. */
function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  const tokens = new Set<string>();
  if (typeof value === 'string') {
    for (const token of value.split(',')) {
      const name = token.trim().toLowerCase();
      if (name) tokens.add(name);
    }
  }
  return tokens;
}

function filterHeaders(headers: IncomingHttpHeaders, extraDropped: Set<string>): OutgoingHttpHeaders {
  const listed = connectionTokens(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || listed.has(lower) || extraDropped.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

export function createKeyHelper(options: KeyHelperOptions): Server {
  const { apiKey, upstream } = options;
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const noExtra = new Set<string>();

  return createServer((req, res) => {
    const target = req.url ?? '';
    if (!target.startsWith('/') || target.startsWith('//')) {
      log('rejected a request with an invalid target');
      req.resume();
      sendError(res, 400, 'invalid request target');
      return;
    }

    const headers = filterHeaders(req.headers, DROPPED_REQUEST_HEADERS);
    headers['x-api-key'] = apiKey;

    const upstreamReq = send({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method ?? 'GET',
      path: target,
      headers,
      ...(upstream.ca !== undefined ? { ca: upstream.ca } : {}),
    });

    upstreamReq.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, filterHeaders(upstreamRes.headers, noExtra));
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });

    upstreamReq.on('error', () => {
      // The client went away first and we aborted the upstream call: nothing to report.
      if (res.destroyed || res.writableEnded) return;
      log('upstream request failed');
      if (res.headersSent) {
        res.destroy();
      } else {
        req.resume();
        sendError(res, 502, 'upstream request failed');
      }
    });

    // The client went away: stop the upstream call too.
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.on('error', () => upstreamReq.destroy());

    req.pipe(upstreamReq);
  });
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

export function main(): void {
  const keyFile = process.env.ANTHROPIC_KEY_FILE || '/secrets/anthropic/api-key';
  let apiKey = '';
  try {
    apiKey = readFileSync(keyFile, 'utf8').trim();
  } catch {
    apiKey = '';
  }
  if (apiKey === '') {
    console.error('key helper: key file is missing or empty, exiting');
    process.exit(1);
  }
  const port = positiveInt(process.env.KEY_HELPER_PORT, 8081);
  const server = createKeyHelper({ apiKey, upstream: { ...UPSTREAM } });
  server.on('error', () => {
    console.error('key helper: could not listen, exiting');
    process.exit(1);
  });
  server.listen(port, LISTEN_HOST, () => log('listening'));
}

if (process.argv[1] !== undefined && basename(process.argv[1]) === 'keyHelper.ts') {
  main();
}
