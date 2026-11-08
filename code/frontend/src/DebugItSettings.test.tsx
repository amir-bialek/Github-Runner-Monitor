import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';
import App from './App';
import * as api from './services/api';
import { ApiError } from './services/apiError';
import type { DebugItSession, DebugItSettingsView, DebugItUsageView } from './types/api';
import { formatDateThenTime } from './utils/format';

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
  fetchDebugItUsage: vi.fn(),
  addAllowedRepository: vi.fn(),
  removeAllowedRepository: vi.fn(),
  addAllowedUser: vi.fn(),
  removeAllowedUser: vi.fn(),
}));

// Invented values only; this is not a real token.
const session = (administrator: boolean): DebugItSession => ({
  state: 'signed-in',
  githubUserId: 1000001,
  login: 'dana',
  csrfToken: 'test-csrf-value',
  allowedUser: true,
  administrator,
  loginScope: 'debug-it-only',
  credentialsMode: 'organization',
});

const SETTINGS: DebugItSettingsView = {
  allowedRepositories: ['acme/payments-api'],
  allowedUsers: [
    { githubUserId: 1000001, login: 'dana' },
    { githubUserId: 1000009, login: null },
  ],
};

const USAGE: DebugItUsageView = {
  month: '2026-11',
  credentialsMode: 'organization',
  monthlyCap: 5,
  users: [
    { githubUserId: 1000001, login: 'dana', runs: 2, costUsd: 1.5, fixPullRequests: 1 },
    { githubUserId: 1000009, login: null, runs: 1, costUsd: 0.254, fixPullRequests: 0 },
  ],
};

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
  renderApp();
  await user.click(await screen.findByRole('button', { name: 'Debug it settings' }));
  await screen.findByRole('heading', { name: 'Debug it settings' });
  return user;
}

const fireClick = (element: HTMLElement) => act(() => {
  fireEvent.click(element);
});

const section = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  vi.mocked(api.fetchScaleSets).mockResolvedValue([]);
  vi.mocked(api.fetchQueue).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchRunningJobs).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchJobHistory).mockResolvedValue([]);
  vi.mocked(api.fetchSettings).mockResolvedValue({ runnersRefreshSeconds: 30 });
  vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: null, alerts: [] });
  vi.mocked(api.fetchSession).mockResolvedValue(session(true));
  vi.mocked(api.fetchDebugItSettings).mockResolvedValue(SETTINGS);
  vi.mocked(api.fetchDebugItUsage).mockResolvedValue(USAGE);
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('settings link', () => {
  test('an administrator sees it before the session control', async () => {
    renderApp();
    const link = await screen.findByRole('button', { name: 'Debug it settings' });
    const signOut = screen.getByRole('button', { name: 'Sign out' });
    expect(link.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test.each([
    ['a non administrator', session(false)],
    ['a signed out user', { state: 'signed-out', loginScope: 'debug-it-only' } as DebugItSession],
    ['Debug it disabled', { state: 'disabled' } as DebugItSession],
  ])('%s never sees it', async (_name, value) => {
    vi.mocked(api.fetchSession).mockResolvedValue(value);
    renderApp();
    await screen.findByRole('heading', { name: /github runner monitor/i });
    await waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('button', { name: /alerts/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Debug it settings' })).not.toBeInTheDocument();
  });
});

describe('settings page', () => {
  test('opens in place of the dashboard and goes back', async () => {
    const user = await openSettings();
    expect(screen.queryByRole('button', { name: /^alerts/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to dashboard' }));
    expect(screen.queryByRole('heading', { name: 'Debug it settings' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^alerts/i })).toBeInTheDocument();
  });

  test('lists repositories and users, with the ID when the login is unknown', async () => {
    await openSettings();
    const repos = await screen.findByRole('list', { name: 'Allowed repositories' });
    expect(within(repos).getByText('acme/payments-api')).toBeInTheDocument();
    const users = screen.getByRole('list', { name: 'Allowed users' });
    expect(within(users).getByText('dana')).toBeInTheDocument();
    expect(within(users).getByText('user ID 1000009')).toBeInTheDocument();
    expect(within(users).getByRole('button', { name: 'Remove user ID 1000009' })).toBeInTheDocument();
  });

  test('empty lists say nobody and no repository is allowed', async () => {
    vi.mocked(api.fetchDebugItSettings).mockResolvedValue({ allowedRepositories: [], allowedUsers: [] });
    await openSettings();
    expect(await screen.findByText(/no repository is allowed/i)).toBeInTheDocument();
    expect(screen.getByText(/nobody is allowed/i)).toBeInTheDocument();
  });

  test('adding a repository with the button calls the API and shows the new list', async () => {
    vi.mocked(api.addAllowedRepository).mockResolvedValue({
      ...SETTINGS,
      allowedRepositories: ['acme/payments-api', 'acme/web'],
    });
    const user = await openSettings();
    const repos = section('Allowed repositories');
    await user.type(within(repos).getByRole('textbox', { name: 'Repository' }), 'acme/web');
    await user.click(within(repos).getByRole('button', { name: 'Add repository' }));
    expect(api.addAllowedRepository).toHaveBeenCalledWith('acme/web', expect.anything());
    expect(await within(repos).findByText('acme/web')).toBeInTheDocument();
    expect(within(repos).getByRole('textbox', { name: 'Repository' })).toHaveValue('');
  });

  test('Enter submits the user form', async () => {
    vi.mocked(api.addAllowedUser).mockResolvedValue({
      ...SETTINGS,
      allowedUsers: [...SETTINGS.allowedUsers, { githubUserId: 1000002, login: 'lee' }],
    });
    const user = await openSettings();
    const users = section('Allowed users');
    await user.type(within(users).getByRole('textbox', { name: 'GitHub login' }), 'lee{Enter}');
    expect(api.addAllowedUser).toHaveBeenCalledWith('lee', expect.anything());
    expect(await within(users).findByText('lee')).toBeInTheDocument();
  });

  test('remove calls the API and shows the new list', async () => {
    vi.mocked(api.removeAllowedRepository).mockResolvedValue({ ...SETTINGS, allowedRepositories: [] });
    vi.mocked(api.removeAllowedUser).mockResolvedValue({ ...SETTINGS, allowedUsers: [SETTINGS.allowedUsers[1]!] });
    const user = await openSettings();
    await user.click(await screen.findByRole('button', { name: 'Remove acme/payments-api' }));
    expect(api.removeAllowedRepository).toHaveBeenCalledWith('acme/payments-api', expect.anything());
    expect(await screen.findByText(/no repository is allowed/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove dana' }));
    expect(api.removeAllowedUser).toHaveBeenCalledWith(1000001, expect.anything());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove dana' })).not.toBeInTheDocument());
  });

  test('a 409 shows the error and a Reload button that refetches', async () => {
    vi.mocked(api.addAllowedRepository).mockRejectedValue(
      new ApiError('The Debug it settings kept changing while your change was being saved; please reload and try again.', {
        source: 'backend',
        status: 409,
      }),
    );
    const user = await openSettings();
    await user.type(await screen.findByRole('textbox', { name: 'Repository' }), 'acme/web{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/kept changing/i);
    const calls = vi.mocked(api.fetchDebugItSettings).mock.calls.length;
    vi.mocked(api.fetchDebugItSettings).mockResolvedValue({
      ...SETTINGS,
      allowedRepositories: ['acme/payments-api', 'acme/other'],
    });
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(vi.mocked(api.fetchDebugItSettings).mock.calls.length).toBe(calls + 1));
    expect(await screen.findByText('acme/other')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a 403 shows the backend text without a Reload button', async () => {
    vi.mocked(api.addAllowedUser).mockRejectedValue(
      new ApiError('Only Debug it administrators can do this.', { source: 'backend', status: 403 }),
    );
    const user = await openSettings();
    await user.type(await screen.findByRole('textbox', { name: 'GitHub login' }), 'lee{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Only Debug it administrators can do this.');
    expect(within(alert).queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });

  test('controls are keyboard reachable', async () => {
    const user = await openSettings();
    await screen.findByRole('list', { name: 'Allowed repositories' });
    const back = screen.getByRole('button', { name: 'Back to dashboard' });
    act(() => back.focus());
    await user.tab();
    expect(screen.getByRole('button', { name: 'Remove acme/payments-api' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveFocus();
  });
});

describe('isolation status', () => {
  test('on shows when the check passed', async () => {
    vi.mocked(api.fetchDebugItSettings).mockResolvedValue({
      ...SETTINGS,
      isolation: { state: 'on', reason: null, checkedAt: '2026-11-05T10:02:00.000Z' },
    });
    await openSettings();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      `Debug it is on. The isolation check passed at ${formatDateThenTime(new Date('2026-11-05T10:02:00.000Z'))}.`,
    );
    expect(alert).not.toHaveTextContent('2026-11-05T10:02:00.000Z');
    expect(alert.className).toMatch(/Success/);
  });

  test('off shows the reason as an error', async () => {
    const reason = 'Debug it is off because the isolation check Job did not finish within 2 minutes.';
    vi.mocked(api.fetchDebugItSettings).mockResolvedValue({
      ...SETTINGS,
      isolation: { state: 'off', reason, checkedAt: '2026-11-05T10:02:00.000Z' },
    });
    await openSettings();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`${reason} Restart the backend to run the check again.`);
    expect(alert.className).toMatch(/Error/);
    expect(await screen.findByRole('list', { name: 'Allowed repositories' })).toBeInTheDocument();
  });

  test('checking shows the reason and refetches every 5 seconds until it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const checking = 'Debug it is off until the startup isolation check finishes.';
      vi.mocked(api.fetchDebugItSettings)
        .mockResolvedValueOnce({ ...SETTINGS, isolation: { state: 'checking', reason: checking, checkedAt: null } })
        .mockResolvedValue({
          ...SETTINGS,
          isolation: { state: 'on', reason: null, checkedAt: '2026-11-05T10:02:00.000Z' },
        });
      renderApp();
      fireClick(await screen.findByRole('button', { name: 'Debug it settings' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(checking);
      expect(alert).not.toHaveTextContent(/Restart the backend/);
      expect(alert.className).toMatch(/Info/);
      expect(api.fetchDebugItSettings).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      await waitFor(() => expect(api.fetchDebugItSettings).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(/The isolation check passed at/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(api.fetchDebugItSettings).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failing refetch while checking stops the polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.fetchDebugItSettings)
        .mockResolvedValueOnce({
          ...SETTINGS,
          isolation: { state: 'checking', reason: 'Debug it is off until the startup isolation check finishes.', checkedAt: null },
        })
        .mockRejectedValue(new ApiError('The monitor could not be reached.', { source: 'backend', status: 503 }));
      renderApp();
      fireClick(await screen.findByRole('button', { name: 'Debug it settings' }));
      await screen.findByText('Debug it is off until the startup isolation check finishes.');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      await waitFor(() => expect(api.fetchDebugItSettings).toHaveBeenCalledTimes(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
      });
      expect(api.fetchDebugItSettings).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('without an isolation status no status alert shows', async () => {
    await openSettings();
    await screen.findByRole('list', { name: 'Allowed repositories' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('usage this month', () => {
  const rowsOf = (table: HTMLElement) =>
    within(table)
      .getAllByRole('row')
      .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent));

  test('organization mode shows each user with the monthly cap column', async () => {
    await openSettings();
    const usage = await screen.findByRole('region', { name: 'Usage this month' });
    expect(within(usage).getByText('Runs, cost and fix pull requests of 2026-11 (UTC).')).toBeInTheDocument();
    const table = within(usage).getByRole('table', { name: 'Usage this month' });
    expect(rowsOf(table)).toEqual([
      ['User', 'Runs', 'Cost', 'Fix pull requests', 'Monthly cap'],
      ['dana', '2', '$1.50', '1', '2 of 5'],
      ['user ID 1000009', '1', '$0.25', '0', '1 of 5'],
    ]);
    expect(within(usage).queryByText('Runs use personal keys, so there is no monthly cap.')).not.toBeInTheDocument();
  });

  test('personal mode hides the cap column and says why', async () => {
    vi.mocked(api.fetchDebugItUsage).mockResolvedValue({ ...USAGE, credentialsMode: 'personal', monthlyCap: null });
    await openSettings();
    const usage = await screen.findByRole('region', { name: 'Usage this month' });
    expect(await within(usage).findByText('Runs use personal keys, so there is no monthly cap.')).toBeInTheDocument();
    const table = within(usage).getByRole('table', { name: 'Usage this month' });
    expect(rowsOf(table)[0]).toEqual(['User', 'Runs', 'Cost', 'Fix pull requests']);
    expect(within(usage).queryByText('Monthly cap')).not.toBeInTheDocument();
  });

  test('no usage this month shows the empty sentence', async () => {
    vi.mocked(api.fetchDebugItUsage).mockResolvedValue({ ...USAGE, users: [] });
    await openSettings();
    const usage = await screen.findByRole('region', { name: 'Usage this month' });
    expect(await within(usage).findByText('Nobody has used Debug it this month.')).toBeInTheDocument();
    expect(within(usage).queryByRole('table')).not.toBeInTheDocument();
  });

  test('a failed read shows the backend sentence inside the section only', async () => {
    const sentence = 'S3 cannot be reached, so Debug it usage cannot be read right now.';
    vi.mocked(api.fetchDebugItUsage).mockRejectedValue(new ApiError(sentence, { source: 'backend', status: 503 }));
    await openSettings();
    const usage = await screen.findByRole('region', { name: 'Usage this month' });
    expect(await within(usage).findByRole('alert')).toHaveTextContent(sentence);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'Allowed repositories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add repository' })).toBeInTheDocument();
  });

  test('a login with markup renders as text', async () => {
    vi.mocked(api.fetchDebugItUsage).mockResolvedValue({
      ...USAGE,
      users: [{ githubUserId: 1000001, login: '<b>dana</b>', runs: 1, costUsd: 0, fixPullRequests: 0 }],
    });
    await openSettings();
    const usage = await screen.findByRole('region', { name: 'Usage this month' });
    expect(await within(usage).findByText('<b>dana</b>')).toBeInTheDocument();
    expect(usage.querySelector('b')).toBeNull();
  });
});
