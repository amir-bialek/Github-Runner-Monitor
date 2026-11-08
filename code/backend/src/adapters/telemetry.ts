// The one door to the cost telemetry collector (AD-1, story 6.1). When cost
// telemetry is on, the backend reports each finished debug run's cost and
// token counts to the collector the claude-code-reviewer-cost Grafana
// dashboard reads, in the format Claude Code itself uses:
//
//   POST {endpoint}/v1/metrics, OTLP/HTTP with a JSON body, optional x-api-key
//   claude_code.cost.usage  (USD, cumulative monotonic sum)
//   claude_code.token.usage (tokens, cumulative monotonic sum, type=input|output)
//   resource: service.name, ci.repo, ci.pr_author, deployment.environment
//   data point: session.id (one per backend process), type (tokens only)
//
// The adapter keeps one cumulative series per (repository, requester) in
// memory, exports right after a run is recorded and then every 60 seconds, as
// an OTel SDK in a long-running process would: Prometheus increase() needs a
// series with more than one sample, so a new series' first export carries a
// zero point one second before its value.
//
// Nothing here may affect a run: recordRun never throws, exports never
// reject, and failures log fixed sentences only (never the endpoint's answer,
// a header or the key). Disabled (off, no endpoint, or USE_MOCK_DATA=true),
// the adapter makes no call, starts no timer and keeps nothing.
import { randomUUID } from 'node:crypto';

export const TELEMETRY_SERVICE_NAME = 'github-runner-monitor-debug-it';
export const TELEMETRY_ENVIRONMENT = 'debug-it';
export const TELEMETRY_INTERVAL_MS = 60_000;
export const TELEMETRY_TIMEOUT_MS = 5_000;
export const COST_METRIC = 'claude_code.cost.usage';
export const TOKEN_METRIC = 'claude_code.token.usage';

/** OTLP AGGREGATION_TEMPORALITY_CUMULATIVE. */
const CUMULATIVE = 2;
const ZERO_POINT_LEAD_MS = 1_000;

export interface TelemetryRun {
  runId: string;
  /** owner/name, from the run record. */
  repository: string;
  /** The requester's GitHub login, from the run record. */
  login: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TelemetryAdapter {
  /** Whether this adapter sends anything at all. */
  readonly enabled: boolean;
  /** Adds a finished run to its series and exports right away; never throws. */
  recordRun(run: TelemetryRun): void;
  /** Exports every series now; never rejects. */
  flush(): Promise<void>;
  /** Stops the periodic export. */
  stop(): void;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect: 'manual';
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  body?: { cancel?: () => Promise<void> } | null;
}>;

export interface TelemetryAdapterOptions {
  enabled: boolean;
  /** The collector's base URL; /v1/metrics is appended. */
  endpoint: string;
  /** Sent as x-api-key when set. */
  apiKey?: string | null;
  fetch?: FetchLike;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  /** session.id of every data point; one random UUID per process by default. */
  instanceId?: string;
}

interface Series {
  repository: string;
  login: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Milliseconds since the epoch: the series start and its zero point. */
  startMs: number;
  /** Whether no export of this series has landed yet (so it still needs its zero point). */
  fresh: boolean;
}

/** The fixed sentences an export failure is logged with. */
export const TELEMETRY_ERRORS = {
  unreachable: 'the collector could not be reached',
  status: (status: number) => `the collector answered with status ${status}`,
  unexpected: 'an unexpected error stopped the export',
} as const;

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function count(value: unknown): number {
  return Math.floor(amount(value));
}

function nanos(ms: number): string {
  return `${Math.floor(ms)}000000`;
}

function str(key: string, value: string): { key: string; value: { stringValue: string } } {
  return { key, value: { stringValue: value } };
}

const disabledAdapter: TelemetryAdapter = {
  enabled: false,
  recordRun() {},
  async flush() {},
  stop() {},
};

export function createTelemetryAdapter(options: TelemetryAdapterOptions): TelemetryAdapter {
  // A base URL is expected; one already ending in /v1/metrics is accepted too.
  const endpoint = (options.endpoint ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1\/metrics$/, '');
  if (!options.enabled || endpoint === '') return disabledAdapter;

  const url = `${endpoint}/v1/metrics`;
  const doFetch: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? TELEMETRY_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? TELEMETRY_TIMEOUT_MS;
  const instanceId = options.instanceId ?? randomUUID();
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';

  const series = new Map<string, Series>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let healthy = true;
  // Sends run one at a time, each taking its snapshot only after the previous
  // POST settled, so an older snapshot never lands after a newer one.
  let chain: Promise<unknown> = Promise.resolve();

  function payload(snapshot: Series[], at: number): string {
    const session = str('session.id', instanceId);
    const resourceMetrics = snapshot.map((s) => {
      const points = <T extends object>(value: T, extra: Array<ReturnType<typeof str>> = []) => {
        const attributes = [session, ...extra];
        const start = nanos(s.startMs);
        const zero = s.fresh ? [{ attributes, startTimeUnixNano: start, timeUnixNano: start, ...zeroOf(value) }] : [];
        return [...zero, { attributes, startTimeUnixNano: start, timeUnixNano: nanos(at), ...value }];
      };
      return {
        resource: {
          attributes: [
            str('service.name', TELEMETRY_SERVICE_NAME),
            str('ci.repo', s.repository),
            str('ci.pr_author', s.login),
            str('deployment.environment', TELEMETRY_ENVIRONMENT),
          ],
        },
        scopeMetrics: [
          {
            scope: { name: TELEMETRY_SERVICE_NAME },
            metrics: [
              {
                name: COST_METRIC,
                unit: 'USD',
                sum: {
                  aggregationTemporality: CUMULATIVE,
                  isMonotonic: true,
                  dataPoints: points({ asDouble: s.costUsd }),
                },
              },
              {
                name: TOKEN_METRIC,
                unit: 'tokens',
                sum: {
                  aggregationTemporality: CUMULATIVE,
                  isMonotonic: true,
                  dataPoints: [
                    ...points({ asInt: String(s.inputTokens) }, [str('type', 'input')]),
                    ...points({ asInt: String(s.outputTokens) }, [str('type', 'output')]),
                  ],
                },
              },
            ],
          },
        ],
      };
    });
    return JSON.stringify({ resourceMetrics });
  }

  function zeroOf(value: object): object {
    return 'asDouble' in value ? { asDouble: 0 } : { asInt: '0' };
  }

  /** Queues one send behind any in flight; answers null when it landed, or the fixed failure reason. */
  function send(): Promise<string | null> {
    const next = chain.then(sendNow, sendNow);
    chain = next;
    return next;
  }

  /** One POST of every series; answers null when it landed, or the fixed failure reason. */
  async function sendNow(): Promise<string | null> {
    try {
      if (series.size === 0) return null;
      const snapshot = [...series.values()].map((s) => ({ ...s }));
      const body = payload(snapshot, now());
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey !== '') headers['x-api-key'] = apiKey;
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body,
          // Never forward the key to a redirect target.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // The error text may hold request details: it is never passed on.
        return TELEMETRY_ERRORS.unreachable;
      }
      // The body is never read.
      try {
        await response.body?.cancel?.();
      } catch {
        // ignore
      }
      const status = typeof response?.status === 'number' ? response.status : 0;
      if (status < 200 || status >= 300) return TELEMETRY_ERRORS.status(status);
      // The collector now has these series' zero points.
      for (const sent of snapshot) {
        const stored = series.get(key(sent.repository, sent.login));
        if (stored && stored.startMs === sent.startMs) stored.fresh = false;
      }
      return null;
    } catch {
      return TELEMETRY_ERRORS.unexpected;
    }
  }

  function key(repository: string, login: string): string {
    return JSON.stringify([repository, login]);
  }

  async function exportForRun(runId: string): Promise<void> {
    const reason = await send();
    if (reason === null) {
      healthy = true;
      return;
    }
    healthy = false;
    console.warn(`[WARN] Debug it cost telemetry could not be sent for run ${runId}: ${reason}.`);
  }

  async function flush(): Promise<void> {
    const reason = await send();
    if (reason === null) {
      healthy = true;
      return;
    }
    if (healthy) {
      console.warn(`[WARN] Debug it cost telemetry could not be sent: ${reason}; it is retried every minute.`);
    }
    healthy = false;
  }

  function startTimer(): void {
    if (timer || stopped) return;
    timer = setInterval(() => void flush(), intervalMs);
    timer.unref?.();
  }

  return {
    enabled: true,
    recordRun(run: TelemetryRun): void {
      try {
        if (stopped || !run || typeof run !== 'object') return;
        const repository = typeof run.repository === 'string' ? run.repository : '';
        const login = typeof run.login === 'string' ? run.login : '';
        if (repository === '' || login === '') return;
        const k = key(repository, login);
        let s = series.get(k);
        if (!s) {
          s = {
            repository,
            login,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            startMs: now() - ZERO_POINT_LEAD_MS,
            fresh: true,
          };
          series.set(k, s);
        }
        s.costUsd += amount(run.costUsd);
        s.inputTokens += count(run.inputTokens);
        s.outputTokens += count(run.outputTokens);
        startTimer();
        void exportForRun(typeof run.runId === 'string' ? run.runId : 'unknown');
      } catch {
        // Telemetry never affects a run.
      }
    },
    flush,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

type Env = Record<string, string | undefined>;

let singleton: TelemetryAdapter | undefined;

/**
 * The adapter of this process. Disabled when cost telemetry is off, its
 * endpoint is empty (with one [WARN]) or USE_MOCK_DATA is true. The settings
 * default to DEBUG_IT_COST_TELEMETRY_ENABLED / _ENDPOINT; the collector key is
 * DEBUG_IT_COST_TELEMETRY_API_KEY (a secretKeyRef env var).
 */
export function getTelemetryAdapter(
  env: Env = process.env,
  settings?: { enabled: boolean; endpoint: string },
): TelemetryAdapter {
  if (singleton) return singleton;
  const enabled = settings?.enabled ?? env.DEBUG_IT_COST_TELEMETRY_ENABLED?.trim().toLowerCase() === 'true';
  const endpoint = (settings?.endpoint ?? env.DEBUG_IT_COST_TELEMETRY_ENDPOINT ?? '').trim();
  if (enabled && endpoint === '') {
    console.warn('[WARN] Debug it cost telemetry is enabled but its endpoint is empty, so no cost telemetry is sent.');
  }
  singleton = createTelemetryAdapter({
    enabled: enabled && env.USE_MOCK_DATA !== 'true',
    endpoint,
    apiKey: env.DEBUG_IT_COST_TELEMETRY_API_KEY ?? null,
  });
  return singleton;
}

/** Stops and forgets the singleton; for tests. */
export function resetTelemetryAdapter(): void {
  singleton?.stop();
  singleton = undefined;
}
