import express from 'express';
import request from 'supertest';
import { app } from '../src/app';
import { DEBUG_IT_DEFAULTS, debugItConfig, loadDebugItConfig } from '../src/services/debugItConfig';
import { nonNegativeNumber, positiveInt } from '../src/services/envConfig';
import { registerDebugIt } from '../src/routes/debugIt';
import { createSessionService } from '../src/services/session';
import { createMockGitHubApp } from '../src/adapters/githubApp';

process.env.USE_MOCK_DATA = 'true';
process.env.GITHUB_ORGANIZATION = 'test-org';

const warn = console.warn as jest.Mock;

beforeEach(() => warn.mockClear());

describe('loadDebugItConfig', () => {
  test('is off with the FR29 defaults when nothing is set', () => {
    const config = loadDebugItConfig({});
    expect(config).toEqual(DEBUG_IT_DEFAULTS);
    expect(config.enabled).toBe(false);
    expect(config.credentialsMode).toBe('organization');
    expect(config.monthlyCap).toBe(5);
    expect(config.loginScope).toBe('debug-it-only');
    expect(config.costTelemetry.enabled).toBe(false);
    expect(config.limits.organizationMonthlySpendLimitUsd).toBe(0);
    expect(config.resultsPort).toBe(3002);
    expect(warn).not.toHaveBeenCalled();
  });

  test('reads every value the chart renders', () => {
    const config = loadDebugItConfig({
      DEBUG_IT_ENABLED: 'true',
      DEBUG_IT_CREDENTIALS_MODE: 'personal',
      DEBUG_IT_MONTHLY_CAP: '7',
      DEBUG_IT_LOGIN_SCOPE: 'whole-dashboard',
      DEBUG_IT_ADMINISTRATORS: '1000001, 1000002',
      DEBUG_IT_ALLOWED_REPOSITORIES: 'acme/payments-api,acme/checkout-web',
      DEBUG_IT_ALLOWED_USERS: '1000003',
      DEBUG_IT_PUBLIC_URL: 'https://runner-monitor.acme.example',
      DEBUG_IT_GITHUB_APP_ID: '123456',
      DEBUG_IT_GITHUB_APP_CLIENT_ID: 'Iv1.acmepaymentsapi',
      DEBUG_IT_NAMESPACE: 'acme-debug',
      DEBUG_IT_RESULTS_PORT: '4002',
      DEBUG_IT_MAX_CONCURRENT_RUNS: '4',
      DEBUG_IT_MAX_RUNS_PER_USER: '2',
      DEBUG_IT_TIME_LIMIT_MINUTES: '20',
      DEBUG_IT_SPEND_LIMIT_USD: '2.5',
      DEBUG_IT_LOG_LIMIT_BYTES: '1048576',
      DEBUG_IT_PATCH_LIMIT_BYTES: '51200',
      DEBUG_IT_ORGANIZATION_MONTHLY_SPEND_LIMIT_USD: '150.75',
      DEBUG_IT_COST_TELEMETRY_ENABLED: 'true',
      DEBUG_IT_COST_TELEMETRY_ENDPOINT: 'https://telemetry.acme.example',
    });
    expect(config).toEqual({
      enabled: true,
      credentialsMode: 'personal',
      monthlyCap: 7,
      loginScope: 'whole-dashboard',
      administrators: ['1000001', '1000002'],
      allowedRepositories: ['acme/payments-api', 'acme/checkout-web'],
      allowedUsers: ['1000003'],
      publicUrl: 'https://runner-monitor.acme.example',
      githubAppId: '123456',
      githubAppClientId: 'Iv1.acmepaymentsapi',
      debugNamespace: 'acme-debug',
      resultsPort: 4002,
      limits: {
        maxConcurrentRuns: 4,
        maxRunsPerUser: 2,
        timeLimitMinutes: 20,
        spendLimitUsd: 2.5,
        logLimitBytes: 1048576,
        patchLimitBytes: 51200,
        organizationMonthlySpendLimitUsd: 150.75,
      },
      costTelemetry: { enabled: true, endpoint: 'https://telemetry.acme.example' },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('empty lists from the chart become empty arrays', () => {
    const config = loadDebugItConfig({ DEBUG_IT_ALLOWED_USERS: '', DEBUG_IT_ALLOWED_REPOSITORIES: ' , ' });
    expect(config.allowedUsers).toEqual([]);
    expect(config.allowedRepositories).toEqual([]);
  });

  test('a bad monthly cap warns and falls back to 5', () => {
    const config = loadDebugItConfig({ DEBUG_IT_MONTHLY_CAP: 'x' });
    expect(config.monthlyCap).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[WARN\] DEBUG_IT_MONTHLY_CAP="x"/));
  });

  test.each([
    ['DEBUG_IT_RESULTS_PORT', 'abc', (c: ReturnType<typeof loadDebugItConfig>) => c.resultsPort, 3002],
    ['DEBUG_IT_MAX_CONCURRENT_RUNS', '0', (c: ReturnType<typeof loadDebugItConfig>) => c.limits.maxConcurrentRuns, 3],
    ['DEBUG_IT_LOG_LIMIT_BYTES', '-1', (c: ReturnType<typeof loadDebugItConfig>) => c.limits.logLimitBytes, 2097152],
    ['DEBUG_IT_SPEND_LIMIT_USD', 'two', (c: ReturnType<typeof loadDebugItConfig>) => c.limits.spendLimitUsd, 2],
    ['DEBUG_IT_ORGANIZATION_MONTHLY_SPEND_LIMIT_USD', '-5', (c: ReturnType<typeof loadDebugItConfig>) => c.limits.organizationMonthlySpendLimitUsd, 0],
  ])('%s="%s" warns and falls back', (name, raw, pick, fallback) => {
    expect(pick(loadDebugItConfig({ [name]: raw }))).toBe(fallback);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[WARN] ${name}=`));
  });

  test('unknown enum and flag values warn and fall back to the safe default', () => {
    const config = loadDebugItConfig({
      DEBUG_IT_ENABLED: 'yes please',
      DEBUG_IT_CREDENTIALS_MODE: 'shared',
      DEBUG_IT_LOGIN_SCOPE: 'everything',
    });
    expect(config.enabled).toBe(false);
    expect(config.credentialsMode).toBe('organization');
    expect(config.loginScope).toBe('debug-it-only');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  test('DEBUG_IT_ENABLED false is off', () => {
    expect(loadDebugItConfig({ DEBUG_IT_ENABLED: 'false' }).enabled).toBe(false);
  });
});

describe('envConfig helpers', () => {
  test('positiveInt keeps the 1.x parseInt behavior', () => {
    expect(positiveInt('X', 9, { X: '12' })).toBe(12);
    expect(positiveInt('X', 9, { X: '12abc' })).toBe(12);
    expect(positiveInt('X', 9, {})).toBe(9);
    expect(positiveInt('X', 9, { X: '0' })).toBe(9);
  });

  test('nonNegativeNumber accepts decimals and zero', () => {
    expect(nonNegativeNumber('X', 1, { X: '0' })).toBe(0);
    expect(nonNegativeNumber('X', 1, { X: '0.25' })).toBe(0.25);
    expect(nonNegativeNumber('X', 1, { X: '  ' })).toBe(1);
    expect(nonNegativeNumber('X', 1, { X: 'Infinity' })).toBe(1);
  });
});

describe('Debug it off', () => {
  test('the app under test runs with Debug it off', () => {
    expect(debugItConfig.enabled).toBe(false);
  });

  test('registerDebugIt mounts nothing', () => {
    const fresh = express();
    expect(registerDebugIt(fresh, DEBUG_IT_DEFAULTS)).toBe(false);
  });

  test.each(['/debug-it', '/debug-it/session', '/debug-it/runs'])('GET %s is 404', async path => {
    await request(app).get(path).expect(404);
  });

  test('1.x routes answer without any cookie', async () => {
    await request(app).get('/health').expect(200);
    await request(app).get('/runners').expect(200);
    await request(app).get('/settings').expect(200);
  });
});

describe('Debug it on', () => {
  test('registerDebugIt mounts the /debug-it router', () => {
    const fresh = express();
    const session = createSessionService(Buffer.alloc(32, 7), { secure: false });
    expect(
      registerDebugIt(fresh, { ...DEBUG_IT_DEFAULTS, enabled: true }, { session, githubApp: createMockGitHubApp(), env: {} }),
    ).toBe(true);
  });
});
