import request from 'supertest';
import { app } from '../src/app';
import {
  activeAlerts,
  currentSettings,
  currentWebhookStatus,
  evaluate,
  resetAlertsForTests,
  restoreAlertState,
  setDeliverForTests,
  updateSettings,
} from '../src/services/alerts';
import { deploymentDefaults, maskWebhookUrl, parseOverride } from '../src/services/alertSettings';
import type { JobQueueItem, ScaleSetSummary } from '../src/types/github';

process.env.USE_MOCK_DATA = 'true';

const MINUTE = 60_000;
const NOW = Date.parse('2026-09-27T12:00:00Z');

const ALERT_ENV = [
  'ALERT_QUEUE_WAIT_ENABLED',
  'ALERT_QUEUE_WAIT_MINUTES',
  'ALERT_RUNNER_GROUP_OFFLINE_ENABLED',
  'ALERT_RUNNER_GROUP_OFFLINE_MINUTES',
  'ALERT_WEBHOOK_URL',
  'ALERT_SETTINGS_EDITABLE',
];

function queued(id: number, scaleSet: string | null, waitedMinutes: number): JobQueueItem {
  return {
    id,
    name: `job-${id}`,
    workflowName: 'CI',
    branch: 'main',
    actor: null,
    event: 'push',
    repository: 'acme/web-app',
    repositoryUrl: 'https://github.com/acme/web-app',
    scaleSet,
    position: 1,
    createdAt: new Date(NOW - waitedMinutes * MINUTE).toISOString(),
    waitMs: waitedMinutes * MINUTE,
    htmlUrl: `https://github.com/acme/web-app/actions/runs/1/job/${id}`,
    runUrl: 'https://github.com/acme/web-app/actions/runs/1',
  };
}

function pool(id: string, online: number, total = 2): ScaleSetSummary {
  return { id, name: id, totalRunners: total, online, busy: 0, free: online };
}

beforeEach(() => {
  resetAlertsForTests();
  for (const name of ALERT_ENV) delete process.env[name];
});

afterAll(() => {
  resetAlertsForTests();
  for (const name of ALERT_ENV) delete process.env[name];
});

describe('deployment defaults', () => {
  test('are on-screen only, 15 minutes for the queue and 10 for an offline pool', () => {
    expect(deploymentDefaults()).toEqual({
      queueWait: { enabled: true, thresholdMinutes: 15 },
      runnerGroupOffline: { enabled: true, thresholdMinutes: 10 },
      webhookUrl: null,
    });
  });

  test('come from the environment', () => {
    process.env.ALERT_QUEUE_WAIT_MINUTES = '30';
    process.env.ALERT_RUNNER_GROUP_OFFLINE_ENABLED = 'false';
    process.env.ALERT_RUNNER_GROUP_OFFLINE_MINUTES = '5';
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/services/abc';

    expect(deploymentDefaults()).toEqual({
      queueWait: { enabled: true, thresholdMinutes: 30 },
      runnerGroupOffline: { enabled: false, thresholdMinutes: 5 },
      webhookUrl: 'https://hooks.example.com/services/abc',
    });
  });

  test('a mistyped value falls back instead of disabling the alert', () => {
    process.env.ALERT_QUEUE_WAIT_MINUTES = '15m';
    process.env.ALERT_QUEUE_WAIT_ENABLED = 'maybe';
    process.env.ALERT_WEBHOOK_URL = 'ftp://example.com';

    expect(deploymentDefaults().queueWait).toEqual({ enabled: true, thresholdMinutes: 15 });
    expect(deploymentDefaults().webhookUrl).toBeNull();
  });
});

describe('parseOverride', () => {
  test('accepts a partial change', () => {
    expect(parseOverride({ queueWait: { thresholdMinutes: 20 } })).toEqual({
      ok: true,
      value: { queueWait: { thresholdMinutes: 20 } },
    });
  });

  test('an empty webhook URL means no webhook', () => {
    expect(parseOverride({ webhookUrl: '' })).toEqual({ ok: true, value: { webhookUrl: null } });
  });

  test.each([
    [{ queueWait: { thresholdMinutes: 0 } }],
    [{ queueWait: { thresholdMinutes: 2.5 } }],
    [{ queueWait: { thresholdMinutes: '10' } }],
    [{ runnerGroupOffline: { enabled: 'yes' } }],
    [{ webhookUrl: 'not a url' }],
    [{ webhookUrl: 'file:///etc/passwd' }],
    [{ webhookUrl: 'https://user:secret@example.com/hook' }],
    [[]],
    [null],
  ])('refuses %j', body => {
    expect(parseOverride(body).ok).toBe(false);
  });
});

test('maskWebhookUrl keeps only the host, since the path is usually the secret', () => {
  expect(maskWebhookUrl('https://hooks.slack.com/services/T000/B000/XXXX')).toBe('https://hooks.slack.com/…');
  expect(maskWebhookUrl('https://alerts.example.com')).toBe('https://alerts.example.com');
  expect(maskWebhookUrl(null)).toBeNull();
});

describe('queue wait alert', () => {
  test('fires for a pool once a job has waited past the threshold, and lists the jobs', async () => {
    const alerts = await evaluate(
      { queue: [queued(1, 'arc-gpu-a10', 20), queued(2, 'arc-gpu-a10', 16), queued(3, 'arc-gpu-a10', 3)], scaleSets: [] },
      NOW
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: 'queue_wait:arc-gpu-a10',
      kind: 'queue_wait',
      scaleSet: 'arc-gpu-a10',
      thresholdMinutes: 15,
      jobCount: 2,
      since: new Date(NOW - 20 * MINUTE).toISOString(),
    });
    expect(alerts[0]!.jobs!.map(j => j.id)).toEqual([1, 2]);
    expect(alerts[0]!.message).toBe('2 jobs have waited longer than 15 minutes for arc-gpu-a10');
  });

  test('stays quiet under the threshold', async () => {
    expect(await evaluate({ queue: [queued(1, 'arc-gpu-a10', 14)], scaleSets: [] }, NOW)).toEqual([]);
  });

  test('jobs with no known pool get their own alert', async () => {
    const alerts = await evaluate({ queue: [queued(1, null, 30)], scaleSets: [] }, NOW);
    expect(alerts[0]).toMatchObject({ id: 'queue_wait:unknown', scaleSet: null });
    expect(alerts[0]!.message).toBe('1 job has waited longer than 15 minutes for an unknown pool');
  });

  test('uses the time since the job was created, not the stale waitMs', async () => {
    const job = { ...queued(1, 'arc-linux-x64', 16), waitMs: 0 };
    expect(await evaluate({ queue: [job], scaleSets: [] }, NOW)).toHaveLength(1);
  });

  test('keeps its first fired time while it stays active and clears once the job starts', async () => {
    await evaluate({ queue: [queued(1, 'arc-gpu-a10', 20)], scaleSets: [] }, NOW);
    const later = await evaluate({ queue: [queued(1, 'arc-gpu-a10', 21)], scaleSets: [] }, NOW + MINUTE);
    expect(later[0]!.firedAt).toBe(new Date(NOW).toISOString());

    expect(await evaluate({ queue: [], scaleSets: [] }, NOW + 2 * MINUTE)).toEqual([]);
  });

  test('can be switched off', async () => {
    await updateSettings({ queueWait: { enabled: false } });
    expect(await evaluate({ queue: [queued(1, 'arc-gpu-a10', 60)], scaleSets: [] }, NOW)).toEqual([]);
  });
});

describe('runner group offline alert', () => {
  test('fires only after the pool has had no online runner for the threshold', async () => {
    expect(await evaluate({ queue: [], scaleSets: [pool('arc-windows-x64', 0)] }, NOW)).toEqual([]);
    expect(await evaluate({ queue: [], scaleSets: [pool('arc-windows-x64', 0)] }, NOW + 9 * MINUTE)).toEqual([]);

    const alerts = await evaluate({ queue: [], scaleSets: [pool('arc-windows-x64', 0)] }, NOW + 10 * MINUTE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: 'runner_group_offline:arc-windows-x64',
      kind: 'runner_group_offline',
      scaleSet: 'arc-windows-x64',
      since: new Date(NOW).toISOString(),
      totalRunners: 2,
    });
    expect(alerts[0]!.message).toBe('arc-windows-x64 has 0 of 2 runners online for longer than 10 minutes');
  });

  test('one runner coming back online clears it and restarts the clock', async () => {
    await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 0)] }, NOW);
    expect(await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 0)] }, NOW + 11 * MINUTE)).toHaveLength(1);
    expect(await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 1)] }, NOW + 12 * MINUTE)).toEqual([]);
    expect(await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 0)] }, NOW + 13 * MINUTE)).toEqual([]);
  });

  test('a pool that disappears from the runner list entirely also counts as dark', async () => {
    await evaluate({ queue: [], scaleSets: [pool('arc-linux-arm64', 2)] }, NOW);
    await evaluate({ queue: [], scaleSets: [] }, NOW + MINUTE);

    const alerts = await evaluate({ queue: [], scaleSets: [] }, NOW + 11 * MINUTE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toBe('arc-linux-arm64 has no runners registered for longer than 10 minutes');
  });

  test('when the runner list cannot be read, offline alerts are left as they were', async () => {
    await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 0)] }, NOW);
    await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 0)] }, NOW + 11 * MINUTE);

    expect(await evaluate({ queue: [], scaleSets: null }, NOW + 12 * MINUTE)).toHaveLength(1);
  });

  test('a GitHub failure does not start a dark clock for a healthy pool', async () => {
    await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 2)] }, NOW);
    await evaluate({ queue: [], scaleSets: null }, NOW + 20 * MINUTE);
    expect(await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 2)] }, NOW + 21 * MINUTE)).toEqual([]);
  });

  test('uses the threshold from the UI once it is changed', async () => {
    await updateSettings({ runnerGroupOffline: { thresholdMinutes: 2 } });
    await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 0)] }, NOW);
    expect(await evaluate({ queue: [], scaleSets: [pool('arc-gpu-a10', 0)] }, NOW + 2 * MINUTE)).toHaveLength(1);
  });

  test('offline alerts are listed before queue alerts', async () => {
    await evaluate({ queue: [], scaleSets: [pool('arc-windows-x64', 0)] }, NOW - 20 * MINUTE);
    const alerts = await evaluate({ queue: [queued(1, 'arc-gpu-a10', 60)], scaleSets: [pool('arc-windows-x64', 0)] }, NOW);
    expect(alerts.map(a => a.kind)).toEqual(['runner_group_offline', 'queue_wait']);
  });
});

describe('webhook delivery', () => {
  test('nothing is sent when no webhook URL is set', async () => {
    const deliver = jest.fn().mockResolvedValue(undefined);
    setDeliverForTests(deliver);
    await evaluate({ queue: [queued(1, 'arc-gpu-a10', 30)], scaleSets: [] }, NOW);
    expect(deliver).not.toHaveBeenCalled();
  });

  test('sends one message when an alert fires and one when it resolves, not on every check', async () => {
    const deliver = jest.fn().mockResolvedValue(undefined);
    setDeliverForTests(deliver);
    await updateSettings({ webhookUrl: 'https://hooks.example.com/abc' });

    await evaluate({ queue: [queued(1, 'arc-gpu-a10', 30)], scaleSets: [] }, NOW);
    await evaluate({ queue: [queued(1, 'arc-gpu-a10', 31)], scaleSets: [] }, NOW + MINUTE);
    await evaluate({ queue: [], scaleSets: [] }, NOW + 2 * MINUTE);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]![0]).toBe('https://hooks.example.com/abc');
    expect(deliver.mock.calls[0]![1]).toMatchObject({
      source: 'github-runner-monitor',
      event: 'alert.fired',
      alert: { id: 'queue_wait:arc-gpu-a10' },
    });
    expect(deliver.mock.calls[0]![1].text).toContain('waited longer than 15 minutes');
    expect(deliver.mock.calls[1]![1]).toMatchObject({ event: 'alert.resolved' });
    expect(currentWebhookStatus().lastError).toBeNull();
  });

  test('a failed delivery is recorded and does not stop the alert showing on screen', async () => {
    setDeliverForTests(jest.fn().mockRejectedValue(new Error('The webhook answered HTTP 500')));
    await updateSettings({ webhookUrl: 'https://hooks.example.com/abc' });

    const alerts = await evaluate({ queue: [queued(1, 'arc-gpu-a10', 30)], scaleSets: [] }, NOW);

    expect(alerts).toHaveLength(1);
    expect(currentWebhookStatus().lastError).toBe('The webhook answered HTTP 500');
  });

  test('an alert restored from before a restart is not sent again', async () => {
    const deliver = jest.fn().mockResolvedValue(undefined);
    await updateSettings({ webhookUrl: 'https://hooks.example.com/abc' });
    await evaluate({ queue: [queued(1, 'arc-gpu-a10', 30)], scaleSets: [] }, NOW);
    const saved = JSON.parse(JSON.stringify({ override: { webhookUrl: 'https://hooks.example.com/abc' }, groups: {}, active: activeAlerts() }));

    resetAlertsForTests();
    setDeliverForTests(deliver);
    restoreAlertState(saved);
    await evaluate({ queue: [queued(1, 'arc-gpu-a10', 31)], scaleSets: [] }, NOW + MINUTE);

    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('settings precedence', () => {
  test('a value changed in the UI wins over the deployment, untouched ones still follow it', async () => {
    process.env.ALERT_QUEUE_WAIT_MINUTES = '30';
    process.env.ALERT_RUNNER_GROUP_OFFLINE_MINUTES = '20';
    await updateSettings({ queueWait: { thresholdMinutes: 5 } });

    expect(currentSettings().queueWait.thresholdMinutes).toBe(5);
    expect(currentSettings().runnerGroupOffline.thresholdMinutes).toBe(20);
  });

  test('clearing the webhook in the UI overrides one set by the deployment', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/from-helm';
    await updateSettings({ webhookUrl: null });
    expect(currentSettings().webhookUrl).toBeNull();
  });
});

describe('alert routes', () => {
  test('GET /alerts returns the last evaluation', async () => {
    await evaluate({ queue: [queued(1, 'arc-gpu-a10', 30)], scaleSets: [] }, NOW);
    const response = await request(app).get('/alerts').expect(200);
    expect(response.body.evaluatedAt).toBe(new Date(NOW).toISOString());
    expect(response.body.alerts).toHaveLength(1);
  });

  test('GET /settings/alerts shows where the values came from and never the full webhook URL', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/SECRET';
    const response = await request(app).get('/settings/alerts').expect(200);

    expect(response.body).toMatchObject({
      source: 'deployment',
      editable: true,
      persisted: false,
      settings: {
        queueWait: { enabled: true, thresholdMinutes: 15 },
        runnerGroupOffline: { enabled: true, thresholdMinutes: 10 },
        webhookConfigured: true,
        webhookUrlMasked: 'https://hooks.slack.com/…',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('SECRET');
  });

  test('PUT /settings/alerts saves the change and re-evaluates straight away', async () => {
    const response = await request(app)
      .put('/settings/alerts')
      .send({ queueWait: { thresholdMinutes: 1 }, runnerGroupOffline: { enabled: false } })
      .expect(200);

    expect(response.body.source).toBe('ui');
    expect(response.body.settings.queueWait.thresholdMinutes).toBe(1);
    expect(response.body.settings.runnerGroupOffline.enabled).toBe(false);

    const alerts = await request(app).get('/alerts').expect(200);
    expect(alerts.body.alerts.some((a: any) => a.id === 'queue_wait:arc-gpu-a10')).toBe(true);
  });

  test('PUT /settings/alerts refuses a bad value with a readable reason', async () => {
    const response = await request(app).put('/settings/alerts').send({ queueWait: { thresholdMinutes: -1 } }).expect(400);
    expect(response.body.error).toContain('thresholdMinutes');
    expect(currentSettings().queueWait.thresholdMinutes).toBe(15);
  });

  test('DELETE /settings/alerts goes back to the deployment values', async () => {
    await request(app).put('/settings/alerts').send({ queueWait: { thresholdMinutes: 3 } }).expect(200);
    const response = await request(app).delete('/settings/alerts').expect(200);
    expect(response.body.source).toBe('deployment');
    expect(response.body.settings.queueWait.thresholdMinutes).toBe(15);
  });

  test('the deployment can lock the settings', async () => {
    process.env.ALERT_SETTINGS_EDITABLE = 'false';
    await request(app).put('/settings/alerts').send({ queueWait: { thresholdMinutes: 3 } }).expect(403);
    await request(app).delete('/settings/alerts').expect(403);
    const response = await request(app).get('/settings/alerts').expect(200);
    expect(response.body.editable).toBe(false);
  });

  test('POST /settings/alerts/test needs a webhook and reports the outcome', async () => {
    await request(app).post('/settings/alerts/test').expect(400);

    const deliver = jest.fn().mockResolvedValue(undefined);
    setDeliverForTests(deliver);
    await updateSettings({ webhookUrl: 'https://hooks.example.com/abc' });
    const response = await request(app).post('/settings/alerts/test').expect(200);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(response.body.webhookStatus.lastSuccessAt).not.toBeNull();
  });
});
