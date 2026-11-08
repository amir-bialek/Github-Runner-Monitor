import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';
import App from './App';
import * as api from './services/api';
import { SECURITY_DOC_URL } from './appConfig';
import { FLOW_PARTS, SECURITY_CONTROLS, SECURITY_TERMS } from './components/SecurityPage';
import securityPageSource from './components/SecurityPage.tsx?raw';
import securityDoc from '../../../docs/security-design.md?raw';
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

const SIGNED_OUT: DebugItSession = { state: 'signed-out', loginScope: 'debug-it-only' } as DebugItSession;
const DISABLED: DebugItSession = { state: 'disabled' } as DebugItSession;

function renderApp() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
  return queryClient;
}

const PAGE_HEADING = { name: 'Debug it security' };

async function openSecurity() {
  const user = userEvent.setup();
  const queryClient = renderApp();
  await user.click(await screen.findByRole('button', { name: 'Security' }));
  await screen.findByRole('heading', PAGE_HEADING);
  return { user, queryClient };
}

beforeEach(() => {
  vi.mocked(api.fetchScaleSets).mockResolvedValue([]);
  vi.mocked(api.fetchQueue).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchRunningJobs).mockResolvedValue({ orderingIsEstimate: true, note: '', incomplete: false, items: [] });
  vi.mocked(api.fetchJobHistory).mockResolvedValue([]);
  vi.mocked(api.fetchSettings).mockResolvedValue({ runnersRefreshSeconds: 30 });
  vi.mocked(api.fetchAlerts).mockResolvedValue({ evaluatedAt: null, alerts: [] });
  vi.mocked(api.fetchSession).mockResolvedValue(session(true));
  vi.mocked(api.fetchDebugItSettings).mockResolvedValue({ allowedRepositories: [], allowedUsers: [] });
  vi.mocked(api.fetchDebugItUsage).mockResolvedValue({
    month: '2026-11',
    credentialsMode: 'organization',
    monthlyCap: 5,
    users: [],
  });
});

async function refetchSession(queryClient: ReturnType<typeof createQueryClient>, value: DebugItSession) {
  vi.mocked(api.fetchSession).mockResolvedValue(value);
  await act(async () => {
    await queryClient.refetchQueries();
  });
}

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('Security button', () => {
  test('an administrator sees it right after the settings button', async () => {
    renderApp();
    const security = await screen.findByRole('button', { name: 'Security' });
    const settings = screen.getByRole('button', { name: 'Debug it settings' });
    expect(settings.compareDocumentPosition(security) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test.each([
    ['a non administrator', session(false)],
    ['a signed out user', SIGNED_OUT],
  ])('%s sees it without the settings button', async (_name, value) => {
    vi.mocked(api.fetchSession).mockResolvedValue(value);
    renderApp();
    expect(await screen.findByRole('button', { name: 'Security' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Debug it settings' })).not.toBeInTheDocument();
  });

  test('is absent when Debug it is disabled', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(DISABLED);
    renderApp();
    await screen.findByRole('heading', { name: /github runner monitor/i });
    await waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('button', { name: /alerts/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Security' })).not.toBeInTheDocument();
  });

  test('is absent on the whole-dashboard sign in page', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue({ state: 'signed-out', loginScope: 'whole-dashboard' } as DebugItSession);
    renderApp();
    await waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
    await screen.findByRole('link', { name: /sign in/i });
    expect(screen.queryByRole('button', { name: 'Security' })).not.toBeInTheDocument();
  });
});

describe('Security page', () => {
  test('opens in place of the dashboard and goes back', async () => {
    const { user } = await openSecurity();
    expect(screen.queryByRole('button', { name: /^alerts/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Security' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Back to dashboard' }));
    expect(screen.queryByRole('heading', PAGE_HEADING)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^alerts/i })).toBeInTheDocument();
  });

  test('a non administrator can open it and stays on it', async () => {
    vi.mocked(api.fetchSession).mockResolvedValue(session(false));
    await openSecurity();
    await waitFor(() => expect(screen.getByRole('heading', PAGE_HEADING)).toBeInTheDocument());
  });

  test('shows every flow box, its containers and the steps', async () => {
    await openSecurity();
    const flow = screen.getByRole('region', { name: 'How a debug run flows' });
    const parts = within(flow).getByRole('list', { name: 'Parts' });
    for (const part of FLOW_PARTS) {
      expect(within(parts).getByText(part.name)).toBeInTheDocument();
    }
    for (const container of ['receiver', 'claude', 'key helper']) {
      expect(within(parts).getByText(container)).toBeInTheDocument();
    }
    expect(within(flow).getByRole('list', { name: 'Steps' })).toBeInTheDocument();
  });

  test('shows every control and terms sentence, in order', async () => {
    await openSecurity();
    const controls = screen.getByRole('list', { name: 'Main controls' });
    expect(within(controls).getAllByRole('listitem').map((item) => item.textContent)).toEqual([...SECURITY_CONTROLS]);
    const terms = screen.getByRole('list', { name: 'Anthropic terms' });
    expect(within(terms).getAllByRole('listitem').map((item) => item.textContent)).toEqual([...SECURITY_TERMS]);
  });

  test('links to the document and its Anthropic terms section', async () => {
    await openSecurity();
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toContain(SECURITY_DOC_URL);
    expect(hrefs).toContain(`${SECURITY_DOC_URL}#anthropic-terms`);
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  test('closes when Debug it turns off', async () => {
    const { queryClient } = await openSecurity();
    vi.mocked(api.fetchSession).mockResolvedValue(DISABLED);
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await waitFor(() => expect(screen.queryByRole('heading', PAGE_HEADING)).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: /^alerts/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Security' })).not.toBeInTheDocument();

    await refetchSession(queryClient, session(true));
    expect(await screen.findByRole('button', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^alerts/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', PAGE_HEADING)).not.toBeInTheDocument();
  });

  test('stays open when an administrator loses administrator rights', async () => {
    const { queryClient } = await openSecurity();
    await refetchSession(queryClient, session(false));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Debug it settings' })).not.toBeInTheDocument());
    expect(screen.getByRole('heading', PAGE_HEADING)).toBeInTheDocument();
  });

  test('the settings page still closes when administrator rights go and stays closed when they return', async () => {
    const user = userEvent.setup();
    const queryClient = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Debug it settings' }));
    await screen.findByRole('heading', { name: 'Debug it settings' });
    await refetchSession(queryClient, session(false));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Debug it settings' })).not.toBeInTheDocument());
    await refetchSession(queryClient, session(true));
    expect(await screen.findByRole('button', { name: 'Debug it settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^alerts/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Debug it settings' })).not.toBeInTheDocument();
  });
});

describe('Security page content', () => {
  test('the security design document says every sentence verbatim', () => {
    for (const sentence of [...SECURITY_CONTROLS, ...SECURITY_TERMS]) {
      expect(securityDoc).toContain(sentence);
    }
    expect(securityDoc).toMatch(/^## Main controls$/m);
    expect(securityDoc).toMatch(/^## Anthropic terms$/m);
  });

  test('the page source renders no HTML string, fetches nothing and loads no image', () => {
    expect(securityPageSource).not.toContain('dangerouslySetInnerHTML');
    expect(securityPageSource).not.toMatch(/\bfetch\b/);
    expect(securityPageSource).not.toContain('services/api');
    expect(securityPageSource).not.toContain('<img');
  });
});
