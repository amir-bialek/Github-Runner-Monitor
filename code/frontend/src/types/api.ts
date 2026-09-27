export interface RunnerLabel {
  id: number;
  name: string;
  type: string;
}

export interface RunnerAvailability {
  total: number;
  online: number;
  offline: number;
  busy: number;
  free: number;
}

export interface RunnerScaleSetSummary {
  id: string;
  name: string;
  runnerCount: number;
  onlineRunners: number;
}

export interface Runner {
  id: number;
  name: string;
  os: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: RunnerLabel[];
  availability: RunnerAvailability;
  scaleSet: RunnerScaleSetSummary;
  lastSeen: string;
}

export interface ScaleSet {
  id: string;
  name: string;
  totalRunners: number;
  online: number;
  busy: number;
  free: number;
}

export interface JobActor {
  login: string;
  avatarUrl: string;
}

export interface JobIdentityFields {
  branch: string | null;
  actor: JobActor | null;
  event: string | null;
  runUrl: string;
}

export interface QueueItem extends JobIdentityFields {
  id: number;
  name: string;
  workflowName: string | null;
  repository: string;
  repositoryUrl: string;
  scaleSet: string | null;
  position: number;
  createdAt: string;
  waitMs: number;
  htmlUrl: string;
}

export interface QueueResponse {
  orderingIsEstimate: boolean;
  note: string;
  incomplete: boolean;
  items: QueueItem[];
}

export interface RunningJob extends JobIdentityFields {
  id: number;
  name: string;
  workflowName: string | null;
  repository: string;
  repositoryUrl: string;
  runnerName: string | null;
  scaleSet: string | null;
  startedAt: string | null;
  runningMs: number | null;
  htmlUrl: string;
}

export interface RunningResponse {
  orderingIsEstimate: boolean;
  note: string;
  incomplete: boolean;
  total?: number;
  items: RunningJob[];
}

export type JobResult = 'success' | 'failure' | 'cancelled' | 'timed_out' | 'other';

export interface HistoryJob extends JobIdentityFields {
  id: number;
  name: string;
  workflowName: string | null;
  repository: string;
  repositoryUrl: string;
  result: JobResult;
  runnerName: string | null;
  scaleSet: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  htmlUrl: string;
}

export interface BackendSettings {
  runnersRefreshSeconds: number;
}

export interface ApiErrorBody {
  error: string;
}

export type AlertKind = 'queue_wait' | 'runner_group_offline';

export interface AlertJob {
  id: number;
  name: string;
  repository: string;
  htmlUrl: string;
  createdAt: string;
  waitMs: number;
}

export interface MonitorAlert {
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

export interface AlertsResponse {
  evaluatedAt: string | null;
  alerts: MonitorAlert[];
}

export interface AlertRuleSettings {
  enabled: boolean;
  thresholdMinutes: number;
}

export interface PublicAlertSettings {
  queueWait: AlertRuleSettings;
  runnerGroupOffline: AlertRuleSettings;
  webhookConfigured: boolean;
  webhookUrlMasked: string | null;
}

export interface WebhookStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface AlertSettingsResponse {
  settings: PublicAlertSettings;
  deploymentDefaults: PublicAlertSettings;
  source: 'deployment' | 'ui';
  editable: boolean;
  persisted: boolean;
  webhookStatus: WebhookStatus;
}

export interface AlertSettingsUpdate {
  queueWait?: Partial<AlertRuleSettings>;
  runnerGroupOffline?: Partial<AlertRuleSettings>;
  webhookUrl?: string | null;
}
