import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';
import App from './App';
import HistorySection from './components/HistorySection';
import * as api from './services/api';
import { ApiError } from './services/apiError';
import type { DebugItSession, DebugRunView, HistoryJob, PersonalKeyStatus } from './types/api';

vi.mock('./services/api', () => ({
  fetchScaleSets: vi.fn(async () => []),
  fetchQueue: vi.fn(async () => ({ orderingIsEstimate: true, note: '', incomplete: false, items: [] })),
  fetchRunningJobs: vi.fn(async () => ({ orderingIsEstimate: true, note: '', incomplete: false, items: [] })),
  fetchJobHistory: vi.fn(async () => []),
  fetchRunners: vi.fn(async () => []),
  fetchSettings: vi.fn(async () => ({ runnersRefreshSeconds: 30 })),
  fetchAlerts: vi.fn(async () => ({ evaluatedAt: null, alerts: [] })),
  fetchAlertSettings: vi.fn(),
  updateAlertSettings: vi.fn(),
  resetAlertSettings: vi.fn(),
  sendTestAlert: vi.fn(),
  fetchSession: vi.fn(),
  signOut: vi.fn(),
  signInUrl: '/api/debug-it/sign-in',
  fetchDebugItRuns: vi.fn(),
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
  fetchPersonalKey: vi.fn(),
  savePersonalKey: vi.fn(),
  deletePersonalKey: vi.fn(),
}));

type ShownSession = Extract<DebugItSession, { state: 'signed-out' | 'signed-in' }>;

// Invented values only; neither is a real token or key.
const PERSONAL: ShownSession = {
  state: 'signed-in',
  githubUserId: 1000001,
  login: 'dana',
  csrfToken: 'test-csrf-value',
  allowedUser: true,
  administrator: false,
  loginScope: 'debug-it-only',
  credentialsMode: 'personal',
};
const ORGANIZATION: ShownSession = { ...PERSONAL, credentialsMode: 'organization' };
const NOT_ALLOWED: ShownSession = { ...PERSONAL, allowedUser: false };
const KEY = 'sk-ant-api03-INVENTED-TEST-KEY-0000WXYZ';
const NEW_KEY = 'sk-ant-api03-INVENTED-TEST-KEY-1111QRST';

const REPO = 'acme/payments-api';
const RUN_ID = '00000000-0000-4000-8000-000000000001';
const NOW = Date.now();
const KEY_FIRST = 'Save your personal Anthropic API key to start this debug run.';

const status = (saved: boolean, last4: string | null = null): PersonalKeyStatus => ({
  credentialsMode: 'personal',
  saved,
  last4: saved ? last4 : null,
});

function failedRow(): HistoryJob {
  return {
    id: 1,
    name: 'job-1',
    workflowName: 'CI',
    branch: 'main',
    actor: { login: 'priya-s', avatarUrl: 'https://avatars.example/priya' },
    event: 'push',
    repository: REPO,
    repositoryUrl: `https://github.com/${REPO}`,
    result: 'failure',
    runnerName: 'arc-linux-x64-e01a7',
    scaleSet: 'arc-linux-x64',
    createdAt: new Date(NOW - 600_000).toISOString(),
    startedAt: new Date(NOW - 590_000).toISOString(),
    completedAt: new Date(NOW - 60_000).toISOString(),
    durationMs: 60_000,
    htmlUrl: `https://github.com/${REPO}/actions/runs/1/job/1`,
    runUrl: `https://github.com/${REPO}/actions/runs/1`,
    target: { kind: 'job', id: 1 },
  };
}

function run(): DebugRunView {
  return {
    runId: RUN_ID,
    target: { kind: 'job', id: 1 },
    state: 'waiting',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    elapsedMs: 0,
    repository: REPO,
    jobName: 'job-1',
    failureReason: null,
  };
}

function client() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  return queryClient;
}

function renderApp(session: DebugItSession) {
  vi.mocked(api.fetchSession).mockResolvedValue(session);
  const queryClient = client();
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
  return queryClient;
}

function renderHistory(session: ShownSession) {
  const queryClient = client();
  render(
    <QueryClientProvider client={queryClient}>
      <HistorySection
        filterKey="all"
        items={[failedRow()]}
        isLoading={false}
        isFetching={false}
        error={null}
        onRetry={() => {}}
        now={NOW}
        updatedAt={NOW}
        refreshSeconds={15}
        showScaleSetColumn
        debugItSession={session}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

const keyDialog = () => screen.findByRole('dialog', { name: 'Personal Anthropic API key' });
const keyInput = (dialog: HTMLElement) => within(dialog).getByLabelText('Anthropic API key') as HTMLInputElement;

async function openHeaderDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Personal key' }));
  return keyDialog();
}

let setItemSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(api.fetchPersonalKey).mockReset().mockResolvedValue(status(false));
  vi.mocked(api.savePersonalKey).mockReset().mockResolvedValue(status(true, 'WXYZ'));
  vi.mocked(api.deletePersonalKey).mockReset().mockResolvedValue({ ...status(false), cancelledRuns: 0 });
  vi.mocked(api.fetchDebugItRuns).mockReset().mockResolvedValue({ allowedRepositories: [REPO], runs: [] });
  vi.mocked(api.startDebugRun).mockReset().mockResolvedValue(run());
  vi.mocked(api.fetchDebugRun).mockReset().mockResolvedValue(run());
  vi.mocked(api.fetchDebugRunResult).mockReset();
  vi.mocked(api.fetchJobHistory).mockResolvedValue([]);
  setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
});

afterEach(() => {
  setItemSpy.mockRestore();
});

const noStorageWrites = () => expect(setItemSpy).not.toHaveBeenCalled();

describe('Personal key header button', () => {
  test('allowed user in personal key mode: the button shows', async () => {
    renderApp(PERSONAL);
    expect(await screen.findByRole('button', { name: 'Personal key' })).toBeInTheDocument();
  });

  test.each([
    ['organization key mode', ORGANIZATION],
    ['a user who is not allowed', NOT_ALLOWED],
    ['a signed out visitor', { state: 'signed-out', loginScope: 'debug-it-only' } as DebugItSession],
    ['Debug it off', { state: 'disabled' } as DebugItSession],
  ])('%s: no button and no personal key request', async (_name, session) => {
    renderApp(session);
    await waitFor(() => expect(api.fetchSession).toHaveBeenCalled());
    await screen.findByRole('heading', { name: /github runner monitor/i });
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Personal key' })).not.toBeInTheDocument();
    expect(api.fetchPersonalKey).not.toHaveBeenCalled();
  });
});

describe('Personal key dialog', () => {
  test('a saved key shows only its last 4 characters, with Replace and Delete and no input', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPersonalKey).mockResolvedValue(status(true, 'WXYZ'));
    renderApp(PERSONAL);
    const dialog = await openHeaderDialog(user);
    expect(await within(dialog).findByText('Key ending in WXYZ')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Anthropic API key')).not.toBeInTheDocument();
  });

  test('no saved key: a password input; Enter saves { key }, then the key works and only last 4 show', async () => {
    const user = userEvent.setup();
    const queryClient = renderApp(PERSONAL);
    const dialog = await openHeaderDialog(user);
    expect(await within(dialog).findByText('No personal key saved.')).toBeInTheDocument();
    const input = keyInput(dialog);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');

    await user.type(input, `${KEY}{Enter}`);
    await waitFor(() => expect(api.savePersonalKey).toHaveBeenCalledWith(KEY));
    expect(await within(dialog).findByText('Your personal key works.')).toBeInTheDocument();
    expect(within(dialog).getByText('Key ending in WXYZ')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Anthropic API key')).not.toBeInTheDocument();

    expect(document.body.innerHTML).not.toContain(KEY);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(KEY);
    expect(JSON.stringify(queryClient.getMutationCache().getAll().map((m) => m.state.variables))).not.toContain(KEY);
    noStorageWrites();
  });

  test('a refused key shows the backend sentence, keeps the input focused and caches nothing', async () => {
    const user = userEvent.setup();
    vi.mocked(api.savePersonalKey).mockRejectedValue(
      new ApiError('Anthropic did not accept this API key.', { source: 'backend', status: 400 }),
    );
    const queryClient = renderApp(PERSONAL);
    const dialog = await openHeaderDialog(user);
    await within(dialog).findByText('No personal key saved.');
    await user.type(keyInput(dialog), KEY);
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }));
    expect(await within(dialog).findByText('Anthropic did not accept this API key.')).toBeInTheDocument();
    await waitFor(() => expect(keyInput(dialog)).toHaveFocus());
    expect(queryClient.getQueryData(['debug-it-personal-key'])).toEqual(status(false));
    expect(JSON.stringify(queryClient.getMutationCache().getAll().map((m) => m.state.variables))).not.toContain(KEY);
    noStorageWrites();
  });

  test('Replace shows the input; Cancel returns to the saved view; a new save shows the new last 4', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPersonalKey).mockResolvedValue(status(true, 'WXYZ'));
    vi.mocked(api.savePersonalKey).mockResolvedValue(status(true, 'QRST'));
    renderApp(PERSONAL);
    const dialog = await openHeaderDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Replace' }));
    await user.type(keyInput(dialog), NEW_KEY);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByText('Key ending in WXYZ')).toBeInTheDocument();
    expect(api.savePersonalKey).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Replace' }));
    // Cancel cleared what was typed.
    expect(keyInput(dialog).value).toBe('');
    await user.type(keyInput(dialog), `${NEW_KEY}{Enter}`);
    expect(await within(dialog).findByText('Key ending in QRST')).toBeInTheDocument();
    expect(api.savePersonalKey).toHaveBeenCalledWith(NEW_KEY);
    noStorageWrites();
  });

  test.each([
    [0, null],
    [1, '1 waiting debug run was cancelled.'],
    [2, '2 waiting debug runs were cancelled.'],
  ])('Delete with %s cancelled runs removes the key and says so', async (cancelledRuns, sentence) => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPersonalKey).mockResolvedValue(status(true, 'WXYZ'));
    vi.mocked(api.deletePersonalKey).mockResolvedValue({ ...status(false), cancelledRuns });
    renderApp(PERSONAL);
    const dialog = await openHeaderDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByText('No personal key saved.')).toBeInTheDocument();
    if (sentence) expect(within(dialog).getByText(sentence)).toBeInTheDocument();
    else expect(within(dialog).queryByText(/waiting debug runs? (was|were) cancelled/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Key ending in/)).not.toBeInTheDocument();
  });

  test('a successful delete reads the runs overview again', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPersonalKey).mockResolvedValue(status(true, 'WXYZ'));
    vi.mocked(api.deletePersonalKey).mockResolvedValue({ ...status(false), cancelledRuns: 1 });
    vi.mocked(api.fetchJobHistory).mockResolvedValue([failedRow()]);
    renderApp(PERSONAL);
    // The Recent history table's Debug it column reads the runs overview.
    await screen.findByRole('button', { name: 'Debug it: job-1 in acme/payments-api' });
    await waitFor(() => expect(api.fetchDebugItRuns).toHaveBeenCalled());
    const before = vi.mocked(api.fetchDebugItRuns).mock.calls.length;
    const dialog = await openHeaderDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Delete' }));
    await within(dialog).findByText('No personal key saved.');
    await waitFor(() => expect(vi.mocked(api.fetchDebugItRuns).mock.calls.length).toBeGreaterThan(before));
  });

  test('a failed delete shows the backend sentence and keeps the saved view', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPersonalKey).mockResolvedValue(status(true, 'WXYZ'));
    vi.mocked(api.deletePersonalKey).mockRejectedValue(
      new ApiError('S3 cannot be reached, so your personal key cannot be deleted right now.', {
        source: 'backend',
        status: 503,
      }),
    );
    renderApp(PERSONAL);
    const dialog = await openHeaderDialog(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Delete' }));
    expect(
      await within(dialog).findByText('S3 cannot be reached, so your personal key cannot be deleted right now.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Key ending in WXYZ')).toBeInTheDocument();
  });

  test('closing the dialog clears what was typed', async () => {
    const user = userEvent.setup();
    renderApp(PERSONAL);
    let dialog = await openHeaderDialog(user);
    await within(dialog).findByText('No personal key saved.');
    await user.type(keyInput(dialog), KEY);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    dialog = await openHeaderDialog(user);
    await within(dialog).findByText('No personal key saved.');
    expect(keyInput(dialog).value).toBe('');
    expect(api.savePersonalKey).not.toHaveBeenCalled();
    noStorageWrites();
  });
});

describe('Debug it in personal key mode', () => {
  const debugIt = () => screen.findByRole('button', { name: 'Debug it: job-1 in acme/payments-api' });

  test('no saved key: the key is asked for first and no start is sent', async () => {
    const user = userEvent.setup();
    renderHistory(PERSONAL);
    await waitFor(() => expect(api.fetchPersonalKey).toHaveBeenCalled());
    await act(async () => {});
    await user.click(await debugIt());
    const dialog = await keyDialog();
    expect(within(dialog).getByText(KEY_FIRST)).toBeInTheDocument();
    expect(keyInput(dialog)).toHaveAttribute('type', 'password');
    expect(api.startDebugRun).not.toHaveBeenCalled();
  });

  test('saving the key in that dialog starts the run and confirms the key works', async () => {
    const user = userEvent.setup();
    renderHistory(PERSONAL);
    await waitFor(() => expect(api.fetchPersonalKey).toHaveBeenCalled());
    await act(async () => {});
    await user.click(await debugIt());
    const dialog = await keyDialog();
    await user.type(keyInput(dialog), `${KEY}{Enter}`);
    await waitFor(() => expect(api.startDebugRun).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.startDebugRun).mock.calls[0]?.[0]).toEqual({ kind: 'job', id: 1 });
    const runDialog = await screen.findByRole('dialog', { name: 'Debug run' });
    expect(within(runDialog).getByText('Your personal key works.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Personal Anthropic API key' })).not.toBeInTheDocument());
    noStorageWrites();
  });

  test('while the save is pending the dialog cannot close; the run then starts', async () => {
    const user = userEvent.setup();
    let answer: (value: PersonalKeyStatus) => void = () => {};
    vi.mocked(api.savePersonalKey).mockImplementation(
      () => new Promise<PersonalKeyStatus>((resolve) => (answer = resolve)),
    );
    renderHistory(PERSONAL);
    await waitFor(() => expect(api.fetchPersonalKey).toHaveBeenCalled());
    await act(async () => {});
    await user.click(await debugIt());
    const dialog = await keyDialog();
    await user.type(keyInput(dialog), `${KEY}{Enter}`);
    await waitFor(() => expect(api.savePersonalKey).toHaveBeenCalledWith(KEY));
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Personal Anthropic API key' })).toBeInTheDocument();
    expect(api.startDebugRun).not.toHaveBeenCalled();
    await act(async () => answer(status(true, 'WXYZ')));
    await waitFor(() => expect(api.startDebugRun).toHaveBeenCalledTimes(1));
    const runDialog = await screen.findByRole('dialog', { name: 'Debug run' });
    expect(within(runDialog).getByText('Your personal key works.')).toBeInTheDocument();
  });

  test('a start refused after saving the key keeps the notice that the key works', async () => {
    const user = userEvent.setup();
    vi.mocked(api.startDebugRun).mockRejectedValue(
      new ApiError('This job is already being debugged.', { source: 'backend', status: 409 }),
    );
    renderHistory(PERSONAL);
    await waitFor(() => expect(api.fetchPersonalKey).toHaveBeenCalled());
    await act(async () => {});
    await user.click(await debugIt());
    const dialog = await keyDialog();
    expect(dialog).toHaveAccessibleDescription(KEY_FIRST);
    await user.type(keyInput(dialog), `${KEY}{Enter}`);
    const runDialog = await screen.findByRole('dialog', { name: 'Debug run' });
    expect(await within(runDialog).findByText('This job is already being debugged.')).toBeInTheDocument();
    expect(within(runDialog).getByText('Your personal key works.')).toBeInTheDocument();
  });

  test('cancelling the key dialog sends no start', async () => {
    const user = userEvent.setup();
    renderHistory(PERSONAL);
    await waitFor(() => expect(api.fetchPersonalKey).toHaveBeenCalled());
    await act(async () => {});
    await user.click(await debugIt());
    const dialog = await keyDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.startDebugRun).not.toHaveBeenCalled();
  });

  test('a saved key: Debug it starts at once, no key dialog', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPersonalKey).mockResolvedValue(status(true, 'WXYZ'));
    renderHistory(PERSONAL);
    await waitFor(() => expect(api.fetchPersonalKey).toHaveBeenCalled());
    await act(async () => {});
    await user.click(await debugIt());
    await waitFor(() => expect(api.startDebugRun).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'Personal Anthropic API key' })).not.toBeInTheDocument();
  });

  test('key status unreadable: the start is sent and a backend refusal shows in the run dialog', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchPersonalKey).mockRejectedValue(
      new ApiError('S3 cannot be reached, so your personal key cannot be read right now.', { source: 'backend', status: 503 }),
    );
    vi.mocked(api.startDebugRun).mockRejectedValue(
      new ApiError('You have not saved a personal Anthropic API key.', { source: 'backend', status: 409 }),
    );
    renderHistory(PERSONAL);
    await waitFor(() => expect(api.fetchPersonalKey).toHaveBeenCalled());
    await act(async () => {});
    await user.click(await debugIt());
    const runDialog = await screen.findByRole('dialog', { name: 'Debug run' });
    expect(await within(runDialog).findByText('You have not saved a personal Anthropic API key.')).toBeInTheDocument();
    expect(api.startDebugRun).toHaveBeenCalledTimes(1);
  });

  test('organization key mode: no personal key request and Debug it starts as before', async () => {
    const user = userEvent.setup();
    renderHistory(ORGANIZATION);
    await user.click(await debugIt());
    await waitFor(() => expect(api.startDebugRun).toHaveBeenCalledTimes(1));
    expect(api.fetchPersonalKey).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Personal Anthropic API key' })).not.toBeInTheDocument();
  });
});
