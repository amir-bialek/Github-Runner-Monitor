import express from 'express';
import { authenticateGitHub } from './middleware/auth.ts';
import { GitHubClient } from './services/githubClient.ts';
import { getHealthMetrics } from './services/performanceMonitor.ts';
import {
  setCachedData,
  getCachedData,
  generateRunnerCacheKey,
  runnersCache,
  RUNNERS_TTL_SECONDS,
} from './services/cache.ts';
import { requestBatcher } from './middleware/requestBatching.ts';
import { transformRunnersCollection, buildScaleSets } from './services/dataTransformation.ts';
import { recordAPICallStart } from './services/performanceMonitor.ts';
import { isMockMode, mockRunners } from './services/mockData.ts';
import { getQueueAndRunning, getHistory } from './services/jobsService.ts';
import { createWebhookRouter } from './routes/githubWebhook.ts';
import { stats as jobStoreStats } from './services/jobStore.ts';
import { QUEUE_ORDERING_NOTE, RUNNING_ORDER_NOTE, noteFor } from './services/dataTransformation.ts';
import type { InternalRunner } from './types/github.ts';

// A mistyped value here used to become NaN, and slice(0, NaN) returns nothing,
// so one bad character in the Helm values emptied a whole section of the page.
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(`${name}="${raw}" is not a whole number above zero — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

const HISTORY_DEFAULT_LIMIT = positiveInt('HISTORY_DEFAULT_LIMIT', 200);
const HISTORY_MAX_LIMIT = positiveInt('HISTORY_MAX_LIMIT', 200);
const RUNNING_MAX_ITEMS = positiveInt('RUNNING_MAX_ITEMS', 200);

export const app = express();

app.use(createWebhookRouter());

app.use(express.json());

app.get('/health', (req, res) => {
  const healthData = getHealthMetrics();
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'GitHub Runner Monitoring Backend',
    metrics: healthData,
    jobStore: jobStoreStats(),
  });
});

async function getRunnersSnapshot(org: string, token: string): Promise<InternalRunner[]> {
  if (isMockMode()) {
    return transformRunnersCollection(mockRunners);
  }

  const cacheKey = generateRunnerCacheKey(org);
  const cached = getCachedData<InternalRunner[]>(runnersCache, cacheKey);
  if (cached) {
    return cached;
  }

  const runners = await requestBatcher.batchRequest(
    `runners:${org}`,
    async () => {
      const client = new GitHubClient(token);
      return client.getRunners(org);
    },
    cacheKey
  );

  const transformed = transformRunnersCollection(runners);
  setCachedData(runnersCache, cacheKey, transformed);
  return transformed;
}

function filterByScaleSet<T extends { scaleSet: { id: string } | string | null }>(
  items: T[],
  scaleSet: string | undefined
): T[] {
  if (!scaleSet) return items;
  return items.filter(item => {
    const id = typeof item.scaleSet === 'string' ? item.scaleSet : item.scaleSet?.id;
    return id === scaleSet;
  });
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : (error as { message?: unknown })?.message;
  if (typeof raw === 'string' && raw.length > 0 && raw !== '[object Object]') {
    return raw;
  }
  return 'Unexpected failure talking to GitHub — see the backend logs for detail';
}

function requireOrg(res: express.Response): string | null {
  if (isMockMode()) {
    return 'mock';
  }

  const org = process.env.GITHUB_ORGANIZATION;
  if (!org) {
    res.status(500).json({ error: 'GitHub organization not configured' });
    return null;
  }
  return org;
}

app.get('/runners', authenticateGitHub, async (req, res) => {
  const apiTimer = recordAPICallStart('/runners');

  try {
    const org = requireOrg(res);
    if (!org) {
      apiTimer.end(500, 'GitHub organization not configured');
      return;
    }

    const runners = await getRunnersSnapshot(org, (req as any).githubToken);
    const filtered = filterByScaleSet(runners, req.query.scaleSet as string | undefined);

    apiTimer.end(200, undefined, filtered.length);
    res.json(filtered);
  } catch (error: any) {
    const message = errorMessage(error);
    apiTimer.end(500, message);
    res.status(500).json({ error: message });
  }
});

app.get('/scale-sets', authenticateGitHub, async (req, res) => {
  const apiTimer = recordAPICallStart('/scale-sets');

  try {
    const org = requireOrg(res);
    if (!org) {
      apiTimer.end(500, 'GitHub organization not configured');
      return;
    }

    const runners = await getRunnersSnapshot(org, (req as any).githubToken);
    const scaleSets = buildScaleSets(runners);
    const scaleSetFilter = req.query.scaleSet as string | undefined;
    const filtered = scaleSetFilter ? scaleSets.filter(s => s.id === scaleSetFilter) : scaleSets;

    apiTimer.end(200, undefined, filtered.length);
    res.json(filtered);
  } catch (error: any) {
    const message = errorMessage(error);
    apiTimer.end(500, message);
    res.status(500).json({ error: message });
  }
});

app.get('/jobs/queue', authenticateGitHub, async (req, res) => {
  const apiTimer = recordAPICallStart('/jobs/queue');

  try {
    const org = requireOrg(res);
    if (!org) {
      apiTimer.end(500, 'GitHub organization not configured');
      return;
    }

    const runners = await getRunnersSnapshot(org, (req as any).githubToken);
    const knownScaleSets = buildScaleSets(runners).map(s => s.id);
    const { queue, incomplete } = await getQueueAndRunning(org, (req as any).githubToken, knownScaleSets);
    const filtered = filterByScaleSet(queue, req.query.scaleSet as string | undefined);

    apiTimer.end(200, undefined, filtered.length);
    res.json({
      orderingIsEstimate: true,
      note: noteFor(QUEUE_ORDERING_NOTE, incomplete),
      incomplete,
      items: filtered,
    });
  } catch (error: any) {
    const message = errorMessage(error);
    apiTimer.end(500, message);
    res.status(500).json({ error: message });
  }
});

app.get('/jobs/running', authenticateGitHub, async (req, res) => {
  const apiTimer = recordAPICallStart('/jobs/running');

  try {
    const org = requireOrg(res);
    if (!org) {
      apiTimer.end(500, 'GitHub organization not configured');
      return;
    }

    const runners = await getRunnersSnapshot(org, (req as any).githubToken);
    const knownScaleSets = buildScaleSets(runners).map(s => s.id);
    const { running, incomplete } = await getQueueAndRunning(org, (req as any).githubToken, knownScaleSets);
    const matching = filterByScaleSet(running, req.query.scaleSet as string | undefined);
    const filtered = matching.slice(0, RUNNING_MAX_ITEMS);

    apiTimer.end(200, undefined, filtered.length);
    res.json({
      orderingIsEstimate: true,
      note: noteFor(RUNNING_ORDER_NOTE, incomplete),
      incomplete,
      total: matching.length,
      items: filtered,
    });
  } catch (error: any) {
    const message = errorMessage(error);
    apiTimer.end(500, message);
    res.status(500).json({ error: message });
  }
});

app.get('/jobs/history', authenticateGitHub, async (req, res) => {
  const apiTimer = recordAPICallStart('/jobs/history');

  try {
    const org = requireOrg(res);
    if (!org) {
      apiTimer.end(500, 'GitHub organization not configured');
      return;
    }

    const requestedLimit = parseInt((req.query.limit as string) || String(HISTORY_DEFAULT_LIMIT), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), HISTORY_MAX_LIMIT)
      : HISTORY_DEFAULT_LIMIT;

    const runners = await getRunnersSnapshot(org, (req as any).githubToken);
    const knownScaleSets = buildScaleSets(runners).map(s => s.id);
    const history = await getHistory(org, (req as any).githubToken, knownScaleSets);
    const filtered = filterByScaleSet(history, req.query.scaleSet as string | undefined).slice(0, limit);

    apiTimer.end(200, undefined, filtered.length);
    res.json(filtered);
  } catch (error: any) {
    const message = errorMessage(error);
    apiTimer.end(500, message);
    res.status(500).json({ error: message });
  }
});

app.get('/settings', (req, res) => {
  res.json({ runnersRefreshSeconds: RUNNERS_TTL_SECONDS });
});

app.get('/', (req, res) => {
  res.json({ message: 'Backend is running' });
});

export default app;
