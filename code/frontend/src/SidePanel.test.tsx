import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';
import App from './App';
import AppLayout from './components/AppLayout';
import { PLACEMENTS } from './components/AlertsPopover';
import * as api from './services/api';
import { APP_HEADING } from './appConfig';
import { WIDE_WINDOW, setNarrowWindow, setWindowWidth } from './test/matchMedia';
import type { DebugItSession, MonitorAlert } from './types/api';

vi.mock('./services/api', () => ({
  fetchScaleSets: vi.fn(),
  fetchQueue: vi.fn(),
  fetchRunningJobs: vi.fn(),
  fetchJobHistory: vi.fn(),
  fetchRunners: vi.fn(async () => []),
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
  fetchDebugItSettings: vi.fn(async () => ({ allowedRepositories: [], allowedUsers: [] })),
  fetchDebugItUsage: vi.fn(async () => ({ month: '2026-11', credentialsMode: 'organization', monthlyCap: 5, users: [] })),
  addAllowedRepository: vi.fn(),
  removeAllowedRepository: vi.fn(),
  addAllowedUser: vi.fn(),
  removeAllowedUser: vi.fn(),
  fetchPersonalKey: vi.fn(async () => ({ credentialsMode: 'personal', saved: false, last4: null })),
  savePersonalKey: vi.fn(),
  deletePersonalKey: vi.fn(),
}));

// Invented values only; this is not a real token.
const SIGNED_IN: DebugItSession = {
  state: 'signed-in',
  githubUserId: 1000001,
  login: 'dana',
  csrfToken: 'test-csrf-value',
  allowedUser: false,
  administrator: false,
  loginScope: 'debug-it-only',
  credentialsMode: 'organization',
};
const ADMINISTRATOR: DebugItSession = { ...SIGNED_IN, administrator: true };
const PERSONAL: DebugItSession = { ...SIGNED_IN, allowedUser: true, credentialsMode: 'personal' };

const THEME = 'Switch to the dark theme';

const offlineAlert = (id: string): MonitorAlert => ({
  id,
  kind: 'runner_group_offline',
  scaleSet: `arc-${id}`,
  thresholdMinutes: 10,
  since: new Date(Date.now() - 15 * 60_000).toISOString(),
  firedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  message: 'offline',
  totalRunners: 2,
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

/** The panel's controls in page order, by accessible name. */
function controls(nav: HTMLElement): string[] {
  return Array.from(nav.querySelectorAll<HTMLElement>('button, a')).map(
    (control) => control.getAttribute('aria-label') ?? control.textContent ?? '',
  );
}

const panel = () => screen.getByRole('navigation', { name: 'Main' });

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
  window.localStorage.clear();
});

describe('side panel on a wide window', () => {
  test('holds the heading with the theme switch, the items in order, then the account; no header', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(ADMINISTRATOR);
    const { container } = renderApp();
    await screen.findByRole('button', { name: 'Sign out' });

    const nav = panel();
    const heading = within(nav).getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(APP_HEADING);
    expect(controls(nav)).toEqual([THEME, 'Dashboard', 'Alerts', 'Debug it settings', 'Security', 'Sign out']);
    expect(heading.compareDocumentPosition(within(nav).getByRole('button', { name: 'Dashboard' })) &
      Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('header')).toBeNull();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  test.each<[string, () => void, string[], boolean]>([
    ['Debug it disabled', () => {}, [THEME, 'Alerts'], false],
    ['session loading', () => vi.mocked(api.fetchSession).mockReturnValue(new Promise(() => {})), [THEME, 'Alerts'], false],
    ['session failed', () => vi.mocked(api.fetchSession).mockRejectedValue(new Error('down')), [THEME, 'Alerts'], false],
    [
      'signed out, debug-it-only',
      () => vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'debug-it-only' }),
      [THEME, 'Dashboard', 'Alerts', 'Security', 'Sign in'],
      true,
    ],
    [
      'signed in',
      () => vi.mocked(api.fetchSession).mockResolvedValue(SIGNED_IN),
      [THEME, 'Dashboard', 'Alerts', 'Security', 'Sign out'],
      true,
    ],
    [
      'administrator',
      () => vi.mocked(api.fetchSession).mockResolvedValue(ADMINISTRATOR),
      [THEME, 'Dashboard', 'Alerts', 'Debug it settings', 'Security', 'Sign out'],
      true,
    ],
    [
      'personal key mode',
      () => vi.mocked(api.fetchSession).mockResolvedValue(PERSONAL),
      [THEME, 'Dashboard', 'Alerts', 'Security', 'Sign out', 'Personal key'],
      true,
    ],
  ])('%s: exactly the expected controls', async (_name, arrange, expected, debugIt) => {
    arrange();
    renderApp();
    await screen.findByRole('heading', { name: /job queue/i });
    if (debugIt) await within(panel()).findByRole('button', { name: 'Dashboard' });
    else await waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
    expect(controls(panel())).toEqual(expected);
    expect(within(panel()).getByRole('heading', { level: 1 })).toHaveTextContent(APP_HEADING);
  });

  test('whole-dashboard and signed out: only the heading and the theme switch, and the sign in card', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'whole-dashboard' });
    renderApp();
    expect(await screen.findByRole('heading', { name: /sign in to see the dashboard/i })).toBeInTheDocument();
    expect(controls(panel())).toEqual([THEME]);
    expect(within(panel()).getByRole('heading', { level: 1 })).toHaveTextContent(APP_HEADING);
  });

  test('the open view is highlighted with aria-current="page" and the others are not', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(ADMINISTRATOR);
    renderApp();
    const user = userEvent.setup();
    // Each view draws its own panel, so look it up again every time.
    const item = (name: string) => within(panel()).getByRole('button', { name });
    await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('button', { name: 'Dashboard' });

    const current = () =>
      ['Dashboard', 'Debug it settings', 'Security'].filter((name) => item(name).getAttribute('aria-current') === 'page');

    expect(current()).toEqual(['Dashboard']);
    expect(item('Dashboard')).toHaveClass('Mui-selected');
    expect(item('Alerts')).not.toHaveAttribute('aria-current');

    await user.click(item('Security'));
    await screen.findByRole('heading', { name: 'Debug it security' });
    expect(current()).toEqual(['Security']);
    expect(item('Security')).toHaveClass('Mui-selected');
    expect(item('Security')).toHaveFocus();
    expect(item('Dashboard')).not.toHaveClass('Mui-selected');

    await user.click(item('Debug it settings'));
    await screen.findByRole('heading', { name: 'Debug it settings' });
    expect(current()).toEqual(['Debug it settings']);
    expect(within(panel()).queryByRole('button', { name: /^Alerts/ })).not.toBeInTheDocument();

    await user.click(item('Dashboard'));
    await screen.findByRole('heading', { name: /job queue/i });
    expect(current()).toEqual(['Dashboard']);
    expect(item('Dashboard')).toHaveFocus();
  });

  test('a signed in user sees a letter avatar, no image, and the login', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(SIGNED_IN);
    renderApp();
    await screen.findByRole('button', { name: 'Sign out' });
    const nav = panel();
    const avatar = nav.querySelector('.MuiAvatar-root');
    expect(avatar).toHaveTextContent(/^D$/);
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(nav.querySelector('img')).toBeNull();
    expect(within(nav).getByText('Signed in as', { exact: false })).toHaveTextContent('Signed in as');
    expect(within(nav).getByTitle('dana')).toHaveTextContent('Signed in as dana');
  });

  test('Alerts shows its active count and opens the alerts popover', async () => {
    vi.mocked(api.fetchAlerts).mockResolvedValue({
      evaluatedAt: new Date().toISOString(),
      alerts: [offlineAlert('a'), offlineAlert('b')],
    });
    renderApp();
    const user = userEvent.setup();
    const alerts = await within(panel()).findByRole('button', { name: 'Alerts — 2 active' });
    await user.click(alerts);
    expect(await screen.findByRole('heading', { name: 'Alerts:' })).toBeInTheDocument();
  });

  test('Personal key opens the personal key dialog', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(PERSONAL);
    renderApp();
    const user = userEvent.setup();
    await user.click(await within(panel()).findByRole('button', { name: 'Personal key' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('top bar and drawer on a narrow window', () => {
  beforeEach(() => {
    setNarrowWindow();
  });

  test.each<[string, DebugItSession, string]>([
    ['Personal key', PERSONAL, 'Personal key'],
    ['Sign out', SIGNED_IN, 'Sign out'],
  ])('%s closes the drawer', async (_name, session, button) => {
    vi.mocked(api.fetchSession).mockResolvedValue(session);
    renderApp();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: /job queue/i });

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await user.click(await within(nav).findByRole('button', { name: button }));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument());
  });

  test('no panel until the menu button opens the drawer; choosing an item closes it', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(ADMINISTRATOR);
    renderApp();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: /job queue/i });
    await waitFor(() => expect(api.fetchSession).toHaveBeenCalled());

    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(APP_HEADING);
    const menu = screen.getByRole('button', { name: 'Open menu' });

    await user.click(menu);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await within(nav).findByRole('button', { name: 'Security' });
    expect(controls(nav)).toEqual([THEME, 'Dashboard', 'Alerts', 'Debug it settings', 'Security', 'Sign out']);
    // The drawer's heading is not a second h1.
    expect(screen.getAllByRole('heading', { level: 1, hidden: true })).toHaveLength(1);

    await user.click(within(nav).getByRole('button', { name: 'Security' }));
    await screen.findByRole('heading', { name: 'Debug it security' });
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument());
  });

  test('Alerts in the drawer closes it and opens the popover under the menu button', async () => {
    renderApp();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: /job queue/i });

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(controls(nav)).toEqual([THEME, 'Alerts']);

    await user.click(within(nav).getByRole('button', { name: 'Alerts' }));
    expect(await screen.findByRole('heading', { name: 'Alerts:' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument());
  });
});

describe('where the Alerts popover is anchored', () => {
  const renderLayout = (onOpen: ReturnType<typeof vi.fn>, count = 0) =>
    render(
      <AppLayout
        heading={APP_HEADING}
        items={[{ label: 'Dashboard', current: true, onSelect: () => {} }]}
        account={null}
        themeToggle={null}
        alerts={{ count, onOpen }}
      >
        <main />
      </AppLayout>,
    );

  test('on a wide window: beside the Alerts item', async () => {
    const onOpen = vi.fn();
    renderLayout(onOpen);
    const alerts = within(panel()).getByRole('button', { name: 'Alerts' });
    await userEvent.setup().click(alerts);
    expect(onOpen).toHaveBeenCalledWith(alerts, 'side');
  });

  test('on a narrow window: under the menu button', async () => {
    setNarrowWindow();
    const onOpen = vi.fn();
    renderLayout(onOpen);
    const user = userEvent.setup();
    const menu = screen.getByRole('button', { name: 'Open menu' });
    await user.click(menu);
    await user.click(within(await screen.findByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Alerts' }));
    expect(onOpen).toHaveBeenCalledWith(menu, 'below');
  });

  test('a count over 99 shows 99+ and the name keeps the real count', () => {
    renderLayout(vi.fn(), 150);
    const alerts = within(panel()).getByRole('button', { name: 'Alerts — 150 active' });
    expect(alerts).toHaveTextContent('99+');
    expect(alerts).not.toHaveTextContent('150');
  });

  test('each placement maps to its anchor origin', () => {
    expect(PLACEMENTS.side.anchorOrigin).toEqual({ vertical: 'top', horizontal: 'right' });
    expect(PLACEMENTS.side.transformOrigin).toEqual({ vertical: 'top', horizontal: 'left' });
    expect(PLACEMENTS.below.anchorOrigin).toEqual({ vertical: 'bottom', horizontal: 'left' });
    expect(PLACEMENTS.below.transformOrigin).toEqual({ vertical: 'top', horizontal: 'left' });
  });
});

describe('the drawer when the window widens', () => {
  test('is closed again when the window narrows', async () => {
    setNarrowWindow();
    const layout = () => (
      <AppLayout heading={APP_HEADING} items={[]} account={null} themeToggle={null}>
        <main />
      </AppLayout>
    );
    const { rerender } = render(layout());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('navigation', { name: 'Main' });

    setWindowWidth(WIDE_WINDOW);
    rerender(layout());
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();

    setNarrowWindow();
    rerender(layout());
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument());
  });
});
