import crypto from 'node:crypto';
import express from 'express';
import { LRUCache } from 'lru-cache';
import { GitHubClient } from '../services/githubClient.ts';
import { isKeepableFailedRun, keepFailedRun, upsert } from '../services/jobStore.ts';
import { noteRun } from '../services/runContextStore.ts';
import type { WorkflowJobEvent, WorkflowRunEvent } from '../types/webhook.ts';

export const WEBHOOK_PATH = '/webhooks/github';

const BODY_LIMIT = process.env.WEBHOOK_BODY_LIMIT || '5mb';

const pendingRunChecks = new Set<Promise<void>>();

const seenDeliveries = new LRUCache<string, true>({
  max: parseInt(process.env.WEBHOOK_DEDUPE_SIZE || '5000'),
});

export function verifySignature(rawBody: Buffer, signatureHeader: unknown, secret: string): boolean {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  const given = Buffer.from(signatureHeader);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;

  return crypto.timingSafeEqual(given, want);
}

export function createWebhookRouter(): express.Router {
  const router = express.Router();

  router.post(
    WEBHOOK_PATH,
    express.raw({ type: () => true, limit: BODY_LIMIT }),
    (req, res) => {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[ERROR] GITHUB_WEBHOOK_SECRET is not set — refusing every webhook delivery');
        res.status(500).json({ error: 'Webhook secret not configured' });
        return;
      }

      const raw = req.body;
      if (!Buffer.isBuffer(raw)) {
        res.status(400).json({ error: 'Expected a raw body' });
        return;
      }

      if (!verifySignature(raw, req.get('X-Hub-Signature-256'), secret)) {
        console.warn(`[AUDIT] Rejected a webhook delivery with a bad or missing signature from ${req.ip}`);
        res.status(401).json({ error: 'Bad signature' });
        return;
      }

      const eventName = req.get('X-GitHub-Event');

      if (eventName === 'ping') {
        res.status(200).json({ ok: true });
        return;
      }

      if (eventName !== 'workflow_job' && eventName !== 'workflow_run') {
        res.status(200).json({ ok: true, ignored: eventName ?? 'unknown' });
        return;
      }

      const deliveryId = req.get('X-GitHub-Delivery');
      if (deliveryId && seenDeliveries.has(deliveryId)) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        console.error('[ERROR] Webhook delivery had a valid signature but an unreadable body');
        res.status(200).json({ ok: false, error: 'Unreadable body' });
        return;
      }

      if (eventName === 'workflow_run') {
        if (deliveryId) {
          seenDeliveries.set(deliveryId, true);
        }
        handleWorkflowRun(parsed as WorkflowRunEvent, res);
        return;
      }

      const event = parsed as WorkflowJobEvent;
      const applied = upsert(event);

      if (deliveryId) {
        seenDeliveries.set(deliveryId, true);
      }

      res.status(200).json({ ok: true, applied });

      if (applied) {
        const [owner, repo] = (event.repository?.full_name ?? '').split('/');
        if (owner && repo) {
          noteRun(owner, repo, event.workflow_job.run_id, process.env.GITHUB_TOKEN);
        }
      }
    }
  );

  return router;
}

function handleWorkflowRun(event: WorkflowRunEvent, res: express.Response): void {
  if (!isKeepableFailedRun(event)) {
    res.status(200).json({ ok: true, applied: false });
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  const [owner, repo] = event.repository.full_name.split('/');
  if (!token || !owner || !repo) {
    res.status(200).json({ ok: true, applied: keepFailedRun(event) });
    return;
  }

  // The jobs API decides; it is asked after the reply so GitHub never waits on it.
  res.status(200).json({ ok: true, applied: false, checking: true });

  const check = checkRunHasNoJobs(event, owner, repo, token);
  pendingRunChecks.add(check);
  void check.finally(() => pendingRunChecks.delete(check));
}

async function checkRunHasNoJobs(event: WorkflowRunEvent, owner: string, repo: string, token: string): Promise<void> {
  const runId = event.workflow_run.id;
  try {
    const result = await new GitHubClient(token).getJobsForRun(owner, repo, runId);
    if (result.total_count > 0 || result.jobs.length > 0) return;
  } catch {
    console.warn(`[WARN] Could not list jobs for run ${runId} in ${owner}/${repo}; keeping it as a run without jobs`);
  }
  keepFailedRun(event);
}

/** Resolves once every pending workflow_run jobs lookup has finished. */
export async function settleWorkflowRunChecks(): Promise<void> {
  while (pendingRunChecks.size > 0) {
    await Promise.allSettled([...pendingRunChecks]);
  }
}

export function clearDeliveryDedupe(): void {
  seenDeliveries.clear();
}
