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
