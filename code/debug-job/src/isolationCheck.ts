// Debug it startup isolation check (FR31, AD-7, story 3.6). The backend runs
// this program once at startup in a short Job with the Debug Job labels, so
// the debug-it-job NetworkPolicy applies to it unchanged. Every forbidden
// target the wrapper probes (github.com, api.github.com, 169.254.169.254, the
// Kubernetes API, the backend main port, outside DNS) must stay silent, and
// the Anthropic API must answer. Prints only fixed "isolation check: " lines,
// never a response body or anything from the environment.
//
// Exit codes: 0 all forbidden targets silent and Anthropic reached; 3 a
// forbidden target answered; 4 Anthropic not reached; 5 both; 2 the
// configuration is missing or invalid.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename } from 'node:path';
import { checkIsolation, defaultProbes, PROBE_TIMEOUT_MS } from './wrapper.ts';
import type { Probes } from './wrapper.ts';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/models';
export const ANTHROPIC_TIMEOUT_MS = 10_000;

export const EXIT_PASSED = 0;
export const EXIT_CONFIG = 2;
export const EXIT_FORBIDDEN_REACHED = 3;
export const EXIT_ANTHROPIC_UNREACHED = 4;
export const EXIT_BOTH = 5;

export const CONFIG_ERROR = 'isolation check: configuration is missing or invalid, exiting';

export interface IsolationCheckOptions {
  probes: Probes;
  anthropicUrl: string;
  /** Timeout of the Anthropic request; each probe waits at most min(timeoutMs, 3 s). */
  timeoutMs?: number;
}

export interface IsolationCheckConfig {
  resultsUrl: string;
  backendMainPort: number;
}

function log(line: string): void {
  console.log(`isolation check: ${line}`);
}

function strictPort(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  return port > 0 && port < 65536 ? port : null;
}

/** Reads RESULTS_URL (for the backend host) and BACKEND_MAIN_PORT (default 3001). Null when invalid. */
export function parseCheckConfig(env: NodeJS.ProcessEnv): IsolationCheckConfig | null {
  const resultsUrl = env.RESULTS_URL?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(resultsUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    return null;
  }
  const backendMainPort = strictPort(env.BACKEND_MAIN_PORT, 3001);
  if (backendMainPort === null) return null;
  return { resultsUrl, backendMainPort };
}

/** True when the URL gives any HTTP answer (any status) within timeoutMs. The body is never read. */
export function reachesHttp(target: string, timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      done(false);
      return;
    }
    const send = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : null;
    if (send === null) {
      done(false);
      return;
    }
    let finished = false;
    const finish = (answered: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      done(answered);
    };
    const req = send(url, { method: 'GET', headers: { accept: 'application/json' } }, (res) => {
      res.resume();
      finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    req.once('error', () => finish(false));
    req.end();
  });
}

/** Runs both checks and returns the exit code. */
export async function runIsolationCheck(options: IsolationCheckOptions): Promise<number> {
  const timeoutMs = options.timeoutMs ?? ANTHROPIC_TIMEOUT_MS;
  const [isolated, anthropic] = await Promise.all([
    checkIsolation(options.probes, Math.min(timeoutMs, PROBE_TIMEOUT_MS)),
    reachesHttp(options.anthropicUrl, timeoutMs),
  ]);
  log(isolated ? 'every forbidden target stayed silent' : 'a forbidden target answered');
  log(anthropic ? 'the Anthropic API answered' : 'the Anthropic API could not be reached');
  if (!isolated && !anthropic) return EXIT_BOTH;
  if (!isolated) return EXIT_FORBIDDEN_REACHED;
  if (!anthropic) return EXIT_ANTHROPIC_UNREACHED;
  log('passed');
  return EXIT_PASSED;
}

export function main(): void {
  const env = process.env;
  const config = parseCheckConfig(env);
  if (config === null) {
    console.error(CONFIG_ERROR);
    process.exit(EXIT_CONFIG);
  }
  runIsolationCheck({
    probes: defaultProbes(env, config.resultsUrl, config.backendMainPort),
    anthropicUrl: ANTHROPIC_URL,
    timeoutMs: ANTHROPIC_TIMEOUT_MS,
  })
    .then((code) => process.exit(code))
    .catch(() => {
      console.error('isolation check: unexpected failure, exiting');
      process.exit(1);
    });
}

if (process.argv[1] !== undefined && basename(process.argv[1]) === 'isolationCheck.ts') {
  main();
}
