import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';
import HistorySection from './components/HistorySection';
import * as api from './services/api';
import { ApiError } from './services/apiError';
import type { DebugItRunsOverview, DebugItSession, DebugRunView, HistoryJob, JobResult } from './types/api';

vi.mock('./services/api', () => ({
  signInUrl: '/api/debug-it/sign-in',
  fetchDebugItRuns: vi.fn(),
  startDebugRun: vi.fn(),
  fetchDebugRun: vi.fn(),
  fetchDebugRunResult: vi.fn(),
  saveDebugRunFeedback: vi.fn(),
}));

type ShownSession = Extract<DebugItSession, { state: 'signed-out' | 'signed-in' }>;

// Invented values only; this is not a real token.
const ALLOWED: ShownSession = {
  state: 'signed-in',
  githubUserId: 1000001,
  login: 'dana',
  csrfToken: 'test-csrf-value',
  allowedUser: true,
  administrator: false,
  loginScope: 'debug-it-only',
  credentialsMode: 'organization',
};
const NOT_ALLOWED: ShownSession = { ...ALLOWED, allowedUser: false };
const SIGNED_OUT: ShownSession = { state: 'signed-out', loginScope: 'debug-it-only' };

const REPO = 'acme/payments-api';
const RUN_ID = '00000000-0000-4000-8000-000000000001';
const NOW = Date.now();

function row(id: number, result: JobResult, overrides: Partial<HistoryJob> = {}): HistoryJob {
  return {
    id,
    name: `job-${id}`,
    workflowName: 'CI',
    branch: 'main',
    actor: { login: 'priya-s', avatarUrl: 'https://avatars.example/priya' },
    event: 'push',
    repository: REPO,
    repositoryUrl: `https://github.com/${REPO}`,
    result,
    runnerName: 'arc-linux-x64-e01a7',
    scaleSet: 'arc-linux-x64',
    createdAt: new Date(NOW - 600_000).toISOString(),
    startedAt: new Date(NOW - 590_000).toISOString(),
    completedAt: new Date(NOW - 60_000 - id).toISOString(),
    durationMs: 60_000,
    htmlUrl: `https://github.com/${REPO}/actions/runs/1/job/${id}`,
    runUrl: `https://github.com/${REPO}/actions/runs/1`,
    target: { kind: 'job', id },
    ...overrides,
  };
}

function run(overrides: Partial<DebugRunView> = {}): DebugRunView {
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
    ...overrides,
  };
}

const overview = (runs: DebugRunView[] = [], allowedRepositories = ['Acme/Payments-API']): DebugItRunsOverview => ({
  allowedRepositories,
  runs,
});

function renderHistory(session: ShownSession | null, items: HistoryJob[] = [row(1, 'failure')]) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HistorySection
        filterKey="all"
        items={items}
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
}

const rowOf = (name: string) => screen.getByRole('link', { name: new RegExp(`^Job ${name} in`) }).closest('tr') as HTMLElement;
async function stateIs(dialog: HTMLElement, word: string) {
  await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent(new RegExp(`^${word}$`)));
}
const debugHeader = () => screen.queryByRole('columnheader', { name: 'Debug it' });
const lastCell = (tr: HTMLElement) => {
  const cells = within(tr).getAllByRole('cell');
  return cells[cells.length - 1]!;
};

beforeEach(() => {
  vi.mocked(api.fetchDebugItRuns).mockReset().mockResolvedValue(overview());
  vi.mocked(api.startDebugRun).mockReset().mockResolvedValue(run());
  vi.mocked(api.fetchDebugRun).mockReset().mockResolvedValue(run());
  vi.mocked(api.fetchDebugRunResult)
    .mockReset()
    .mockImplementation(async (runId) => ({
      run: run({ runId }),
      result: null,
      downloads: [],
      skippedRepositories: [],
      feedback: null,
      canGiveFeedback: false,
    }));
});

describe('Debug it cell', () => {
  test('allowed user, failed row, allowed repository (any case): Debug it', async () => {
    renderHistory(ALLOWED);
    expect(debugHeader()).toBeInTheDocument();
    const button = await within(rowOf('job-1')).findByRole('button', { name: 'Debug it: job-1 in acme/payments-api' });
    expect(button).toHaveTextContent(/^Debug it$/);
  });

  test.each(['finished', 'failed'] as const)('a listed %s run: View debug run and Debug it again', async (state) => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDebugItRuns).mockResolvedValue(overview([run({ state })]));
    vi.mocked(api.startDebugRun).mockResolvedValue(run({ runId: '00000000-0000-4000-8000-000000000002' }));
    renderHistory(ALLOWED);
    const tr = rowOf('job-1');
    const view = await within(tr).findByRole('button', { name: 'View debug run: job-1 in acme/payments-api' });
    expect(view).toHaveTextContent(/^View debug run$/);
    await user.click(within(tr).getByRole('button', { name: 'Debug it: job-1 in acme/payments-api' }));
    await waitFor(() => expect(vi.mocked(api.startDebugRun).mock.calls[0]?.[0]).toEqual({ kind: 'job', id: 1 }));
  });

  test('repository not on the allowed list: nothing in the cell', async () => {
    vi.mocked(api.fetchDebugItRuns).mockResolvedValue(overview([], ['acme/other']));
    renderHistory(ALLOWED);
    await waitFor(() => expect(api.fetchDebugItRuns).toHaveBeenCalled());
    await act(async () => {});
    expect(lastCell(rowOf('job-1'))).toBeEmptyDOMElement();
  });

  test('succeeded, cancelled, timed out and other rows: nothing in the cell', async () => {
    const items = [row(2, 'success'), row(3, 'cancelled'), row(4, 'timed_out'), row(5, 'other'), row(1, 'failure')];
    renderHistory(ALLOWED, items);
    await within(rowOf('job-1')).findByRole('button', { name: /^Debug it: / });
    for (const name of ['job-2', 'job-3', 'job-4', 'job-5']) {
      expect(lastCell(rowOf(name))).toBeEmptyDOMElement();
    }
  });

  test('a failed run without jobs: Debug it starts with kind run', async () => {
    const user = userEvent.setup();
    const runRow: HistoryJob = row(7, 'failure', { name: 'Deploy', target: { kind: 'run', id: 810001 } });
    vi.mocked(api.startDebugRun).mockResolvedValue(run({ target: { kind: 'run', id: 810001 }, jobName: 'Deploy' }));
    renderHistory(ALLOWED, [runRow]);
    const tr = screen.getByRole('link', { name: /^Workflow run Deploy in/ }).closest('tr') as HTMLElement;
    await user.click(await within(tr).findByRole('button', { name: /^Debug it: / }));
    await waitFor(() => expect(vi.mocked(api.startDebugRun).mock.calls[0]?.[0]).toEqual({ kind: 'run', id: 810001 }));
  });

  test('signed out: a Sign in to debug link on failed rows only, no listing request', () => {
    renderHistory(SIGNED_OUT, [row(1, 'failure'), row(2, 'success')]);
    expect(debugHeader()).toBeInTheDocument();
    const link = within(rowOf('job-1')).getByRole('link', { name: 'Sign in to debug: job-1 in acme/payments-api' });
    expect(link).toHaveAttribute('href', '/api/debug-it/sign-in');
    expect(lastCell(rowOf('job-2'))).toBeEmptyDOMElement();
    expect(api.fetchDebugItRuns).not.toHaveBeenCalled();
  });

  test('signed in but not allowed: no column, no listing request', async () => {
    renderHistory(NOT_ALLOWED);
    await act(async () => {});
    expect(debugHeader()).not.toBeInTheDocument();
    expect(within(rowOf('job-1')).queryByRole('button')).not.toBeInTheDocument();
    expect(api.fetchDebugItRuns).not.toHaveBeenCalled();
  });

  test('Debug it off or the session loading: the table as before, no request', async () => {
    renderHistory(null);
    await act(async () => {});
    expect(debugHeader()).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(8);
    expect(within(rowOf('job-1')).getAllByRole('cell')).toHaveLength(8);
    expect(api.fetchDebugItRuns).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Debug run dialog', () => {
  test('start accepted (201): the dialog shows the run', async () => {
    const user = userEvent.setup();
    renderHistory(ALLOWED);
    await user.click(await within(rowOf('job-1')).findByRole('button', { name: /^Debug it: / }));
    const dialog = await screen.findByRole('dialog', { name: 'Debug run' });
    await stateIs(dialog, 'Waiting');
    expect(within(dialog).getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(vi.mocked(api.startDebugRun).mock.calls[0]?.[0]).toEqual({ kind: 'job', id: 1 });
    expect(api.fetchDebugRun).toHaveBeenCalledWith(RUN_ID);
    // The listing is read again so the row offers the run.
    await waitFor(() => expect(api.fetchDebugItRuns).toHaveBeenCalledTimes(2));
  });

  test('start answered with an existing run (200): the dialog shows that run', async () => {
    const user = userEvent.setup();
    const existing = run({ runId: '00000000-0000-4000-8000-000000000042', state: 'analyzing' });
    vi.mocked(api.startDebugRun).mockResolvedValue({ ...existing, existing: true });
    vi.mocked(api.fetchDebugRun).mockResolvedValue(existing);
    renderHistory(ALLOWED);
    await user.click(await within(rowOf('job-1')).findByRole('button', { name: /^Debug it: / }));
    const dialog = await screen.findByRole('dialog', { name: 'Debug run' });
    await stateIs(dialog, 'Analyzing');
    expect(api.fetchDebugRun).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000042');
  });

  test('start refused: the backend sentence, no polling', async () => {
    const user = userEvent.setup();
    const sentence = 'You have used all 20 debug runs for this month; your runs reset on 2026-12-01 (UTC).';
    vi.mocked(api.startDebugRun).mockRejectedValue(new ApiError(sentence, { source: 'backend', status: 429 }));
    renderHistory(ALLOWED);
    await user.click(await within(rowOf('job-1')).findByRole('button', { name: /^Debug it: / }));
    const dialog = await screen.findByRole('dialog', { name: 'Debug run' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(api.fetchDebugRun).not.toHaveBeenCalled();
  });

  test('return later: View debug run opens the listed run with no POST', async () => {
    const user = userEvent.setup();
    const listed = run({ state: 'cloning' });
    vi.mocked(api.fetchDebugItRuns).mockResolvedValue(overview([listed]));
    vi.mocked(api.fetchDebugRun).mockResolvedValue(listed);
    renderHistory(ALLOWED);
    const tr = rowOf('job-1');
    await user.click(await within(tr).findByRole('button', { name: /^View debug run: / }));
    expect(within(tr).queryByRole('button', { name: /^Debug it: / })).not.toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Debug run' });
    await stateIs(dialog, 'Cloning');
    expect(api.startDebugRun).not.toHaveBeenCalled();
    expect(api.fetchDebugRun).toHaveBeenCalledWith(RUN_ID);
  });

  test('polls every 5 seconds while active and stops once finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.mocked(api.fetchDebugItRuns).mockResolvedValue(overview([run({ state: 'analyzing' })]));
      vi.mocked(api.fetchDebugRun).mockResolvedValue(run({ state: 'analyzing', elapsedMs: 65_000 }));
      renderHistory(ALLOWED);
      await user.click(await within(rowOf('job-1')).findByRole('button', { name: /^View debug run: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Debug run' });
      await stateIs(dialog, 'Analyzing');
      expect(within(dialog).getByText(/^Elapsed 1m \d+s$/)).toBeInTheDocument();
      expect(api.fetchDebugRun).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(api.fetchDebugRun).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      await waitFor(() => expect(api.fetchDebugRun).toHaveBeenCalledTimes(2));

      vi.mocked(api.fetchDebugRun).mockResolvedValue(
        run({ state: 'finished', elapsedMs: 450_000, updatedAt: new Date(NOW + 450_000).toISOString() }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await waitFor(() => expect(api.fetchDebugRun).toHaveBeenCalledTimes(3));
      await stateIs(dialog, 'Finished');
      expect(within(dialog).getByText('The debug run finished.')).toBeInTheDocument();
      expect(within(dialog).getByText('Elapsed 7m 30s')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(api.fetchDebugRun).toHaveBeenCalledTimes(3);
      expect(within(dialog).getByText('Elapsed 7m 30s')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed run shows its failure reason and is not polled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const failed = run({ state: 'failed', failureReason: 'The Debug Job of this run no longer exists.' });
      vi.mocked(api.fetchDebugItRuns).mockResolvedValue(overview([failed]));
      vi.mocked(api.fetchDebugRun).mockResolvedValue(failed);
      renderHistory(ALLOWED);
      await user.click(await within(rowOf('job-1')).findByRole('button', { name: /^View debug run: / }));
      const dialog = await screen.findByRole('dialog', { name: 'Debug run' });
      expect(await within(dialog).findByText('The Debug Job of this run no longer exists.')).toBeInTheDocument();
      expect(within(dialog).getAllByText('Failed').length).toBeGreaterThan(0);
      // Where it failed is not known: no step is marked completed.
      expect(dialog.querySelector('.Mui-completed')).toBeNull();
      expect(dialog.querySelector('.Mui-error')).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(api.fetchDebugRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('backend strings render as text, never markup', async () => {
    const user = userEvent.setup();
    const listed = run({ jobName: '<img src=x onerror=alert(1)>', state: 'failed', failureReason: '<b>bold</b>' });
    vi.mocked(api.fetchDebugItRuns).mockResolvedValue(overview([listed]));
    vi.mocked(api.fetchDebugRun).mockResolvedValue(listed);
    renderHistory(ALLOWED);
    await user.click(await within(rowOf('job-1')).findByRole('button', { name: /^View debug run: / }));
    const dialog = await screen.findByRole('dialog', { name: 'Debug run' });
    expect(await within(dialog).findByText('<b>bold</b>')).toBeInTheDocument();
    expect(within(dialog).getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(dialog.querySelector('img, b')).toBeNull();
  });

  test('focus stays in the dialog, Escape closes it and the row reopens the same run', async () => {
    const user = userEvent.setup();
    const listed = run({ state: 'waiting' });
    vi.mocked(api.fetchDebugItRuns).mockResolvedValue(overview([listed]));
    vi.mocked(api.fetchDebugRun).mockResolvedValue(listed);
    renderHistory(ALLOWED);
    const open = await within(rowOf('job-1')).findByRole('button', { name: /^View debug run: / });
    await user.click(open);
    let dialog = await screen.findByRole('dialog', { name: 'Debug run' });
    await stateIs(dialog, 'Waiting');
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(rowOf('job-1')).getByRole('button', { name: /^View debug run: / }));
    dialog = await screen.findByRole('dialog', { name: 'Debug run' });
    await stateIs(dialog, 'Waiting');
    expect(vi.mocked(api.fetchDebugRun).mock.calls.every(([id]) => id === RUN_ID)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.startDebugRun).not.toHaveBeenCalled();
  });
});
