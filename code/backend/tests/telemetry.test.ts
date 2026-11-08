import {
  COST_METRIC,
  createTelemetryAdapter,
  getTelemetryAdapter,
  resetTelemetryAdapter,
  TOKEN_METRIC,
  type TelemetryAdapterOptions,
  type TelemetryRun,
} from '../src/adapters/telemetry';

const warn = console.warn as jest.Mock;
const log = console.log as jest.Mock;
const error = console.error as jest.Mock;

const ENDPOINT = 'https://otel-collector.acme.example:4318';
const COLLECTOR_KEY = ['acme', 'collector', 'test', 'value'].join('-');
const SESSION = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-11-06T10:00:00.000Z');
const RUN_1 = '00000000-0000-4000-8000-000000000001';
const RUN_2 = '00000000-0000-4000-8000-000000000002';

type Init = { method: string; headers: Record<string, string>; body: string; redirect: string; signal?: AbortSignal };

function fakeFetch(answers: Array<number | Error> = [200]) {
  let i = 0;
  return jest.fn(async (_url: string, _init: Init) => {
    const answer = answers[Math.min(i, answers.length - 1)]!;
    i += 1;
    if (answer instanceof Error) throw answer;
    return { status: answer, body: { cancel: async () => undefined } };
  });
}

function run(overrides: Partial<TelemetryRun> = {}): TelemetryRun {
  return {
    runId: RUN_1,
    repository: 'acme/payments-api',
    login: 'dana',
    costUsd: 0.42,
    inputTokens: 1200,
    outputTokens: 300,
    ...overrides,
  };
}

async function flushAsync(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((done) => setImmediate(done));
}

interface Point {
  attributes: Array<{ key: string; value: { stringValue: string } }>;
  startTimeUnixNano: string;
  timeUnixNano: string;
  asDouble?: number;
  asInt?: string;
}

function parse(fetch: ReturnType<typeof fakeFetch>, call = 0) {
  const body = JSON.parse(fetch.mock.calls[call]![1].body) as {
    resourceMetrics: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
      scopeMetrics: Array<{
        metrics: Array<{
          name: string;
          unit: string;
          sum: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: Point[] };
        }>;
      }>;
    }>;
  };
  return body;
}

function attrs(list: Array<{ key: string; value: { stringValue: string } }>): Record<string, string> {
  return Object.fromEntries(list.map((a) => [a.key, a.value.stringValue]));
}

let clock = T0;
let adapters: Array<{ stop(): void }> = [];

function make(options: Partial<TelemetryAdapterOptions> = {}) {
  const fetch = (options.fetch as ReturnType<typeof fakeFetch> | undefined) ?? fakeFetch();
  const adapter = createTelemetryAdapter({
    enabled: true,
    endpoint: ENDPOINT,
    apiKey: COLLECTOR_KEY,
    now: () => clock,
    instanceId: SESSION,
    ...options,
    fetch,
  });
  adapters.push(adapter);
  return { adapter, fetch };
}

function allLogs(): string {
  return [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((a) => a.join(' ')).join('\n');
}

beforeEach(() => {
  clock = T0;
  warn.mockClear();
  log.mockClear();
  error.mockClear();
  resetTelemetryAdapter();
});

afterEach(() => {
  for (const a of adapters.splice(0)) a.stop();
  jest.useRealTimers();
});

describe('recordRun', () => {
  test('a finished run: one POST to /v1/metrics in the OTLP JSON format, with a leading zero point', async () => {
    const { adapter, fetch } = make();
    adapter.recordRun(run());
    await flushAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ENDPOINT}/v1/metrics`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': COLLECTOR_KEY });
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = parse(fetch);
    expect(body.resourceMetrics).toHaveLength(1);
    const rm = body.resourceMetrics[0]!;
    expect(attrs(rm.resource.attributes)).toEqual({
      'service.name': 'github-runner-monitor-debug-it',
      'ci.repo': 'acme/payments-api',
      'ci.pr_author': 'dana',
      'deployment.environment': 'debug-it',
    });
    const metrics = rm.scopeMetrics[0]!.metrics;
    expect(metrics.map((m) => [m.name, m.unit])).toEqual([
      [COST_METRIC, 'USD'],
      [TOKEN_METRIC, 'tokens'],
    ]);
    for (const m of metrics) {
      expect(m.sum.aggregationTemporality).toBe(2);
      expect(m.sum.isMonotonic).toBe(true);
    }
    const start = `${T0 - 1000}000000`;
    const at = `${T0}000000`;
    expect(metrics[0]!.sum.dataPoints).toEqual([
      { attributes: [{ key: 'session.id', value: { stringValue: SESSION } }], startTimeUnixNano: start, timeUnixNano: start, asDouble: 0 },
      { attributes: [{ key: 'session.id', value: { stringValue: SESSION } }], startTimeUnixNano: start, timeUnixNano: at, asDouble: 0.42 },
    ]);
    const tokens = metrics[1]!.sum.dataPoints.map((p) => [attrs(p.attributes).type, p.timeUnixNano, p.asInt]);
    expect(tokens).toEqual([
      ['input', start, '0'],
      ['input', at, '1200'],
      ['output', start, '0'],
      ['output', at, '300'],
    ]);
    for (const p of metrics[1]!.sum.dataPoints) expect(attrs(p.attributes)['session.id']).toBe(SESSION);
  });

  test('a second run of the same series: cumulative values, no zero point', async () => {
    const { adapter, fetch } = make();
    adapter.recordRun(run());
    await flushAsync();
    clock += 5000;
    adapter.recordRun(run({ runId: RUN_2, costUsd: 0.1, inputTokens: 100, outputTokens: 50 }));
    await flushAsync();
    expect(fetch).toHaveBeenCalledTimes(2);
    const metrics = parse(fetch, 1).resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    expect(metrics[0]!.sum.dataPoints).toHaveLength(1);
    expect(metrics[0]!.sum.dataPoints[0]!.asDouble).toBeCloseTo(0.52);
    expect(metrics[0]!.sum.dataPoints[0]!.startTimeUnixNano).toBe(`${T0 - 1000}000000`);
    expect(metrics[1]!.sum.dataPoints.map((p) => p.asInt)).toEqual(['1300', '350']);
  });

  test('another requester or repository gets its own series', async () => {
    const { adapter, fetch } = make();
    adapter.recordRun(run());
    await flushAsync();
    adapter.recordRun(run({ runId: RUN_2, login: 'eli' }));
    await flushAsync();
    const body = parse(fetch, 1);
    expect(body.resourceMetrics.map((rm) => attrs(rm.resource.attributes)['ci.pr_author'])).toEqual(['dana', 'eli']);
    // Only the new series carries a zero point.
    expect(body.resourceMetrics.map((rm) => rm.scopeMetrics[0]!.metrics[0]!.sum.dataPoints.length)).toEqual([1, 2]);
  });

  test('no x-api-key header without a collector key', async () => {
    const { adapter, fetch } = make({ apiKey: null });
    adapter.recordRun(run());
    await flushAsync();
    expect(fetch.mock.calls[0]![1].headers).toEqual({ 'content-type': 'application/json' });
  });

  test('a trailing slash on the endpoint is dropped', async () => {
    const { adapter, fetch } = make({ endpoint: `${ENDPOINT}/` });
    adapter.recordRun(run());
    await flushAsync();
    expect(fetch.mock.calls[0]![0]).toBe(`${ENDPOINT}/v1/metrics`);
  });

  test('an endpoint already ending in /v1/metrics is not doubled', async () => {
    const { adapter, fetch } = make({ endpoint: `${ENDPOINT}/v1/metrics/` });
    adapter.recordRun(run());
    await flushAsync();
    expect(fetch.mock.calls[0]![0]).toBe(`${ENDPOINT}/v1/metrics`);
  });

  test('overlapping sends run in order: the second POST waits for the first, zero point only in the first', async () => {
    const releases: Array<() => void> = [];
    const fetch = jest.fn(
      (_url: string, _init: Init) =>
        new Promise<{ status: number }>((resolve) => releases.push(() => resolve({ status: 200 }))),
    );
    const { adapter } = make({ fetch: fetch as unknown as ReturnType<typeof fakeFetch> });
    adapter.recordRun(run());
    clock += 5000;
    adapter.recordRun(run({ runId: RUN_2, costUsd: 0.1 }));
    await flushAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    releases[0]!();
    await flushAsync();
    expect(fetch).toHaveBeenCalledTimes(2);
    releases[1]!();
    await flushAsync();
    const cost = (call: number) =>
      parse(fetch as unknown as ReturnType<typeof fakeFetch>, call).resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.sum.dataPoints;
    expect(cost(0).map((p) => p.asDouble)).toEqual([0, 0.52]);
    expect(cost(1)).toHaveLength(1);
    expect(cost(1)[0]!.asDouble).toBeCloseTo(0.52);
    expect(warn).not.toHaveBeenCalled();
  });

  test('the payload holds only the listed fields: no key, token, run ID or result text', async () => {
    const { adapter, fetch } = make();
    adapter.recordRun({
      ...run(),
      explanation: 'The refunds test expects a currency field.',
      patch: 'diff --git a/x b/x',
      apiKey: 'sk-ant-api03-test-key-acme',
    } as unknown as TelemetryRun);
    await flushAsync();
    const body = fetch.mock.calls[0]![1].body;
    for (const secret of [COLLECTOR_KEY, RUN_1, 'sk-ant-api03-test-key-acme', 'refunds', 'diff --git']) {
      expect(body).not.toContain(secret);
    }
  });

  test('a first export that fails keeps the zero point for the next one', async () => {
    const { adapter, fetch } = make({ fetch: fakeFetch([503, 200]) });
    adapter.recordRun(run());
    await flushAsync();
    await adapter.flush();
    const points = parse(fetch, 1).resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.sum.dataPoints;
    expect(points.map((p) => p.asDouble)).toEqual([0, 0.42]);
  });

  test('bad numbers count as zero and a missing repository or login records nothing', async () => {
    const { adapter, fetch } = make();
    adapter.recordRun(run({ costUsd: Number.NaN, inputTokens: -5, outputTokens: Infinity }));
    await flushAsync();
    const metrics = parse(fetch).resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    expect(metrics[0]!.sum.dataPoints[1]!.asDouble).toBe(0);
    expect(metrics[1]!.sum.dataPoints.map((p) => p.asInt)).toEqual(['0', '0', '0', '0']);
    fetch.mockClear();
    adapter.recordRun(run({ repository: '' }));
    adapter.recordRun(run({ login: undefined as unknown as string }));
    await flushAsync();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  test.each([
    ['fetch rejects', new Error(`connect ECONNREFUSED ${ENDPOINT} ${COLLECTOR_KEY}`), 'the collector could not be reached'],
    ['500', 500, 'the collector answered with status 500'],
    ['a redirect', 302, 'the collector answered with status 302'],
  ])('%s: one [WARN] with the run ID and a fixed reason, no secret', async (_name, answer, reason) => {
    const { adapter } = make({ fetch: fakeFetch([answer]) });
    expect(() => adapter.recordRun(run())).not.toThrow();
    await flushAsync();
    expect(warn.mock.calls.map((a) => a.join(' '))).toEqual([
      `[WARN] Debug it cost telemetry could not be sent for run ${RUN_1}: ${reason}.`,
    ]);
    expect(allLogs()).not.toContain(COLLECTOR_KEY);
    expect(allLogs()).not.toContain('otel-collector');
  });

  test('a fetch that throws synchronously is still caught', async () => {
    const fetch = jest.fn(() => {
      throw new Error('boom');
    }) as unknown as ReturnType<typeof fakeFetch>;
    const { adapter } = make({ fetch });
    expect(() => adapter.recordRun(run())).not.toThrow();
    await flushAsync();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('periodic exports warn once going from healthy to failing, again only after recovering', async () => {
    const { adapter, fetch } = make({ fetch: fakeFetch([200, 500, 500, 500, 200, 500]) });
    adapter.recordRun(run());
    await flushAsync();
    await adapter.flush();
    await adapter.flush();
    await adapter.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[WARN\] Debug it cost telemetry could not be sent: the collector answered with status 500/);
    await adapter.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    await adapter.flush();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});

describe('periodic export', () => {
  test('every 60 s with every series, starting only after the first run', async () => {
    jest.useFakeTimers();
    const { adapter, fetch } = make({ now: () => Date.now() });
    jest.advanceTimersByTime(180_000);
    expect(fetch).not.toHaveBeenCalled();
    // Sends are queued, so each one starts a few microtasks later.
    const settle = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };
    adapter.recordRun(run());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    adapter.stop();
    jest.advanceTimersByTime(600_000);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('flush with no series sends nothing', async () => {
    const { adapter, fetch } = make();
    await adapter.flush();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('disabled', () => {
  test.each([
    ['off', { enabled: false }],
    ['no endpoint', { endpoint: '' }],
    ['blank endpoint', { endpoint: '   ' }],
  ])('%s: no fetch, no timer, nothing kept', async (_name, options) => {
    jest.useFakeTimers();
    const { adapter, fetch } = make(options);
    expect(adapter.enabled).toBe(false);
    adapter.recordRun(run());
    await adapter.flush();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(600_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('getTelemetryAdapter: off by default', () => {
    expect(getTelemetryAdapter({}).enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test('getTelemetryAdapter: enabled without an endpoint warns once and is disabled', () => {
    const adapter = getTelemetryAdapter({}, { enabled: true, endpoint: '' });
    expect(adapter.enabled).toBe(false);
    expect(getTelemetryAdapter({}, { enabled: true, endpoint: '' })).toBe(adapter);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[WARN\] Debug it cost telemetry is enabled but its endpoint is empty/);
  });

  test('getTelemetryAdapter: USE_MOCK_DATA=true is disabled', () => {
    expect(getTelemetryAdapter({ USE_MOCK_DATA: 'true' }, { enabled: true, endpoint: ENDPOINT }).enabled).toBe(false);
  });

  test('getTelemetryAdapter: DEBUG_IT_COST_TELEMETRY_API_KEY becomes the x-api-key header', async () => {
    const original = globalThis.fetch;
    const fetch = fakeFetch();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      const adapter = getTelemetryAdapter({ DEBUG_IT_COST_TELEMETRY_API_KEY: COLLECTOR_KEY }, { enabled: true, endpoint: ENDPOINT });
      adapter.recordRun(run());
      await flushAsync();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]![1].headers['x-api-key']).toBe(COLLECTOR_KEY);
    } finally {
      resetTelemetryAdapter();
      globalThis.fetch = original;
    }
  });

  test('getTelemetryAdapter: reads the env when no settings are given', () => {
    const adapter = getTelemetryAdapter({
      DEBUG_IT_COST_TELEMETRY_ENABLED: 'true',
      DEBUG_IT_COST_TELEMETRY_ENDPOINT: ENDPOINT,
      DEBUG_IT_COST_TELEMETRY_API_KEY: COLLECTOR_KEY,
    });
    expect(adapter.enabled).toBe(true);
    resetTelemetryAdapter();
  });
});
