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
  jobCount: 4,
  jobs: [20, 18, 17, 16].map((waited, index) => ({
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

async function openSettings() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^alert settings/i }));
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

describe('on-screen alerts', () => {
  test('nothing is shown when there are no alerts', async () => {
    renderApp();
    await waitFor(() => expect(api.fetchAlerts).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: /active alerts/i })).not.toBeInTheDocument();
    expect(document.title).not.toContain('alert');
  });

  test('each active alert is shown at the top of the page, offline first', async () => {
    vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: minutesAgo(0), alerts: [offlineAlert, queueAlert] });
    renderApp();

    const region = await screen.findByRole('region', { name: /active alerts/i });
    const alerts = within(region).getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Runner group offline');
    expect(alerts[0]).toHaveTextContent('arc-windows-x64 has 0 of 2 runners online');
    expect(alerts[0]).toHaveTextContent(/no runners online for 12 ?m/i);
    expect(alerts[1]).toHaveTextContent('Jobs stuck in the queue');
    expect(alerts[1]).toHaveTextContent('4 jobs have waited longer than 15 minutes for arc-gpu-a10');
    expect(alerts[1]).toHaveTextContent(/oldest job waiting 20 ?m/i);
  });

  test('a queue alert lists the stuck jobs, linking to GitHub, three at a time', async () => {
    vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: minutesAgo(0), alerts: [queueAlert] });
    renderApp();
    const user = userEvent.setup();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getAllByRole('listitem').filter((item) => item.textContent?.includes('waiting'))).toHaveLength(3);
    expect(within(alert).getByRole('link', { name: /build-0/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/web-app/actions/runs/1/job/900100',
    );

    await user.click(within(alert).getByRole('button', { name: 'Show 1 more' }));
    expect(within(alert).getByRole('link', { name: /build-3/ })).toBeInTheDocument();
  });

  test('the tab title and the header badge carry the alert count', async () => {
    vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: minutesAgo(0), alerts: [offlineAlert, queueAlert] });
    renderApp();

    await screen.findByRole('region', { name: /active alerts/i });
    expect(document.title).toMatch(/^⚠ 2 alerts · /);
    expect(screen.getByRole('button', { name: 'Alert settings — 2 active' })).toBeInTheDocument();
  });

  test('a failing alerts endpoint does not take the dashboard down', async () => {
    vi.mocked(api.fetchAlerts).mockRejectedValue(toApiError({ message: 'Network Error' }));
    renderApp();
    expect(await screen.findByRole('heading', { name: /available runners/i })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /active alerts/i })).not.toBeInTheDocument();
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
