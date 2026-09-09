import { LRUCache } from 'lru-cache';
import { GitHubClient } from './githubClient.ts';
import type { JobActor } from '../types/github.ts';

export interface RunExtras {
  event: string | null;
  actor: JobActor | null;
}

const RUN_EXTRAS_CACHE_SIZE = parseInt(process.env.RUN_EXTRAS_CACHE_SIZE || '2000');

const MAX_CONCURRENT_LOOKUPS = parseInt(process.env.RUN_EXTRAS_CONCURRENCY || '4');

const extras = new LRUCache<number, RunExtras>({ max: RUN_EXTRAS_CACHE_SIZE });

const asked = new LRUCache<number, true>({ max: RUN_EXTRAS_CACHE_SIZE });

interface PendingLookup {
  owner: string;
  repo: string;
  runId: number;
}

const waiting: PendingLookup[] = [];
let inFlight = 0;

export function extrasFor(runId: number): RunExtras {
  return extras.get(runId) ?? { event: null, actor: null };
}

export function noteRun(owner: string, repo: string, runId: number, token: string | undefined): void {
  if (!token) return;
  if (!Number.isFinite(runId)) return;
  if (asked.has(runId)) return;

  asked.set(runId, true);
  waiting.push({ owner, repo, runId });
  drain(token);
}

function drain(token: string): void {
  while (inFlight < MAX_CONCURRENT_LOOKUPS && waiting.length > 0) {
    const next = waiting.shift()!;
    inFlight++;
    void fetchOne(next, token).finally(() => {
      inFlight--;
      if (waiting.length > 0) drain(token);
    });
  }
}

async function fetchOne({ owner, repo, runId }: PendingLookup, token: string): Promise<void> {
  try {
    const run = await new GitHubClient(token).getWorkflowRun(owner, repo, runId);
    extras.set(runId, {
      event: run.event ?? null,
      actor: run.triggering_actor
        ? { login: run.triggering_actor.login, avatarUrl: run.triggering_actor.avatar_url }
        : null,
    });
  } catch (error: any) {
    console.warn(`[WARN] Could not read run ${runId} in ${owner}/${repo} for its event: ${error.message}`);
  }
}

export function clearRunContextStore(): void {
  extras.clear();
  asked.clear();
  waiting.length = 0;
  inFlight = 0;
}
