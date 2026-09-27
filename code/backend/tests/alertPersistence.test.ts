const bucket = new Map<string, string>();
const sent: Array<{ type: string; input: any }> = [];

jest.mock('@aws-sdk/client-s3', () => {
  class GetObjectCommand {
    type = 'get';
    constructor(public input: any) {}
  }
  class PutObjectCommand {
    type = 'put';
    constructor(public input: any) {}
  }
  class S3Client {
    async send(command: { type: string; input: any }) {
      sent.push(command);
      const key = `${command.input.Bucket}/${command.input.Key}`;
      if (command.type === 'put') {
        bucket.set(key, command.input.Body);
        return {};
      }
      const body = bucket.get(key);
      if (body === undefined) {
        throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      }
      return { Body: { transformToString: async () => body } };
    }
  }
  return { __esModule: true, S3Client, GetObjectCommand, PutObjectCommand };
});

type AlertsModule = typeof import('../src/services/alerts');

function freshProcess(): AlertsModule {
  let loaded!: AlertsModule;
  jest.isolateModules(() => {
    loaded = require('../src/services/alerts');
  });
  return loaded;
}

const previous = {
  mock: process.env.USE_MOCK_DATA,
  bucket: process.env.JOB_STATE_S3_BUCKET,
  key: process.env.ALERT_STATE_S3_KEY,
};

beforeAll(() => {
  process.env.USE_MOCK_DATA = 'false';
  process.env.JOB_STATE_S3_BUCKET = 'monitor-state';
  process.env.ALERT_STATE_S3_KEY = 'alerts/state.json';
});

afterAll(() => {
  process.env.USE_MOCK_DATA = previous.mock ?? 'true';
  if (previous.bucket === undefined) delete process.env.JOB_STATE_S3_BUCKET;
  else process.env.JOB_STATE_S3_BUCKET = previous.bucket;
  if (previous.key === undefined) delete process.env.ALERT_STATE_S3_KEY;
  else process.env.ALERT_STATE_S3_KEY = previous.key;
});

beforeEach(() => {
  bucket.clear();
  sent.length = 0;
  delete process.env.ALERT_QUEUE_WAIT_MINUTES;
});

const MINUTE = 60_000;
const NOW = Date.parse('2026-09-27T12:00:00Z');

test('settings changed in the UI are written to the same bucket as the job store and survive a restart', async () => {
  const first = freshProcess();
  await first.loadAlertState();
  await first.updateSettings({ queueWait: { thresholdMinutes: 42 }, webhookUrl: 'https://hooks.example.com/x' });

  const puts = sent.filter(c => c.type === 'put');
  expect(puts.length).toBeGreaterThan(0);
  expect(puts[0]!.input).toMatchObject({ Bucket: 'monitor-state', Key: 'alerts/state.json', ContentType: 'application/json' });

  const second = freshProcess();
  expect(second.currentSettings().queueWait.thresholdMinutes).toBe(15);
  await second.loadAlertState();
  expect(second.currentSettings().queueWait.thresholdMinutes).toBe(42);
  expect(second.currentSettings().webhookUrl).toBe('https://hooks.example.com/x');
  expect(second.settingsSource()).toBe('ui');
});

test('a dark pool keeps its clock across a restart', async () => {
  const first = freshProcess();
  await first.loadAlertState();
  await first.evaluate({ queue: [], scaleSets: [{ id: 'arc-gpu-a10', name: 'arc-gpu-a10', totalRunners: 2, online: 0, busy: 0, free: 0 }] }, NOW);

  const second = freshProcess();
  await second.loadAlertState();
  const alerts = await second.evaluate(
    { queue: [], scaleSets: [{ id: 'arc-gpu-a10', name: 'arc-gpu-a10', totalRunners: 2, online: 0, busy: 0, free: 0 }] },
    NOW + 10 * MINUTE
  );
  expect(alerts).toHaveLength(1);
  expect(alerts[0]!.since).toBe(new Date(NOW).toISOString());
});

test('with nothing saved yet the deployment values are used', async () => {
  process.env.ALERT_QUEUE_WAIT_MINUTES = '25';
  const alerts = freshProcess();
  await alerts.loadAlertState();
  expect(alerts.currentSettings().queueWait.thresholdMinutes).toBe(25);
  expect(alerts.settingsSource()).toBe('deployment');
});

test('resetting in the UI is saved too, so the deployment values come back after a restart', async () => {
  const first = freshProcess();
  await first.updateSettings({ queueWait: { thresholdMinutes: 42 } });
  await first.resetSettings();

  const second = freshProcess();
  await second.loadAlertState();
  expect(second.settingsSource()).toBe('deployment');
  expect(second.currentSettings().queueWait.thresholdMinutes).toBe(15);
});
