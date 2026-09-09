import crypto from 'node:crypto';
import express from 'express';
import { LRUCache } from 'lru-cache';
import { upsert } from '../services/jobStore.ts';
import { noteRun } from '../services/runContextStore.ts';
import type { WorkflowJobEvent } from '../types/webhook.ts';

export const WEBHOOK_PATH = '/webhooks/github';

const BODY_LIMIT = process.env.WEBHOOK_BODY_LIMIT || '5mb';

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

      if (eventName !== 'workflow_job') {
        res.status(200).json({ ok: true, ignored: eventName ?? 'unknown' });
        return;
      }

      const deliveryId = req.get('X-GitHub-Delivery');
      if (deliveryId && seenDeliveries.has(deliveryId)) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      let event: WorkflowJobEvent;
      try {
        event = JSON.parse(raw.toString('utf8')) as WorkflowJobEvent;
      } catch {
        console.error('[ERROR] Webhook delivery had a valid signature but an unreadable body');
        res.status(200).json({ ok: false, error: 'Unreadable body' });
        return;
      }

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

export function clearDeliveryDedupe(): void {
  seenDeliveries.clear();
}
