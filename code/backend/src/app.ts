import express from 'express';
import { authenticateGitHub } from './middleware/auth.ts';
import { getHealthMetrics } from './services/performanceMonitor.ts';
import { RUNNERS_TTL_SECONDS } from './services/cache.ts';
import { buildScaleSets } from './services/dataTransformation.ts';
import { recordAPICallStart } from './services/performanceMonitor.ts';
import { isMockMode } from './services/mockData.ts';
import { getRunnersSnapshot } from './services/runnersSnapshot.ts';
import { getQueueAndRunning, getHistory } from './services/jobsService.ts';
import { createWebhookRouter } from './routes/githubWebhook.ts';
import { stats as jobStoreStats } from './services/jobStore.ts';
import {
  activeAlerts,
  currentSettings,
  currentWebhookStatus,
  evaluate,
  lastEvaluatedAt,
  resetSettings,
  sendTestNotification,
  settingsSource,
  updateSettings,
} from './services/alerts.ts';
import { gatherAlertInput } from './services/alertInput.ts';
import { deploymentDefaults, maskWebhookUrl, parseOverride, settingsEditable, type AlertSettings } from './services/alertSettings.ts';
import { persistenceEnabled } from './services/statePersistence.ts';
import { QUEUE_ORDERING_NOTE, RUNNING_ORDER_NOTE, noteFor } from './services/dataTransformation.ts';

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

function publicSettings(settings: AlertSettings) {
  return {
    queueWait: settings.queueWait,
    runnerGroupOffline: settings.runnerGroupOffline,
    webhookConfigured: settings.webhookUrl !== null,
    webhookUrlMasked: maskWebhookUrl(settings.webhookUrl),
  };
}

function alertSettingsResponse() {
  return {
    settings: publicSettings(currentSettings()),
    deploymentDefaults: publicSettings(deploymentDefaults()),
    source: settingsSource(),
    editable: settingsEditable(),
    persisted: persistenceEnabled(),
    webhookStatus: currentWebhookStatus(),
  };
}

async function reevaluate(): Promise<void> {
  try {
    await evaluate(await gatherAlertInput());
  } catch (error: any) {
    console.error(`[ERROR] Alert evaluation failed: ${error?.message ?? error}`);
  }
}

app.get('/alerts', (req, res) => {
  res.json({ evaluatedAt: lastEvaluatedAt(), alerts: activeAlerts() });
});

app.get('/settings/alerts', (req, res) => {
  res.json(alertSettingsResponse());
});

function refuseIfLocked(res: express.Response): boolean {
  if (settingsEditable()) return false;
  res.status(403).json({ error: 'Alert settings are locked by the deployment (ALERT_SETTINGS_EDITABLE=false)' });
  return true;
}

app.put('/settings/alerts', async (req, res) => {
  if (refuseIfLocked(res)) return;
  const parsed = parseOverride(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.errors.join('; '), errors: parsed.errors });
    return;
  }
  await updateSettings(parsed.value);
  console.log('[AUDIT] Alert settings changed from the UI');
  await reevaluate();
  res.json(alertSettingsResponse());
});

app.delete('/settings/alerts', async (req, res) => {
  if (refuseIfLocked(res)) return;
  await resetSettings();
  console.log('[AUDIT] Alert settings reset to the deployment values');
  await reevaluate();
  res.json(alertSettingsResponse());
});

app.post('/settings/alerts/test', async (req, res) => {
  if (refuseIfLocked(res)) return;
  if (!currentSettings().webhookUrl) {
    res.status(400).json({ error: 'No webhook URL is configured' });
    return;
  }
  const status = await sendTestNotification();
  if (status.lastError) {
    res.status(502).json({ error: `Test failed: ${status.lastError}`, webhookStatus: status });
    return;
  }
  res.json({ webhookStatus: status });
});

app.get('/', (req, res) => {
  res.json({ message: 'Backend is running' });
});

export default app;
