import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';
import App from './App';
import * as api from './services/api';
import type { AlertSettingsResponse, DebugItSession } from './types/api';

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
  fetchSession: vi.fn(),
  signOut: vi.fn(),
  signInUrl: '/api/debug-it/sign-in',
  fetchDebugItRuns: vi.fn(async () => ({ allowedRepositories: [], runs: [] })),
  startDebugRun: vi.fn(),
  fetchDebugRun: vi.fn(),
  fetchDebugRunResult: vi.fn(),
  saveDebugRunFeedback: vi.fn(),
  fetchDebugItSettings: vi.fn(),
  fetchDebugItUsage: vi.fn(async () => ({ month: '2026-11', credentialsMode: 'organization', monthlyCap: 5, users: [] })),
  addAllowedRepository: vi.fn(),
  removeAllowedRepository: vi.fn(),
  addAllowedUser: vi.fn(),
  removeAllowedUser: vi.fn(),
}));

const RESTRICTED_TEXT = 'Only Debug it administrators can change alert settings.';

// Invented values only; this is not a real token.
const signedIn = (githubUserId: number, login: string, administrator: boolean): DebugItSession => ({
  state: 'signed-in',
  githubUserId,
  login,
  csrfToken: 'test-csrf-value',
  allowedUser: true,
  administrator,
  loginScope: 'debug-it-only',
  credentialsMode: 'organization',
});

const DANA = signedIn(1000001, 'dana', true);
const LEE = signedIn(1000002, 'lee', false);

function settingsResponse(overrides: Partial<AlertSettingsResponse> = {}): AlertSettingsResponse {
  const defaults = {
    queueWait: { enabled: true, thresholdMinutes: 15 },
    runnerGroupOffline: { enabled: true, thresholdMinutes: 10 },
    webhookConfigured: true,
    webhookUrlMasked: 'https://hooks.example.com/…',
  };
  return {
    settings: { ...defaults, queueWait: { enabled: true, thresholdMinutes: 20 } },
    deploymentDefaults: defaults,
    source: 'ui',
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
  await user.click(await screen.findByRole('button', { name: /^alerts/i }));
  await screen.findByRole('heading', { name: 'Alerts:' });
  await user.click(screen.getByRole('button', { name: 'Alert settings' }));
  const dialog = await screen.findByRole('dialog', { name: /alert settings/i });
  await within(dialog).findByLabelText(/queue wait threshold/i);
  return { user, dialog };
}

function expectEditable(dialog: HTMLElement) {
  expect(within(dialog).queryByText(RESTRICTED_TEXT)).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: /reset to deployment values/i })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Send test' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Remove webhook' })).toBeInTheDocument();
  expect(within(dialog).getByLabelText(/replace webhook url/i)).toBeInTheDocument();
  expect(within(dialog).getByLabelText(/queue wait threshold/i)).toBeEnabled();
}

async function expectRestricted(dialog: HTMLElement) {
  expect(await within(dialog).findByText(RESTRICTED_TEXT)).toBeInTheDocument();
  // Values are still shown.
  expect(within(dialog).getByLabelText(/queue wait threshold/i)).toHaveValue('20');
  expect(within(dialog).getByLabelText(/runner group offline threshold/i)).toHaveValue('10');
  expect(within(dialog).getByText('Current webhook: https://hooks.example.com/…')).toBeInTheDocument();
  // Nothing can be changed.
  expect(within(dialog).getByLabelText(/queue wait threshold/i)).toBeDisabled();
  expect(within(dialog).getByLabelText(/runner group offline threshold/i)).toBeDisabled();
  for (const toggle of within(dialog).getAllByRole('switch')) expect(toggle).toBeDisabled();
  expect(within(dialog).queryByLabelText(/webhook url/i)).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: /reset to deployment values/i })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Send test' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Remove webhook' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
}

beforeEach(() => {
  vi.mocked(api.fetchScaleSets).mockResolvedValue([]);
  vi.mocked(api.fetchQueue).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchRunningJobs).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchJobHistory).mockResolvedValue([]);
  vi.mocked(api.fetchSettings).mockResolvedValue({ runnersRefreshSeconds: 30 });
  vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: null, alerts: [] });
  vi.mocked(api.fetchAlertSettings).mockResolvedValue(settingsResponse());
  vi.mocked(api.fetchSession).mockResolvedValue({ state: 'disabled' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('alert settings access (FR45)', () => {
  test('a signed in non administrator sees the values but cannot change them', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(LEE);
    renderApp();
    const { user, dialog } = await openSettings();
    await expectRestricted(dialog);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /alert settings/i })).not.toBeInTheDocument());
    expect(api.updateAlertSettings).not.toHaveBeenCalled();
    expect(api.resetAlertSettings).not.toHaveBeenCalled();
    expect(api.sendTestAlert).not.toHaveBeenCalled();
  });

  test('a signed out visitor sees the values but cannot change them', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'debug-it-only' });
    renderApp();
    const { dialog } = await openSettings();
    await expectRestricted(dialog);
  });

  test('an administrator can change and save', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(DANA);
    vi.mocked(api.updateAlertSettings).mockResolvedValue(settingsResponse());
    renderApp();
    const { user, dialog } = await openSettings();
    expectEditable(dialog);

    const threshold = within(dialog).getByLabelText(/queue wait threshold/i);
    await user.clear(threshold);
    await user.type(threshold, '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateAlertSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateAlertSettings).mock.calls[0]![0]).toMatchObject({
      queueWait: { enabled: true, thresholdMinutes: 5 },
    });
  });

  test('with Debug it disabled the dialog is as in 1.x', async () => {
    renderApp();
    const { dialog } = await openSettings();
    expectEditable(dialog);
  });

  test('an unreadable session leaves the dialog as in 1.x', async () => {
    vi.mocked(api.fetchSession).mockRejectedValue(new Error('Debug it settings could not be read; please try again.'));
    renderApp();
    const { dialog } = await openSettings();
    expectEditable(dialog);
  });

  test('a non administrator on locked settings sees both notes and no Save', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(LEE);
    vi.mocked(api.fetchAlertSettings).mockResolvedValue(settingsResponse({ editable: false }));
    renderApp();
    const { dialog } = await openSettings();
    expect(within(dialog).getByText(RESTRICTED_TEXT)).toBeInTheDocument();
    expect(within(dialog).getByText(/fixed by the deployment/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  test('an administrator on locked settings gets the 1.x locked dialog', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(DANA);
    vi.mocked(api.fetchAlertSettings).mockResolvedValue(settingsResponse({ editable: false }));
    renderApp();
    const { dialog } = await openSettings();
    expect(within(dialog).queryByText(RESTRICTED_TEXT)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/fixed by the deployment/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
