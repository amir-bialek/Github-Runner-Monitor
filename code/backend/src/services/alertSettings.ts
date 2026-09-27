export const MAX_THRESHOLD_MINUTES = 7 * 24 * 60;
const MAX_WEBHOOK_URL_LENGTH = 2048;

export interface AlertRuleSettings {
  enabled: boolean;
  thresholdMinutes: number;
}

export interface AlertSettings {
  queueWait: AlertRuleSettings;
  runnerGroupOffline: AlertRuleSettings;
  webhookUrl: string | null;
}

export interface AlertSettingsOverride {
  queueWait?: Partial<AlertRuleSettings>;
  runnerGroupOffline?: Partial<AlertRuleSettings>;
  webhookUrl?: string | null;
}

export type SettingsSource = 'deployment' | 'ui';

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  console.warn(`${name}="${process.env[name]}" is not true or false — using ${fallback}`);
  return fallback;
}

function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!isValidThreshold(parsed)) {
    console.warn(`${name}="${raw}" is not a whole number of minutes between 1 and ${MAX_THRESHOLD_MINUTES} — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function envWebhookUrl(): string | null {
  const raw = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return null;
  const problem = webhookUrlProblem(raw);
  if (problem) {
    console.warn(`ALERT_WEBHOOK_URL is ignored: ${problem}`);
    return null;
  }
  return raw;
}

function isValidThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_THRESHOLD_MINUTES;
}

function webhookUrlProblem(value: string): string | null {
  if (value.length > MAX_WEBHOOK_URL_LENGTH) return `the webhook URL is longer than ${MAX_WEBHOOK_URL_LENGTH} characters`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'the webhook URL is not a valid URL';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'the webhook URL must start with http:// or https://';
  if (parsed.username || parsed.password) return 'the webhook URL must not contain a username or password';
  return null;
}

export function deploymentDefaults(): AlertSettings {
  return {
    queueWait: {
      enabled: envBoolean('ALERT_QUEUE_WAIT_ENABLED', true),
      thresholdMinutes: envMinutes('ALERT_QUEUE_WAIT_MINUTES', 15),
    },
    runnerGroupOffline: {
      enabled: envBoolean('ALERT_RUNNER_GROUP_OFFLINE_ENABLED', true),
      thresholdMinutes: envMinutes('ALERT_RUNNER_GROUP_OFFLINE_MINUTES', 10),
    },
    webhookUrl: envWebhookUrl(),
  };
}

export function settingsEditable(): boolean {
  return envBoolean('ALERT_SETTINGS_EDITABLE', true);
}

export function applyOverride(base: AlertSettings, override: AlertSettingsOverride | null): AlertSettings {
  if (!override) return base;
  return {
    queueWait: { ...base.queueWait, ...override.queueWait },
    runnerGroupOffline: { ...base.runnerGroupOffline, ...override.runnerGroupOffline },
    webhookUrl: override.webhookUrl !== undefined ? override.webhookUrl : base.webhookUrl,
  };
}

export function mergeOverrides(current: AlertSettingsOverride | null, patch: AlertSettingsOverride): AlertSettingsOverride {
  const merged: AlertSettingsOverride = { ...current };
  if (patch.queueWait) merged.queueWait = { ...current?.queueWait, ...patch.queueWait };
  if (patch.runnerGroupOffline) merged.runnerGroupOffline = { ...current?.runnerGroupOffline, ...patch.runnerGroupOffline };
  if (patch.webhookUrl !== undefined) merged.webhookUrl = patch.webhookUrl;
  return merged;
}

export type ParseResult = { ok: true; value: AlertSettingsOverride } | { ok: false; errors: string[] };

function parseRule(raw: unknown, label: string, errors: string[]): Partial<AlertRuleSettings> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  const rule: Partial<AlertRuleSettings> = {};
  const { enabled, thresholdMinutes } = raw as Record<string, unknown>;
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') errors.push(`${label}.enabled must be true or false`);
    else rule.enabled = enabled;
  }
  if (thresholdMinutes !== undefined) {
    if (!isValidThreshold(thresholdMinutes)) {
      errors.push(`${label}.thresholdMinutes must be a whole number of minutes between 1 and ${MAX_THRESHOLD_MINUTES}`);
    } else {
      rule.thresholdMinutes = thresholdMinutes;
    }
  }
  return rule;
}

export function parseOverride(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['The request body must be a JSON object'] };
  }
  const body = raw as Record<string, unknown>;
  const errors: string[] = [];
  const value: AlertSettingsOverride = {};

  const queueWait = parseRule(body.queueWait, 'queueWait', errors);
  if (queueWait) value.queueWait = queueWait;
  const runnerGroupOffline = parseRule(body.runnerGroupOffline, 'runnerGroupOffline', errors);
  if (runnerGroupOffline) value.runnerGroupOffline = runnerGroupOffline;

  if (body.webhookUrl !== undefined) {
    if (body.webhookUrl === null || body.webhookUrl === '') {
      value.webhookUrl = null;
    } else if (typeof body.webhookUrl !== 'string') {
      errors.push('webhookUrl must be a string or null');
    } else {
      const trimmed = body.webhookUrl.trim();
      const problem = webhookUrlProblem(trimmed);
      if (problem) errors.push(problem.charAt(0).toUpperCase() + problem.slice(1));
      else value.webhookUrl = trimmed;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export function maskWebhookUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hasMore = parsed.pathname.length > 1 || parsed.search.length > 0;
    return `${parsed.protocol}//${parsed.host}${hasMore ? '/…' : ''}`;
  } catch {
    return '…';
  }
}
