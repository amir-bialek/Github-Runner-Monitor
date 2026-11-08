import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient, REFRESH_INTERVAL_MS } from './queryClient';
import App from './App';
import * as api from './services/api';
import { toApiError } from './services/apiError';
import { SESSION_REFRESH_MS } from './hooks/useSession';
import type { DebugItSession } from './types/api';

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

// Invented values only; this is not a real token.
const signedIn = (loginScope: 'debug-it-only' | 'whole-dashboard' = 'debug-it-only'): DebugItSession => ({
  state: 'signed-in',
  githubUserId: 1000001,
  login: 'dana',
  csrfToken: 'test-csrf-value',
  allowedUser: false,
  administrator: false,
  loginScope,
  credentialsMode: 'organization',
});

function renderApp() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  fireEvent(window, new Event('visibilitychange'));
  fireEvent(document, new Event('visibilitychange'));
}

const oneXFetches = () =>
  [api.fetchScaleSets, api.fetchQueue, api.fetchRunningJobs, api.fetchJobHistory, api.fetchAlerts].reduce(
    (sum, fn) => sum + vi.mocked(fn).mock.calls.length,
    0,
  );

beforeEach(() => {
  vi.mocked(api.fetchScaleSets).mockResolvedValue([]);
  vi.mocked(api.fetchQueue).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchRunningJobs).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchJobHistory).mockResolvedValue([]);
  vi.mocked(api.fetchSettings).mockResolvedValue({ runnersRefreshSeconds: 30 });
  vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: null, alerts: [] });
  vi.mocked(api.fetchSession).mockResolvedValue({ state: 'disabled' });
  vi.mocked(api.signOut).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe('Debug it disabled', () => {
  test('the dashboard renders as 1.x with no session control and exactly one session request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp();
    await screen.findByRole('heading', { name: /job queue/i });
    await waitFor(() => expect(api.fetchSession).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: 'Alerts' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();

    await act(async () => {
      setVisibility('hidden');
      setVisibility('visible');
      fireEvent(window, new Event('online'));
      await vi.advanceTimersByTimeAsync(SESSION_REFRESH_MS * 3);
    });

    expect(api.fetchSession).toHaveBeenCalledTimes(1);
  });
});

describe('signed out', () => {
  test('debug-it-only: a Sign in link in the header and the full dashboard', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'debug-it-only' });
    renderApp();

    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute('href', '/api/debug-it/sign-in');
    expect(screen.getByRole('button', { name: 'Alerts' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /job queue/i })).toBeInTheDocument();
  });

  test('whole-dashboard: only the app bar and a sign in page, and no 1.x hook stays mounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'whole-dashboard' });
    renderApp();

    expect(await screen.findByRole('heading', { name: /sign in to see the dashboard/i })).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Sign in' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/api/debug-it/sign-in');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch to the dark theme/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /alerts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /job queue/i })).not.toBeInTheDocument();

    const before = oneXFetches();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
    });
    expect(oneXFetches()).toBe(before);
  });

  test('the Sign in link is reachable by Tab', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'whole-dashboard' });
    renderApp();
    const link = await screen.findByRole('link', { name: 'Sign in' });
    const user = userEvent.setup();

    await user.tab();
    await user.tab();
    expect(link).toHaveFocus();
  });
});

describe('signed in', () => {
  test('the header shows the login and a Sign out button', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(signedIn());
    renderApp();

    expect(await screen.findByText('dana')).toBeInTheDocument();
    expect(screen.getByText(/signed in as/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /job queue/i })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('test-csrf-value');
  });

  test('Sign out is reachable by Tab and signs out to a Sign in link', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(signedIn());
    renderApp();
    const button = await screen.findByRole('button', { name: 'Sign out' });
    const user = userEvent.setup();

    // Side panel (story 9.1): Dashboard, Alerts, Security, the theme switch, then Sign out.
    for (let i = 0; i < 5; i++) await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('dana')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /job queue/i })).toBeInTheDocument();
  });

  test('signing out under whole-dashboard shows the sign in page', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(signedIn('whole-dashboard'));
    renderApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: /sign in to see the dashboard/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /job queue/i })).not.toBeInTheDocument();
  });

  test('a failed sign out keeps the signed in header', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(signedIn());
    vi.mocked(api.signOut).mockRejectedValue(toApiError({ message: 'fail', response: { status: 503, data: {} } }));
    renderApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(api.signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled());
    expect(screen.getByText('dana')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('the controls render in both themes', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(signedIn());
    renderApp();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Sign out' });

    await user.click(screen.getByRole('button', { name: /switch to the dark theme/i }));
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(screen.getByText('dana')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /switch to the light theme/i }));
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });
});

describe('session refresh', () => {
  test('signed in, then the 60 second refresh answers signed out: the header shows Sign in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.fetchSession).mockResolvedValue(signedIn());
    renderApp();
    await screen.findByRole('button', { name: 'Sign out' });

    vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'debug-it-only' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REFRESH_MS);
    });

    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('dana')).not.toBeInTheDocument();
  });

  test('signed in under whole-dashboard, then a focus refetch answers signed out: the sign in page shows', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(signedIn('whole-dashboard'));
    renderApp();
    await screen.findByRole('button', { name: 'Sign out' });

    vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'whole-dashboard' });
    // React Query v5 treats a tab becoming visible again as window focus.
    await act(async () => {
      setVisibility('hidden');
    });
    await act(async () => {
      setVisibility('visible');
    });

    expect(await screen.findByRole('heading', { name: /sign in to see the dashboard/i })).toBeInTheDocument();
  });

  test('signed in, then the refresh fails with 503: dana and Sign out stay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.fetchSession).mockResolvedValue(signedIn());
    renderApp();
    await screen.findByRole('button', { name: 'Sign out' });
    const calls = vi.mocked(api.fetchSession).mock.calls.length;

    vi.mocked(api.fetchSession).mockRejectedValue(
      toApiError({ message: 'x', response: { status: 503, data: { error: 'Debug it settings could not be read; please try again.' } } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REFRESH_MS);
    });

    expect(vi.mocked(api.fetchSession).mock.calls.length).toBeGreaterThan(calls);
    expect(screen.getByText('dana')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});

describe('session read fails', () => {
  test('a 503 leaves the dashboard as 1.x with no session control', async () => {
    vi.mocked(api.fetchSession).mockRejectedValue(
      toApiError({ message: 'x', response: { status: 503, data: { error: 'Debug it settings could not be read; please try again.' } } }),
    );
    renderApp();

    await screen.findByRole('heading', { name: /job queue/i });
    await waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.queryByText(/debug it settings/i)).not.toBeInTheDocument();
  });
});
