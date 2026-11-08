import type { GitHubJob } from './github.ts';

export type WorkflowJobAction = 'queued' | 'in_progress' | 'completed' | 'waiting';

export interface WorkflowJobPayloadJob extends GitHubJob {
  workflow_name: string | null;
  head_branch: string | null;
}

export interface WorkflowJobEvent {
  action: WorkflowJobAction;
  workflow_job: WorkflowJobPayloadJob;
  repository: {
    full_name: string;
    html_url: string;
    name: string;
    owner: { login: string };
  };
  organization?: { login: string };
  sender?: { login: string; avatar_url: string };
}

interface WorkflowRunPayloadUser {
  login: string;
  avatar_url: string;
}

export interface WorkflowRunPayloadRun {
  id: number;
  run_attempt?: number;
  name: string | null;
  head_branch: string | null;
  head_sha: string | null;
  html_url: string;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
  conclusion: string | null;
  event: string | null;
  head_repository?: { full_name: string } | null;
  actor?: WorkflowRunPayloadUser | null;
  triggering_actor?: WorkflowRunPayloadUser | null;
}

export interface WorkflowRunEvent {
  action: string;
  workflow_run: WorkflowRunPayloadRun;
  repository: {
    full_name: string;
  };
  sender?: WorkflowRunPayloadUser;
}
