import type { JobQueueItem, ScaleSetSummary } from '../types/github.ts';
import {
  applyOverride,
  deploymentDefaults,
  mergeOverrides,
  type AlertSettings,
  type AlertSettingsOverride,
  type SettingsSource,
} from './alertSettings.ts';
import { describeLocation, persistenceEnabled, readJsonObject, writeJsonObject } from './statePersistence.ts';

const SETTINGS_KEY = process.env.ALERT_STATE_S3_KEY || 'github-runner-monitor/alert-state.json';
const EVALUATION_INTERVAL_MS = parseFloat(process.env.ALERT_EVALUATION_INTERVAL_SECONDS || '30') * 1000;
const WEBHOOK_TIMEOUT_MS = 5000;
const FORGET_GROUP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOBS_PER_ALERT = 20;
export const UNKNOWN_POOL = 'unknown';

export type AlertKind = 'queue_wait' | 'runner_group_offline';

export interface AlertJob {
  id: number;
  name: string;
  repository: string;
  htmlUrl: string;
  createdAt: string;
  waitMs: number;
}

export interface Alert {
  id: string;
  kind: AlertKind;
  scaleSet: string | null;
  thresholdMinutes: number;
  since: string;
  firedAt: string;
  message: string;
  jobCount?: number;
  jobs?: AlertJob[];
  totalRunners?: number;
}

interface GroupState {
  lastSeenAt: number;
  darkSince: number | null;
  totalRunners: number;
}

export interface WebhookStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface PersistedAlertState {
  version: 1;
  savedAt: string;
  override: AlertSettingsOverride | null;
  groups: Record<string, GroupState>;
  active?: Alert[];
}

export interface EvaluationInput {
  queue: JobQueueItem[];
  scaleSets: ScaleSetSummary[] | null;
}

type Deliver = (url: string, body: unknown) => Promise<void>;

let override: AlertSettingsOverride | null = null;
let groups = new Map<string, GroupState>();
let active = new Map<string, Alert>();
let evaluatedAt: number | null = null;
let webhookStatus: WebhookStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null };
let deliver: Deliver = postJson;
let dirty = false;

export function currentSettings(): AlertSettings {
  return applyOverride(deploymentDefaults(), override);
}

export function settingsSource(): SettingsSource {
  return override ? 'ui' : 'deployment';
}

export function currentWebhookStatus(): WebhookStatus {
  return { ...webhookStatus };
}

export async function updateSettings(patch: AlertSettingsOverride): Promise<AlertSettings> {
  override = mergeOverrides(override, patch);
  dirty = true;
  await saveAlertState();
  return currentSettings();
}

export async function resetSettings(): Promise<AlertSettings> {
  override = null;
  dirty = true;
  await saveAlertState();
  return currentSettings();
}

function minutesLabel(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function poolLabel(scaleSet: string | null): string {
  return scaleSet ?? 'an unknown pool';
}

function queueWaitAlerts(queue: JobQueueItem[], settings: AlertSettings, now: number): Alert[] {
  if (!settings.queueWait.enabled) return [];
  const thresholdMs = settings.queueWait.thresholdMinutes * 60_000;
  const byPool = new Map<string, AlertJob[]>();

  for (const item of queue) {
    const created = new Date(item.createdAt).getTime();
    if (!Number.isFinite(created)) continue;
    const waitMs = now - created;
    if (waitMs < thresholdMs) continue;
    const key = item.scaleSet ?? UNKNOWN_POOL;
    const list = byPool.get(key) ?? [];
    list.push({ id: item.id, name: item.name, repository: item.repository, htmlUrl: item.htmlUrl, createdAt: item.createdAt, waitMs });
    byPool.set(key, list);
  }

  return [...byPool.entries()].map(([key, jobs]) => {
    jobs.sort((a, b) => b.waitMs - a.waitMs);
    const scaleSet = key === UNKNOWN_POOL ? null : key;
    const oldest = jobs[0]!;
    const count = jobs.length === 1 ? '1 job has' : `${jobs.length} jobs have`;
    return {
      id: `queue_wait:${key}`,
      kind: 'queue_wait' as const,
      scaleSet,
      thresholdMinutes: settings.queueWait.thresholdMinutes,
      since: oldest.createdAt,
      firedAt: new Date(now).toISOString(),
      message: `${count} waited longer than ${minutesLabel(settings.queueWait.thresholdMinutes)} for ${poolLabel(scaleSet)}`,
      jobCount: jobs.length,
      jobs: jobs.slice(0, MAX_JOBS_PER_ALERT),
    };
  });
}

function trackGroups(scaleSets: ScaleSetSummary[], now: number): void {
  const seen = new Set<string>();
  for (const pool of scaleSets) {
    seen.add(pool.id);
    const previous = groups.get(pool.id);
    const darkSince = pool.online > 0 ? null : previous?.darkSince ?? now;
    if (!previous || previous.darkSince !== darkSince || previous.totalRunners !== pool.totalRunners) dirty = true;
    groups.set(pool.id, { lastSeenAt: now, darkSince, totalRunners: pool.totalRunners });
  }

  for (const [id, state] of groups) {
    if (seen.has(id)) continue;
    if (now - state.lastSeenAt > FORGET_GROUP_AFTER_MS) {
      groups.delete(id);
      dirty = true;
      continue;
    }
    if (state.darkSince === null || state.totalRunners !== 0) {
      groups.set(id, { ...state, darkSince: state.darkSince ?? now, totalRunners: 0 });
      dirty = true;
    }
  }
}

function groupOfflineAlerts(settings: AlertSettings, now: number): Alert[] {
  if (!settings.runnerGroupOffline.enabled) return [];
  const thresholdMs = settings.runnerGroupOffline.thresholdMinutes * 60_000;
  const alerts: Alert[] = [];

  for (const [id, state] of groups) {
    if (state.darkSince === null || now - state.darkSince < thresholdMs) continue;
    const detail = state.totalRunners === 0
      ? 'has no runners registered'
      : `has 0 of ${state.totalRunners} runners online`;
    alerts.push({
      id: `runner_group_offline:${id}`,
      kind: 'runner_group_offline',
      scaleSet: id,
      thresholdMinutes: settings.runnerGroupOffline.thresholdMinutes,
      since: new Date(state.darkSince).toISOString(),
      firedAt: new Date(now).toISOString(),
      message: `${id} ${detail} for longer than ${minutesLabel(settings.runnerGroupOffline.thresholdMinutes)}`,
      totalRunners: state.totalRunners,
    });
  }
  return alerts;
}

export async function evaluate(input: EvaluationInput, now = Date.now()): Promise<Alert[]> {
  const settings = currentSettings();
  if (input.scaleSets) trackGroups(input.scaleSets, now);

  const next = [...queueWaitAlerts(input.queue, settings, now)];
  if (input.scaleSets) {
    next.push(...groupOfflineAlerts(settings, now));
  } else if (settings.runnerGroupOffline.enabled) {
    for (const alert of active.values()) {
      if (alert.kind === 'runner_group_offline') next.push(alert);
    }
  }

  const nextActive = new Map<string, Alert>();
  const fired: Alert[] = [];
  for (const alert of next) {
    const previous = active.get(alert.id);
    if (previous) {
      nextActive.set(alert.id, { ...alert, firedAt: previous.firedAt });
    } else {
      nextActive.set(alert.id, alert);
      fired.push(alert);
    }
  }
  const resolved = [...active.values()].filter(alert => !nextActive.has(alert.id));

  active = nextActive;
  evaluatedAt = now;
  if (fired.length > 0 || resolved.length > 0) dirty = true;

  if (settings.webhookUrl) {
    const url = settings.webhookUrl;
    const deliveries = [
      ...fired.map(alert => notify(url, 'alert.fired', alert, now)),
      ...resolved.map(alert => notify(url, 'alert.resolved', alert, now)),
    ];
    await Promise.all(deliveries);
  }

  if (dirty) await saveAlertState();
  return activeAlerts();
}

export function activeAlerts(): Alert[] {
  return [...active.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'runner_group_offline' ? -1 : 1;
    return new Date(a.since).getTime() - new Date(b.since).getTime();
  });
}

export function rememberedGroups(): string[] {
  return [...groups.keys()];
}

export function lastEvaluatedAt(): string | null {
  return evaluatedAt === null ? null : new Date(evaluatedAt).toISOString();
}

function webhookText(event: 'alert.fired' | 'alert.resolved', alert: Alert): string {
  return event === 'alert.fired' ? `:warning: ${alert.message}` : `:white_check_mark: Resolved: ${alert.message}`;
}

async function notify(url: string, event: 'alert.fired' | 'alert.resolved', alert: Alert, now: number): Promise<void> {
  webhookStatus = { ...webhookStatus, lastAttemptAt: new Date(now).toISOString() };
  try {
    await deliver(url, {
      source: 'github-runner-monitor',
      event,
      text: webhookText(event, alert),
      alert,
      sentAt: new Date(now).toISOString(),
    });
    webhookStatus = { ...webhookStatus, lastSuccessAt: new Date(now).toISOString(), lastError: null };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    webhookStatus = { ...webhookStatus, lastError: message };
    console.error(`[ERROR] Alert webhook delivery failed: ${message}`);
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'github-runner-monitor' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The webhook answered HTTP ${response.status}`);
}

export async function sendTestNotification(now = Date.now()): Promise<WebhookStatus> {
  const url = currentSettings().webhookUrl;
  if (!url) throw new Error('No webhook URL is configured');
  const alert: Alert = {
    id: 'test',
    kind: 'queue_wait',
    scaleSet: null,
    thresholdMinutes: currentSettings().queueWait.thresholdMinutes,
    since: new Date(now).toISOString(),
    firedAt: new Date(now).toISOString(),
    message: 'Test notification from GitHub Runner Monitor',
  };
  await notify(url, 'alert.fired', alert, now);
  return currentWebhookStatus();
}

function serializeState(): PersistedAlertState {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    override,
    groups: Object.fromEntries(groups),
    active: [...active.values()],
  };
}

function isGroupState(value: unknown): value is GroupState {
  const state = value as GroupState | null;
  return (
    !!state &&
    typeof state.lastSeenAt === 'number' &&
    (state.darkSince === null || typeof state.darkSince === 'number') &&
    typeof state.totalRunners === 'number'
  );
}

export function restoreAlertState(raw: unknown): void {
  const state = raw as Partial<PersistedAlertState> | null;
  if (!state || typeof state !== 'object') return;
  if (state.override && typeof state.override === 'object') override = state.override;
  if (state.groups && typeof state.groups === 'object') {
    groups = new Map(Object.entries(state.groups).filter(([, value]) => isGroupState(value)) as [string, GroupState][]);
  }
  if (Array.isArray(state.active)) {
    active = new Map(
      state.active
        .filter(alert => alert && typeof alert.id === 'string' && typeof alert.firedAt === 'string')
        .map(alert => [alert.id, alert] as [string, Alert])
    );
  }
}

export async function loadAlertState(): Promise<void> {
  if (!persistenceEnabled()) return;
  try {
    const raw = await readJsonObject(SETTINGS_KEY);
    if (raw === null) {
      console.log('[AUDIT] No saved alert settings yet — using the deployment values');
      return;
    }
    restoreAlertState(raw);
    console.log(`[AUDIT] Restored alert settings from ${describeLocation(SETTINGS_KEY)}`);
  } catch (error: any) {
    console.error(`[ERROR] Could not read the saved alert settings: ${error?.message ?? error}`);
  }
}

export async function saveAlertState(): Promise<void> {
  if (!persistenceEnabled()) {
    dirty = false;
    return;
  }
  try {
    await writeJsonObject(SETTINGS_KEY, serializeState());
    dirty = false;
  } catch (error: any) {
    console.error(`[ERROR] Could not save the alert settings: ${error?.message ?? error}`);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startAlertLoop(gather: () => Promise<EvaluationInput>): void {
  if (timer) return;
  const tick = async () => {
    try {
      await evaluate(await gather());
    } catch (error: any) {
      console.error(`[ERROR] Alert evaluation failed: ${error?.message ?? error}`);
    }
  };
  void tick();
  timer = setInterval(() => void tick(), EVALUATION_INTERVAL_MS);
  timer.unref?.();
}

export function stopAlertLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function setDeliverForTests(fn: Deliver | null): void {
  deliver = fn ?? postJson;
}

export function resetAlertsForTests(): void {
  override = null;
  groups = new Map();
  active = new Map();
  evaluatedAt = null;
  webhookStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null };
  deliver = postJson;
  dirty = false;
}
