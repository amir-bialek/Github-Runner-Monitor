// Every Debug it setting, read once at startup from the environment variables
// the Helm chart renders from the debugIt block in values-backend.yaml.
// Secret values (App private key, client secret, encryption keys, Anthropic
// key) are not part of this object: they arrive as secretKeyRef env vars and
// are read by the code that uses them, so this object is safe to log.
import { nonNegativeNumber, positiveInt } from './envConfig.ts';

type Env = Record<string, string | undefined>;

export type CredentialsMode = 'organization' | 'personal';
export type LoginScope = 'debug-it-only' | 'whole-dashboard';

export interface DebugItLimits {
  maxConcurrentRuns: number;
  maxRunsPerUser: number;
  timeLimitMinutes: number;
  spendLimitUsd: number;
  logLimitBytes: number;
  patchLimitBytes: number;
  // 0 means no organization spend limit.
  organizationMonthlySpendLimitUsd: number;
}

export interface DebugItConfig {
  enabled: boolean;
  credentialsMode: CredentialsMode;
  monthlyCap: number;
  loginScope: LoginScope;
  administrators: string[];
  allowedRepositories: string[];
  allowedUsers: string[];
  publicUrl: string;
  githubAppId: string;
  githubAppClientId: string;
  debugNamespace: string;
  // Port of the results listener (story 3.9), opened only when Debug it is enabled.
  resultsPort: number;
  limits: DebugItLimits;
  costTelemetry: { enabled: boolean; endpoint: string };
}

export const DEBUG_IT_DEFAULTS: DebugItConfig = {
  enabled: false,
  credentialsMode: 'organization',
  monthlyCap: 5,
  loginScope: 'debug-it-only',
  administrators: [],
  allowedRepositories: [],
  allowedUsers: [],
  publicUrl: '',
  githubAppId: '',
  githubAppClientId: '',
  debugNamespace: 'debug-it',
  resultsPort: 3002,
  limits: {
    maxConcurrentRuns: 3,
    maxRunsPerUser: 1,
    timeLimitMinutes: 15,
    spendLimitUsd: 2,
    logLimitBytes: 2097152,
    patchLimitBytes: 102400,
    organizationMonthlySpendLimitUsd: 0,
  },
  costTelemetry: { enabled: false, endpoint: '' },
};

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  console.warn(`[WARN] ${name}="${env[name]}" is not true or false — using ${fallback}`);
  return fallback;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  console.warn(`[WARN] ${name}="${raw}" is not one of ${allowed.join(', ')} — using ${fallback}`);
  return fallback;
}

function text(env: Env, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  return raw === undefined || raw === '' ? fallback : raw;
}

// The chart joins lists with commas.
function csv(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

export function loadDebugItConfig(env: Env = process.env): DebugItConfig {
  const d = DEBUG_IT_DEFAULTS;
  return {
    enabled: flag(env, 'DEBUG_IT_ENABLED', d.enabled),
    credentialsMode: oneOf(env, 'DEBUG_IT_CREDENTIALS_MODE', ['organization', 'personal'] as const, d.credentialsMode),
    monthlyCap: positiveInt('DEBUG_IT_MONTHLY_CAP', d.monthlyCap, env),
    loginScope: oneOf(env, 'DEBUG_IT_LOGIN_SCOPE', ['debug-it-only', 'whole-dashboard'] as const, d.loginScope),
    administrators: csv(env, 'DEBUG_IT_ADMINISTRATORS'),
    allowedRepositories: csv(env, 'DEBUG_IT_ALLOWED_REPOSITORIES'),
    allowedUsers: csv(env, 'DEBUG_IT_ALLOWED_USERS'),
    publicUrl: text(env, 'DEBUG_IT_PUBLIC_URL', d.publicUrl),
    githubAppId: text(env, 'DEBUG_IT_GITHUB_APP_ID', d.githubAppId),
    githubAppClientId: text(env, 'DEBUG_IT_GITHUB_APP_CLIENT_ID', d.githubAppClientId),
    debugNamespace: text(env, 'DEBUG_IT_NAMESPACE', d.debugNamespace),
    resultsPort: positiveInt('DEBUG_IT_RESULTS_PORT', d.resultsPort, env),
    limits: {
      maxConcurrentRuns: positiveInt('DEBUG_IT_MAX_CONCURRENT_RUNS', d.limits.maxConcurrentRuns, env),
      maxRunsPerUser: positiveInt('DEBUG_IT_MAX_RUNS_PER_USER', d.limits.maxRunsPerUser, env),
      timeLimitMinutes: positiveInt('DEBUG_IT_TIME_LIMIT_MINUTES', d.limits.timeLimitMinutes, env),
      spendLimitUsd: nonNegativeNumber('DEBUG_IT_SPEND_LIMIT_USD', d.limits.spendLimitUsd, env),
      logLimitBytes: positiveInt('DEBUG_IT_LOG_LIMIT_BYTES', d.limits.logLimitBytes, env),
      patchLimitBytes: positiveInt('DEBUG_IT_PATCH_LIMIT_BYTES', d.limits.patchLimitBytes, env),
      organizationMonthlySpendLimitUsd: nonNegativeNumber(
        'DEBUG_IT_ORGANIZATION_MONTHLY_SPEND_LIMIT_USD',
        d.limits.organizationMonthlySpendLimitUsd,
        env
      ),
    },
    costTelemetry: {
      enabled: flag(env, 'DEBUG_IT_COST_TELEMETRY_ENABLED', d.costTelemetry.enabled),
      endpoint: text(env, 'DEBUG_IT_COST_TELEMETRY_ENDPOINT', d.costTelemetry.endpoint),
    },
  };
}

// Read once, at import (that is, at startup).
export const debugItConfig: DebugItConfig = loadDebugItConfig();
