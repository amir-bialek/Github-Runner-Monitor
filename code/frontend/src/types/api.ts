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
