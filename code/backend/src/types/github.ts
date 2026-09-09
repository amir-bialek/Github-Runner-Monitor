export interface GitHubRunner {
  id: number;
  name: string;
  os: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: Array<{
    id: number;
    name: string;
    type: 'read-only' | 'custom';
  }>;
}

export interface GitHubRunnersResponse {
  total_count: number;
  runners: GitHubRunner[];
}

export interface GitHubJob {
  id: number;
  run_id: number;
  run_url: string;
  run_attempt: number;
  node_id: string;
  head_sha: string;
  url: string;
  html_url: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  name: string;
  steps: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
    started_at: string | null;
    completed_at: string | null;
  }>;
  check_run_url: string;
  labels: string[];
  runner_id: number | null;
  runner_name: string | null;
  runner_group_id: number | null;
  runner_group_name: string | null;
}

export interface GitHubJobsResponse {
  total_count: number;
  jobs: GitHubJob[];
  capped: boolean;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  node_id: string;
  head_branch: string;
  head_sha: string;
  path: string;
  display_title: string;
  run_number: number;
  event: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  workflow_id: number;
  check_suite_id: number;
  check_suite_node_id: string;
  url: string;
  html_url: string;
  pull_requests: Array<{
    url: string;
    id: number;
    number: number;
    head: {
      ref: string;
      sha: string;
      repo: {
        id: number;
        name: string;
        url: string;
      };
    };
    base: {
      ref: string;
      sha: string;
      repo: {
        id: number;
        name: string;
        url: string;
      };
    };
  }>;
  created_at: string;
  updated_at: string;
  actor: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    site_admin: boolean;
  };
  run_attempt: number;
  referenced_workflows: any[];
  run_started_at: string;
  triggering_actor: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    site_admin: boolean;
  };
  jobs_url: string;
  logs_url: string;
  check_suite_url: string;
  artifacts_url: string;
  cancel_url: string;
  rerun_url: string;
  previous_attempt_url: string | null;
  workflow_url: string;
  head_commit: {
    id: string;
    tree_id: string;
    message: string;
    timestamp: string;
    author: {
      name: string;
      email: string;
    };
    committer: {
      name: string;
      email: string;
    };
  };
  repository: {
    id: number;
    node_id: string;
    name: string;
    full_name: string;
    private: boolean;
    owner: {
      login: string;
      id: number;
      node_id: string;
      avatar_url: string;
      gravatar_id: string;
      url: string;
      html_url: string;
      followers_url: string;
      following_url: string;
      gists_url: string;
      starred_url: string;
      subscriptions_url: string;
      organizations_url: string;
      repos_url: string;
      events_url: string;
      received_events_url: string;
      type: string;
      site_admin: boolean;
    };
    html_url: string;
    description: string;
    fork: boolean;
    url: string;
    archive_url: string;
    assignees_url: string;
    blobs_url: string;
    branches_url: string;
    collaborators_url: string;
    comments_url: string;
    commits_url: string;
    compare_url: string;
    contents_url: string;
    contributors_url: string;
    deployments_url: string;
    downloads_url: string;
    events_url: string;
    forks_url: string;
    git_commits_url: string;
    git_refs_url: string;
    git_tags_url: string;
    git_url: string;
    issue_comment_url: string;
    issue_events_url: string;
    issues_url: string;
    keys_url: string;
    labels_url: string;
    languages_url: string;
    merges_url: string;
    milestones_url: string;
    notifications_url: string;
    pulls_url: string;
    releases_url: string;
    ssh_url: string;
    stargazers_url: string;
    statuses_url: string;
    subscribers_url: string;
    subscription_url: string;
    tags_url: string;
    teams_url: string;
    trees_url: string;
    clone_url: string;
    mirror_url: string;
    hooks_url: string;
    svn_url: string;
    homepage: string;
    language: string | null;
    forks_count: number;
    stargazers_count: number;
    watchers_count: number;
    size: number;
    default_branch: string;
    open_issues_count: number;
    is_template: boolean;
    topics: string[];
    has_issues: boolean;
    has_projects: boolean;
    has_wiki: boolean;
    has_pages: boolean;
    has_downloads: boolean;
    archived: boolean;
    disabled: boolean;
    visibility: string;
    pushed_at: string;
    created_at: string;
    updated_at: string;
  };
  head_repository: {
    id: number;
    node_id: string;
    name: string;
    full_name: string;
    private: boolean;
    owner: {
      login: string;
      id: number;
      node_id: string;
      avatar_url: string;
      gravatar_id: string;
      url: string;
      html_url: string;
      followers_url: string;
      following_url: string;
      gists_url: string;
      starred_url: string;
      subscriptions_url: string;
      organizations_url: string;
      repos_url: string;
      events_url: string;
      received_events_url: string;
      type: string;
      site_admin: boolean;
    };
    html_url: string;
    description: string;
    fork: boolean;
    url: string;
    archive_url: string;
    assignees_url: string;
    blobs_url: string;
    branches_url: string;
    collaborators_url: string;
    comments_url: string;
    commits_url: string;
    compare_url: string;
    contents_url: string;
    contributors_url: string;
    deployments_url: string;
    downloads_url: string;
    events_url: string;
    forks_url: string;
    git_commits_url: string;
    git_refs_url: string;
    git_tags_url: string;
    git_url: string;
    issue_comment_url: string;
    issue_events_url: string;
    issues_url: string;
    keys_url: string;
    labels_url: string;
    languages_url: string;
    merges_url: string;
    milestones_url: string;
    notifications_url: string;
    pulls_url: string;
    releases_url: string;
    ssh_url: string;
    stargazers_url: string;
    statuses_url: string;
    subscribers_url: string;
    subscription_url: string;
    tags_url: string;
    teams_url: string;
    trees_url: string;
    clone_url: string;
    mirror_url: string;
    hooks_url: string;
    svn_url: string;
    homepage: string;
    language: string | null;
    forks_count: number;
    stargazers_count: number;
    watchers_count: number;
    size: number;
    default_branch: string;
    open_issues_count: number;
    is_template: boolean;
    topics: string[];
    has_issues: boolean;
    has_projects: boolean;
    has_wiki: boolean;
    has_pages: boolean;
    has_downloads: boolean;
    archived: boolean;
    disabled: boolean;
    visibility: string;
    pushed_at: string;
    created_at: string;
    updated_at: string;
  };
}

export interface GitHubWorkflowRunsResponse {
  total_count: number;
  workflow_runs: GitHubWorkflowRun[];
}

export interface WorkflowRunsOptions {
  status?: 'queued' | 'in_progress' | 'completed';
  per_page?: number;
  page?: number;
  created?: string;
  exclude_pull_requests?: boolean;
  check_suite_id?: number;
  head_sha?: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  pushed_at: string;
  archived: boolean;
  disabled: boolean;
}

export enum GitHubAPIErrorType {
  AUTHENTICATION = 'AUTHENTICATION',
  RATE_LIMIT = 'RATE_LIMIT',
  NOT_FOUND = 'NOT_FOUND',
  SERVER_ERROR = 'SERVER_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  FORBIDDEN = 'FORBIDDEN',
  UNKNOWN = 'UNKNOWN'
}

export interface APIError {
  type: GitHubAPIErrorType;
  message: string;
  statusCode?: number | undefined;
  retryAfter?: number | undefined;
  endpoint: string;
  timestamp: Date;
  rateLimitRemaining?: number | undefined;
  rateLimitReset?: Date | undefined;
}

export interface CircuitBreakerState {
  failures: number;
  lastFailure: Date | null;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  nextAttempt: Date | null;
}

export interface RunnerAvailability {
  total: number;
  online: number;
  offline: number;
  busy: number;
  free: number;
}

export interface ScaleSetInfo {
  id: string;
  name: string;
  runnerCount: number;
  onlineRunners: number;
}

export interface InternalRunner extends GitHubRunner {
  availability: RunnerAvailability;
  scaleSet: ScaleSetInfo | null;
  lastSeen: string;
}

export interface ScaleSetSummary {
  id: string;
  name: string;
  totalRunners: number;
  online: number;
  busy: number;
  free: number;
}

export interface InternalJob extends GitHubJob {
  duration: number | null;
  repository: string | null;
  workflowName: string | null;
}

export interface JobHistorySummary {
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  successRate: number;
  averageDuration: number | null;
  recentJobs: InternalJob[];
}

export interface JobQueueStatus {
  queued: number;
  inProgress: number;
  completed: number;
  waiting: number;
  requested: number;
}

export type JobResult = 'success' | 'failure' | 'cancelled' | 'timed_out' | 'other';

export interface JobActor {
  login: string;
  avatarUrl: string;
}

export interface RunContext {
  workflowName: string | null;
  branch: string | null;
  actor: JobActor | null;
  event: string | null;
  runUrl: string;
}

export interface JobQueueItem {
  id: number;
  name: string;
  workflowName: string | null;
  branch: string | null;
  actor: JobActor | null;
  event: string | null;
  repository: string;
  repositoryUrl: string;
  scaleSet: string | null;
  position: number;
  createdAt: string;
  waitMs: number;
  htmlUrl: string;
  runUrl: string;
}

export interface JobRunningItem {
  id: number;
  name: string;
  workflowName: string | null;
  branch: string | null;
  actor: JobActor | null;
  event: string | null;
  repository: string;
  repositoryUrl: string;
  runnerName: string | null;
  scaleSet: string | null;
  startedAt: string | null;
  runningMs: number | null;
  htmlUrl: string;
  runUrl: string;
}

export interface JobHistoryItem {
  id: number;
  name: string;
  workflowName: string | null;
  branch: string | null;
  actor: JobActor | null;
  event: string | null;
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
  runUrl: string;
}
