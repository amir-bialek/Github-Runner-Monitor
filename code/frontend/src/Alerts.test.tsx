import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';
import App from './App';
import * as api from './services/api';
import { toApiError } from './services/apiError';
import type { AlertSettingsResponse, MonitorAlert } from './types/api';

vi.mock('./services/api', () => ({
  fetchScaleSets: vi.fn(),
  fetchQueue: vi.fn(),
  fetchRunningJobs: vi.fn(),
  fetchJobHistory: vi.fn(),
  fetchRunners: vi.fn(),
  fetchSettings: vi.fn(),
  fetchAlerts: vi.fn(),
  fetchAlertSettings: vi.fn(),
  updateAlertSettings: vi.fn(),
  resetAlertSettings: vi.fn(),
  sendTestAlert: vi.fn(),
}));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

const queueAlert: MonitorAlert = {
  id: 'queue_wait:arc-gpu-a10',
  kind: 'queue_wait',
  scaleSet: 'arc-gpu-a10',
  thresholdMinutes: 15,
  since: minutesAgo(20),
  firedAt: minutesAgo(5),
  message: '4 jobs have waited longer than 15 minutes for arc-gpu-a10',
  jobCount: 5,
  jobs: [20, 18, 17, 16, 15].map((waited, index) => ({
    id: 900100 + index,
    name: `build-${index}`,
    repository: 'acme/web-app',
    htmlUrl: `https://github.com/acme/web-app/actions/runs/1/job/${900100 + index}`,
    createdAt: minutesAgo(waited),
    waitMs: waited * 60 * 1000,
  })),
};

const offlineAlert: MonitorAlert = {
  id: 'runner_group_offline:arc-windows-x64',
  kind: 'runner_group_offline',
  scaleSet: 'arc-windows-x64',
  thresholdMinutes: 10,
  since: minutesAgo(12),
  firedAt: minutesAgo(2),
  message: 'arc-windows-x64 has 0 of 2 runners online for longer than 10 minutes',
  totalRunners: 2,
};

function settingsResponse(overrides: Partial<AlertSettingsResponse> = {}): AlertSettingsResponse {
  const defaults = {
    queueWait: { enabled: true, thresholdMinutes: 15 },
    runnerGroupOffline: { enabled: true, thresholdMinutes: 10 },
    webhookConfigured: false,
    webhookUrlMasked: null,
  };
  return {
    settings: defaults,
    deploymentDefaults: defaults,
    source: 'deployment',
    editable: true,
    persisted: true,
    webhookStatus: { lastAttemptAt: null, lastSuccessAt: null, lastError: null },
    ...overrides,
  };
}

function renderApp() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

async function openAlerts() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^alerts/i }));
  const heading = await screen.findByRole('heading', { name: 'Alerts:' });
  return { user, section: heading.closest('section')! };
}

async function openSettings() {
  const { user } = await openAlerts();
  await user.click(screen.getByRole('button', { name: 'Alert settings' }));
  const dialog = await screen.findByRole('dialog', { name: /alert settings/i });
  await within(dialog).findByLabelText(/queue wait threshold/i);
  return { user, dialog };
}

beforeEach(() => {
  vi.mocked(api.fetchScaleSets).mockResolvedValue([]);
  vi.mocked(api.fetchQueue).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchRunningJobs).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchJobHistory).mockResolvedValue([]);
  vi.mocked(api.fetchSettings).mockResolvedValue({ runnersRefreshSeconds: 30 });
  vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: null, alerts: [] });
  vi.mocked(api.fetchAlertSettings).mockResolvedValue(settingsResponse());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('alerts window', () => {
  test('nothing about alerts is on the page itself', async () => {
    vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: minutesAgo(0), alerts: [offlineAlert, queueAlert] });
    renderApp();
    await screen.findByRole('button', { name: 'Alerts — 2 active' });
    expect(screen.queryByRole('heading', { name: 'Alerts:' })).not.toBeInTheDocument();
    expect(screen.queryByText(/is waiting for/)).not.toBeInTheDocument();
  });

  test('the header button carries the count and the tab title too', async () => {
    vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: minutesAgo(0), alerts: [offlineAlert, queueAlert] });
    renderApp();
    await screen.findByRole('button', { name: 'Alerts — 2 active' });
    expect(document.title).toMatch(/^⚠ 2 alerts · /);
  });

  test('clicking it lists one plain line per stuck job and per offline group, offline first', async () => {
    vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: minutesAgo(0), alerts: [offlineAlert, queueAlert] });
    renderApp();
    await screen.findByRole('button', { name: 'Alerts — 2 active' });
    const { section } = await openAlerts();

    const lines = within(section).getAllByRole('listitem').map((item) => item.textContent);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^Runner group arc-windows-x64 has had no online runners \(0 of 2\) for 12 ?m/);
    expect(lines[1]).toMatch(/^Job build-0 is waiting for 20 ?m/);
    expect(within(section).getByRole('link', { name: /build-0/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/web-app/actions/runs/1/job/900100',
    );
  });

  test('shows at most ten lines per page', async () => {
    const many: MonitorAlert = {
      ...queueAlert,
      jobCount: 12,
      jobs: Array.from({ length: 12 }, (_, index) => ({
        id: 900200 + index,
        name: `job-${index}`,
        repository: 'acme/web-app',
        htmlUrl: `https://github.com/acme/web-app/actions/runs/1/job/${900200 + index}`,
        createdAt: minutesAgo(30 - index),
        waitMs: (30 - index) * 60 * 1000,
      })),
    };
    vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: minutesAgo(0), alerts: [many] });
    renderApp();
    await screen.findByRole('button', { name: 'Alerts — 1 active' });
    const { user, section } = await openAlerts();

    expect(within(section).getAllByRole('listitem')).toHaveLength(10);
    await user.click(within(section).getByRole('button', { name: /next page/i }));
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
  });

  test('with nothing wrong it says so', async () => {
    renderApp();
    await waitFor(() => expect(api.fetchAlerts).toHaveBeenCalled());
    const { section } = await openAlerts();
    expect(section).toHaveTextContent('No active alerts.');
    expect(document.title).not.toContain('alert');
  });

  test('a failing alerts endpoint does not take the dashboard down', async () => {
    vi.mocked(api.fetchAlerts).mockRejectedValue(toApiError({ message: 'Network Error' }));
    renderApp();
    expect(await screen.findByRole('heading', { name: /available runners/i })).toBeInTheDocument();
  });
});

describe('alert settings dialog', () => {
  test('shows the current thresholds and where they come from', async () => {
    renderApp();
    const { dialog } = await openSettings();

    expect(within(dialog).getByLabelText(/queue wait threshold/i)).toHaveValue('15');
    expect(within(dialog).getByLabelText(/runner group offline threshold/i)).toHaveValue('10');
    expect(dialog).toHaveTextContent(/values set at deploy time/i);
    expect(dialog).toHaveTextContent(/saved to s3/i);
    expect(within(dialog).queryByRole('button', { name: /reset to deployment values/i })).not.toBeInTheDocument();
  });

  test('saves the new thresholds and webhook, then refreshes the alerts', async () => {
    vi.mocked(api.updateAlertSettings).mockResolvedValue(settingsResponse({ source: 'ui' }));
    renderApp();
    const { user, dialog } = await openSettings();

    const queue = within(dialog).getByLabelText(/queue wait threshold/i);
    await user.clear(queue);
    await user.type(queue, '5');
    await user.click(within(dialog).getByRole('switch', { name: /runner group offline/i }));
    await user.type(within(dialog).getByLabelText(/webhook url/i), 'https://hooks.example.com/abc');
    const alertsCallsBefore = vi.mocked(api.fetchAlerts).mock.calls.length;
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(vi.mocked(api.updateAlertSettings).mock.calls[0]![0]).toEqual({
      queueWait: { enabled: true, thresholdMinutes: 5 },
      runnerGroupOffline: { enabled: false, thresholdMinutes: 10 },
      webhookUrl: 'https://hooks.example.com/abc',
    });
    await waitFor(() => expect(vi.mocked(api.fetchAlerts).mock.calls.length).toBeGreaterThan(alertsCallsBefore));
  });

  test('leaving the webhook field empty keeps the existing webhook', async () => {
    vi.mocked(api.fetchAlertSettings).mockResolvedValue(
      settingsResponse({
        settings: {
          ...settingsResponse().settings,
          webhookConfigured: true,
          webhookUrlMasked: 'https://hooks.slack.com/…',
        },
      }),
    );
    vi.mocked(api.updateAlertSettings).mockResolvedValue(settingsResponse({ source: 'ui' }));
    renderApp();
    const { user, dialog } = await openSettings();

    expect(dialog).toHaveTextContent('Current webhook: https://hooks.slack.com/…');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateAlertSettings).toHaveBeenCalled());
    expect(vi.mocked(api.updateAlertSettings).mock.calls[0]![0]).not.toHaveProperty('webhookUrl');
  });

  test('removing the webhook sends null', async () => {
    vi.mocked(api.fetchAlertSettings).mockResolvedValue(
      settingsResponse({
        settings: { ...settingsResponse().settings, webhookConfigured: true, webhookUrlMasked: 'https://hooks.slack.com/…' },
      }),
    );
    vi.mocked(api.updateAlertSettings).mockResolvedValue(settingsResponse({ source: 'ui' }));
    renderApp();
    const { user, dialog } = await openSettings();

    await user.click(within(dialog).getByRole('button', { name: 'Remove webhook' }));
    expect(dialog).toHaveTextContent(/on-screen only/i);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateAlertSettings).toHaveBeenCalled());
    expect(vi.mocked(api.updateAlertSettings).mock.calls[0]![0].webhookUrl).toBeNull();
  });

  test('a bad threshold or URL blocks saving and says why', async () => {
    renderApp();
    const { user, dialog } = await openSettings();

    const queue = within(dialog).getByLabelText(/queue wait threshold/i);
    await user.clear(queue);
    await user.type(queue, '0');
    expect(dialog).toHaveTextContent('Between 1 and 10080');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(queue);
    await user.type(queue, '20');
    await user.type(within(dialog).getByLabelText(/webhook url/i), 'ftp://example.com');
    expect(dialog).toHaveTextContent('Must start with https:// or http://');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('the backend refusing a save is shown in the dialog', async () => {
    vi.mocked(api.updateAlertSettings).mockRejectedValue(
      toApiError({ response: { status: 400, data: { error: 'The webhook URL must not contain a username or password' } } }),
    );
    renderApp();
    const { user, dialog } = await openSettings();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/must not contain a username or password/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('values changed in the UI can be reset to the deployment values', async () => {
    vi.mocked(api.fetchAlertSettings).mockResolvedValue(
      settingsResponse({
        source: 'ui',
        settings: { ...settingsResponse().settings, queueWait: { enabled: true, thresholdMinutes: 5 } },
      }),
    );
    vi.mocked(api.resetAlertSettings).mockResolvedValue(settingsResponse());
    renderApp();
    const { user, dialog } = await openSettings();

    expect(within(dialog).getByLabelText(/queue wait threshold/i)).toHaveValue('5');
    expect(dialog).toHaveTextContent(/override the deployment values/i);
    await user.click(within(dialog).getByRole('button', { name: /reset to deployment values/i }));

    await waitFor(() => expect(within(dialog).getByLabelText(/queue wait threshold/i)).toHaveValue('15'));
  });

  test('locked by the deployment, everything is read-only', async () => {
    vi.mocked(api.fetchAlertSettings).mockResolvedValue(settingsResponse({ editable: false }));
    renderApp();
    const { dialog } = await openSettings();

    expect(dialog).toHaveTextContent(/fixed by the deployment/i);
    expect(within(dialog).getByLabelText(/queue wait threshold/i)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('without an S3 bucket it says changes will not survive a restart', async () => {
    vi.mocked(api.fetchAlertSettings).mockResolvedValue(settingsResponse({ persisted: false }));
    renderApp();
    const { dialog } = await openSettings();
    expect(dialog).toHaveTextContent(/last until the backend restarts/i);
  });

  test('a test message reports success or the failure reason', async () => {
    vi.mocked(api.fetchAlertSettings).mockResolvedValue(
      settingsResponse({
        settings: { ...settingsResponse().settings, webhookConfigured: true, webhookUrlMasked: 'https://hooks.example.com/…' },
      }),
    );
    vi.mocked(api.sendTestAlert).mockResolvedValueOnce({ lastAttemptAt: minutesAgo(0), lastSuccessAt: minutesAgo(0), lastError: null });
    vi.mocked(api.sendTestAlert).mockRejectedValueOnce(
      toApiError({ response: { status: 502, data: { error: 'Test failed: The webhook answered HTTP 404' } } }),
    );
    renderApp();
    const { user, dialog } = await openSettings();

    await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect(await within(dialog).findByText('Test sent.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect(await within(dialog).findByText(/HTTP 404/)).toBeInTheDocument();
  });
});
