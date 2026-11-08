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

/** What a history row points at: a job, or a failed run that never started a job. */
export interface HistoryTarget {
  kind: 'job' | 'run';
  id: number;
}

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
  target: HistoryTarget;
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

// Debug it (2.x) session, read from GET /debug-it/session.
export type LoginScope = 'debug-it-only' | 'whole-dashboard';

export type DebugItSession =
  | { state: 'disabled' }
  | { state: 'signed-out'; loginScope: LoginScope }
  | {
      state: 'signed-in';
      githubUserId: number;
      login: string;
      csrfToken: string;
      allowedUser: boolean;
      administrator: boolean;
      loginScope: LoginScope;
      /** How Debug it runs are paid for (story 5.1); organization when the answer did not say. */
      credentialsMode: DebugItCredentialsMode;
    };

/** How Debug it runs are paid for: the organization key or each user's personal key. */
export type DebugItCredentialsMode = 'organization' | 'personal';

// The signed in user's personal Anthropic API key (story 5.2), from
// /debug-it/personal-key. Only the last 4 characters are ever answered.
export interface PersonalKeyStatus {
  credentialsMode: DebugItCredentialsMode;
  saved: boolean;
  last4: string | null;
}

/** DELETE /debug-it/personal-key also says how many waiting runs it cancelled. */
export interface PersonalKeyDeleted extends PersonalKeyStatus {
  cancelledRuns: number;
}

// Debug it settings (administrators only), from GET /debug-it/settings.
export interface DebugItAllowedUser {
  githubUserId: number;
  /** The current GitHub login, or null when it could not be looked up. */
  login: string | null;
}

/** The startup isolation check status (story 3.6). */
export interface DebugItIsolationStatus {
  state: 'checking' | 'on' | 'off';
  /** One sentence; null when on. */
  reason: string | null;
  /** ISO 8601 UTC, set when the check ended. */
  checkedAt: string | null;
}

export interface DebugItSettingsView {
  allowedRepositories: string[];
  allowedUsers: DebugItAllowedUser[];
  isolation?: DebugItIsolationStatus;
}

// Debug it usage of the current UTC month (story 3.13), from GET /debug-it/usage.
export interface DebugItUsageRow {
  githubUserId: number;
  /** The current GitHub login, or null when it could not be looked up. */
  login: string | null;
  runs: number;
  costUsd: number;
  fixPullRequests: number;
}

export interface DebugItUsageView {
  /** The UTC month, as YYYY-MM. */
  month: string;
  credentialsMode: DebugItCredentialsMode;
  /** The monthly run cap per user in organization mode; null in personal mode. */
  monthlyCap: number | null;
  users: DebugItUsageRow[];
}

// Debug it runs (story 3.11), from /debug-it/runs and /debug-it/targets/{kind}/{id}/runs.
export type DebugRunState = 'waiting' | 'cloning' | 'analyzing' | 'finished' | 'failed';

export interface DebugRunView {
  runId: string;
  target: HistoryTarget;
  state: DebugRunState;
  createdAt: string;
  updatedAt: string;
  elapsedMs: number;
  repository: string;
  jobName: string;
  /** Why a failed run failed: one sentence, or null. */
  failureReason: string | null;
}

/** POST answers 200 with existing: true when a run already holds the target. */
export type DebugRunStart = DebugRunView & { existing?: true };

// Debug run result and feedback (story 3.12), from /debug-it/runs/{runId}/result and /feedback.
export type DebugCauseLocation =
  | { kind: 'this-repository' | 'workflow-file' | 'runner' | 'infrastructure' | 'unknown' }
  | { kind: 'extra-repository'; repository: string };

export interface DebugRunResult {
  explanation: string;
  causeLocation: DebugCauseLocation;
  /** A unified diff; empty when no change was proposed. */
  patch: string;
  costUsd: number;
  durationMs: number;
  logTruncated: boolean;
  failureReason: 'none' | 'time-limit' | 'spend-limit' | 'error';
}

export type DebugFeedbackRating = 'useful' | 'not-useful';

export interface DebugRunFeedback {
  rating: DebugFeedbackRating;
  comment: string | null;
  at: string;
}

export interface DebugRunDownload {
  repository: string;
  commitSha: string;
  folder: string;
}

export interface DebugRunResultView {
  run: DebugRunView;
  result: DebugRunResult | null;
  downloads: DebugRunDownload[];
  skippedRepositories: Array<{ repository: string; reason: string }>;
  feedback: DebugRunFeedback | null;
  /** Only the person who started the run may rate a run with a result. */
  canGiveFeedback: boolean;
  /** Whether the patch may become fix pull requests (story 4.1); null when there is no result. */
  patchCheck?: DebugPatchCheck | null;
  /** The fix pull requests already opened for this run (story 4.3); shown to every viewer. */
  fixPullRequests?: DebugFixPullRequest[];
  /** The repositories for which this viewer is offered Open a PR (story 4.3). */
  canOpenPullRequest?: string[];
}

/** A rule a debug run's patch can break (story 4.1). */
export type DebugPatchRule =
  | 'too-large'
  | 'unreadable'
  | 'outside-downloads'
  | 'outside-repository'
  | 'git-internals'
  | 'workflow-file'
  | 'symbolic-link'
  | 'file-mode';

/** The backend's check of a debug run's patch, per repository (story 4.1). */
export interface DebugPatchCheck {
  status: 'empty' | 'passed' | 'refused';
  rule: DebugPatchRule | null;
  message: string | null;
  repositories: Array<{
    repository: string;
    folder: string;
    files: string[];
    status: 'passed' | 'refused';
    rule: DebugPatchRule | null;
    message: string | null;
  }>;
}

/** What POST /debug-it/runs/{runId}/pull-requests/{owner}/{name} answers (story 4.2). */
export interface DebugFixPullRequest {
  repository: string;
  url: string;
  /** True when the pull request was opened before and is answered again. */
  existing?: boolean;
}

export interface DebugFeedbackInput {
  rating: DebugFeedbackRating;
  comment?: string | null;
}

/** GET /debug-it/runs: the allowed repositories and the user's latest run per target. */
export interface DebugItRunsOverview {
  allowedRepositories: string[];
  runs: DebugRunView[];
}
