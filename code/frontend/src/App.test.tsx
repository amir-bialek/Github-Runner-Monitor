import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient, REFRESH_INTERVAL_MS } from './queryClient';
import App from './App';
import * as api from './services/api';
import { toApiError } from './services/apiError';
import { HistoryJob, QueueItem, QueueResponse, RunningResponse, ScaleSet } from './types/api';

vi.mock('./services/api', () => ({
  fetchScaleSets: vi.fn(),
  fetchQueue: vi.fn(),
  fetchRunningJobs: vi.fn(),
  fetchJobHistory: vi.fn(),
  fetchRunners: vi.fn(),
  fetchSettings: vi.fn(),
}));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

const mockScaleSets: ScaleSet[] = [
  { id: 'arc-gpu-a10', name: 'arc-gpu-a10', totalRunners: 4, online: 3, busy: 3, free: 0 },
  { id: 'arc-linux-x64', name: 'arc-linux-x64', totalRunners: 6, online: 5, busy: 2, free: 3 },
];

const queueItems: QueueItem[] = [
  {
    id: 900022,
    name: 'lint',
    workflowName: 'CI',
    branch: 'release/1.4',
    actor: { login: 'priya-s', avatarUrl: 'https://avatars.example/priya' },
    event: 'push',
    repository: 'acme/web-app',
    repositoryUrl: 'https://github.com/acme/web-app',
    scaleSet: 'arc-gpu-a10',
    position: 1,
    createdAt: minutesAgo(26),
    waitMs: 26 * 60 * 1000,
    htmlUrl: 'https://github.com/acme/web-app/actions/runs/700022/job/900022',
    runUrl: 'https://github.com/acme/web-app/actions/runs/700022',
  },
  {
    id: 900021,
    name: 'lint',
    workflowName: 'CI',
    branch: 'feature/telemetry-export',
    actor: { login: 'amira-k', avatarUrl: 'https://avatars.example/amira' },
    event: 'pull_request',
    repository: 'acme/web-app',
    repositoryUrl: 'https://github.com/acme/web-app',
    scaleSet: 'arc-gpu-a10',
    position: 2,
    createdAt: minutesAgo(4),
    waitMs: 4 * 60 * 1000,
    htmlUrl: 'https://github.com/acme/web-app/actions/runs/700021/job/900021',
    runUrl: 'https://github.com/acme/web-app/actions/runs/700021',
  },
  {
    id: 900030,
    name: 'package',
    workflowName: 'Release',
    branch: 'main',
    actor: { login: 'devlin-park', avatarUrl: 'https://avatars.example/devlin' },
    event: 'workflow_dispatch',
    repository: 'acme/infra-tools',
    repositoryUrl: 'https://github.com/acme/infra-tools',
    scaleSet: null,
    position: 1,
    createdAt: minutesAgo(2),
    waitMs: 2 * 60 * 1000,
    htmlUrl: 'https://github.com/acme/infra-tools/actions/runs/700030/job/900030',
    runUrl: 'https://github.com/acme/infra-tools/actions/runs/700030',
  },
];

const mockQueue: QueueResponse = {
  orderingIsEstimate: true,
  note: 'Estimated order — oldest waiting job first. GitHub does not publish a real queue position.',
  incomplete: false,
  items: queueItems,
};

const emptyQueue: QueueResponse = {
  orderingIsEstimate: true,
  note: 'nothing to say',
  incomplete: false,
  items: [],
};

const mockRunning: RunningResponse = {
  orderingIsEstimate: true,
  note: 'Ordered by start time as a proxy for which frees its runner soonest.',
  incomplete: false,
  items: [
    {
      id: 900002,
      name: 'short-job',
      workflowName: 'CI',
      branch: 'main',
      actor: { login: 'amira-k', avatarUrl: 'https://avatars.example/amira' },
      event: 'push',
      repository: 'acme/platform',
      repositoryUrl: 'https://github.com/acme/platform',
      runnerName: 'arc-gpu-a10-16cc2',
      scaleSet: 'arc-gpu-a10',
      startedAt: minutesAgo(8),
      runningMs: 8 * 60 * 1000,
      htmlUrl: 'https://github.com/acme/platform/actions/runs/700002/job/900002',
      runUrl: 'https://github.com/acme/platform/actions/runs/700002',
    },
    {
      id: 900001,
      name: 'long-job',
      workflowName: 'CI',
      branch: 'main',
      actor: { login: 'priya-s', avatarUrl: 'https://avatars.example/priya' },
      event: 'push',
      repository: 'acme/platform',
      repositoryUrl: 'https://github.com/acme/platform',
      runnerName: 'arc-gpu-a10-9f2c1',
      scaleSet: 'arc-gpu-a10',
      startedAt: minutesAgo(22),
      runningMs: 22 * 60 * 1000,
      htmlUrl: 'https://github.com/acme/platform/actions/runs/700001/job/900001',
      runUrl: 'https://github.com/acme/platform/actions/runs/700001',
    },
  ],
};

const emptyRunning: RunningResponse = {
  orderingIsEstimate: true,
  note: '',
  incomplete: false,
  items: [],
};

const historyJobs = (count: number): HistoryJob[] => Array.from({ length: count }, (_, index) => ({
  id: 800000 + index,
  name: `finished-${index}`,
  workflowName: 'CI',
  branch: 'main',
  actor: { login: 'priya-s', avatarUrl: 'https://avatars.example/priya' },
  event: 'push',
  repository: 'acme/infra-tools',
  repositoryUrl: 'https://github.com/acme/infra-tools',
  result: 'success' as const,
  runnerName: 'arc-linux-x64-e01a7',
  scaleSet: 'arc-linux-x64',
  createdAt: minutesAgo(60 + index),
  startedAt: minutesAgo(59 + index),
  completedAt: minutesAgo(50 + index),
  durationMs: 6 * 60 * 1000,
  htmlUrl: `https://github.com/acme/infra-tools/actions/runs/70${index}/job/80${index}`,
  runUrl: `https://github.com/acme/infra-tools/actions/runs/70${index}`,
}));

const mockHistory: HistoryJob[] = historyJobs(8);

function renderApp() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function failEverythingWith(error: unknown) {
  vi.mocked(api.fetchScaleSets).mockRejectedValue(error);
  vi.mocked(api.fetchQueue).mockRejectedValue(error);
  vi.mocked(api.fetchRunningJobs).mockRejectedValue(error);
  vi.mocked(api.fetchJobHistory).mockRejectedValue(error);
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  fireEvent(window, new Event('visibilitychange'));
  fireEvent(document, new Event('visibilitychange'));
}

function rowsOf(tableName: RegExp | string): string[] {
  const table = screen.getByRole('table', { name: tableName });
  return within(table)
    .getAllByRole('row')
    .map((row) => row.textContent ?? '');
}

describe('App dashboard', () => {
  beforeEach(() => {
    vi.mocked(api.fetchScaleSets).mockResolvedValue(mockScaleSets);
    vi.mocked(api.fetchQueue).mockResolvedValue(mockQueue);
    vi.mocked(api.fetchRunningJobs).mockResolvedValue(mockRunning);
    vi.mocked(api.fetchJobHistory).mockResolvedValue(mockHistory);
    vi.mocked(api.fetchSettings).mockResolvedValue({ runnersRefreshSeconds: 30 });
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  test('renders the dashboard title', () => {
    renderApp();
    expect(screen.getByRole('heading', { name: /github runner monitor/i })).toBeInTheDocument();
  });

  test('shows queued jobs longest-waiting first and always shows the estimate note', async () => {
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    const rows = rowsOf(/job queue/i);
    const waitedLongest = rows.findIndex((row) => row.includes('release/1.4'));
    const waitedLess = rows.findIndex((row) => row.includes('feature/telemetry-export'));
    expect(waitedLongest).toBeGreaterThan(-1);
    expect(waitedLess).toBeGreaterThan(waitedLongest);

    expect(screen.getByText(/does not publish a real queue position/i)).toBeInTheDocument();
  });

  test('every queued row carries the branch and the person who triggered it', async () => {
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    const rows = rowsOf(/job queue/i);
    expect(rows.some((row) => row.includes('web-app/release/1.4') && row.includes('priya-s'))).toBe(true);
    expect(
      rows.some((row) => row.includes('web-app/feature/telemetry-export') && row.includes('amira-k')),
    ).toBe(true);

    expect(rows.some((row) => row.includes('acme/'))).toBe(false);
  });

  test('the runner card is a header with the total and the three states stacked under it', async () => {
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    const card = screen.getByRole('group', { name: /arc-gpu-a10/i });
    expect(card).toHaveAccessibleName('arc-gpu-a10: 4 total, 0 available, 3 working, 1 offline');
    expect(card.textContent).toBe('arc-gpu-a10 : 4Available:0Working:3Offline:1');
  });

  test('the whole queue is one table, with the pool as a column', async () => {
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    expect(screen.getAllByRole('table', { name: /job queue/i })).toHaveLength(1);

    const rows = rowsOf(/job queue/i);
    expect(rows[0]).toContain('Queued for');
    expect(rows.some((row) => row.includes('arc-gpu-a10'))).toBe(true);

    expect(rows.some((row) => row.includes('infra-tools') && row.includes('Unknown'))).toBe(true);
    expect(screen.getByText(/GitHub didn't say which runner pool/i)).toBeInTheDocument();
  });

  test('clicking a column heading reorders the table, and clicking it again reverses it', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    const byTrigger = () =>
      within(screen.getByRole('table', { name: /job queue/i })).getByRole('button', {
        name: /triggered by/i,
      });
    const peopleInOrder = () =>
      rowsOf(/job queue/i)
        .slice(1)
        .map((row) => ['amira-k', 'devlin-park', 'priya-s'].find((name) => row.includes(name)));

    expect(peopleInOrder()).toEqual(['priya-s', 'amira-k', 'devlin-park']);

    await user.click(byTrigger());
    expect(peopleInOrder()).toEqual(['amira-k', 'devlin-park', 'priya-s']);

    await user.click(byTrigger());
    expect(peopleInOrder()).toEqual(['priya-s', 'devlin-park', 'amira-k']);

    expect(rowsOf(/job queue/i)).toHaveLength(4);
  });

  test('running jobs are listed longest-running first', async () => {
    renderApp();
    await screen.findByRole('table', { name: /running jobs/i });

    const rows = rowsOf(/running jobs/i);
    const longIndex = rows.findIndex((row) => row.includes('long-job'));
    const shortIndex = rows.findIndex((row) => row.includes('short-job'));
    expect(longIndex).toBeGreaterThan(0);
    expect(longIndex).toBeLessThan(shortIndex);
  });

  test('the job name is the only link in a row, with no arrow glyph on it', async () => {
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    const link = screen.getByRole('link', { name: /Job package in acme\/infra-tools/i });
    expect(link).toHaveAttribute('href', queueItems[2].htmlUrl);
    expect(link.textContent).toBe('package');
    expect(link).toHaveAccessibleName(/opens on github\.com/i);

    const queue = screen.getByRole('table', { name: /job queue/i });
    expect(within(queue).queryByRole('link', { name: /^Repository /i })).not.toBeInTheDocument();
  });

  test('history fits on one page when there is little of it', async () => {
    renderApp();
    await screen.findByRole('table', { name: /job history/i });

    expect(rowsOf(/job history/i)).toHaveLength(9);
    expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();
  });

  test('the queue pages 10 rows at a time', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 13 }, (_, index) => ({
      ...queueItems[0],
      id: 910000 + index,
      name: `waiting-${index}`,
      position: index + 1,
    }));
    vi.mocked(api.fetchQueue).mockResolvedValue({ ...mockQueue, items: many });
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    expect(rowsOf(/job queue/i)).toHaveLength(11);

    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(rowsOf(/job queue/i)).toHaveLength(4);
  });

  test('running jobs page 10 rows at a time', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 13 }, (_, index) => ({
      ...mockRunning.items[0],
      id: 920000 + index,
      name: `running-${index}`,
    }));
    vi.mocked(api.fetchRunningJobs).mockResolvedValue({ ...mockRunning, items: many });
    renderApp();
    await screen.findByRole('table', { name: /running jobs/i });

    expect(rowsOf(/running jobs/i)).toHaveLength(11);

    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(rowsOf(/running jobs/i)).toHaveLength(4);
  });

  test('a refetch that changes the count leaves the reader on their page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const queued = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
          ...queueItems[0],
          id: 930000 + index,
          name: `waiting-${index}`,
          position: index + 1,
        }));

      vi.mocked(api.fetchQueue).mockResolvedValue({ ...mockQueue, items: queued(45) });
      renderApp();
      await screen.findByRole('table', { name: /job queue/i });

      await user.click(screen.getAllByRole('button', { name: /next page/i })[0]);
      expect(screen.getByText('11–20 of 45')).toBeInTheDocument();

      // One job left the queue. The reader must not be thrown back to page one.
      vi.mocked(api.fetchQueue).mockResolvedValue({ ...mockQueue, items: queued(44) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS + 100);
      });

      expect(screen.getByText('11–20 of 44')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('changing the pool goes back to the first page', async () => {
    const user = userEvent.setup();
    const queued = (scaleSet: string) =>
      Array.from({ length: 45 }, (_, index) => ({
        ...queueItems[0],
        id: 940000 + index,
        name: `waiting-${index}`,
        scaleSet,
        position: index + 1,
      }));

    vi.mocked(api.fetchQueue).mockResolvedValue({
      ...mockQueue,
      items: [...queued('arc-linux-x64'), ...queued('arc-gpu-a10')],
    });
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    await user.click(screen.getAllByRole('button', { name: /next page/i })[0]);
    expect(screen.getByText('11–20 of 90')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Scale set'));
    await user.click(await screen.findByRole('option', { name: 'arc-linux-x64' }));

    expect(await screen.findByText('1–10 of 45')).toBeInTheDocument();
  });

  test('show all puts every row on the page for browser find', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 45 }, (_, index) => ({
      ...queueItems[0],
      id: 950000 + index,
      name: `waiting-${index}`,
      position: index + 1,
    }));
    vi.mocked(api.fetchQueue).mockResolvedValue({ ...mockQueue, items: many });
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    expect(rowsOf(/job queue/i)).toHaveLength(11);

    await user.click(screen.getByRole('button', { name: /show all 45/i }));
    expect(rowsOf(/job queue/i)).toHaveLength(46);
  });

  test('history pages 20 rows at a time', async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchJobHistory).mockResolvedValue(historyJobs(25));
    renderApp();
    await screen.findByRole('table', { name: /job history/i });

    expect(rowsOf(/job history/i)).toHaveLength(21);

    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(rowsOf(/job history/i)).toHaveLength(6);

    await user.click(screen.getByRole('button', { name: /previous page/i }));
    expect(rowsOf(/job history/i)).toHaveLength(21);
  });

  test('a job with the nullable fields missing renders gaps, not 1970', async () => {
    vi.mocked(api.fetchRunningJobs).mockResolvedValue({
      orderingIsEstimate: true,
      note: '',
      incomplete: false,
      items: [
        {
          ...mockRunning.items[0],
          id: 909999,
          workflowName: null,
          branch: null,
          actor: null,
          event: null,
          runnerName: null,
          scaleSet: null,
          startedAt: null,
          runningMs: null,
        },
      ],
    });

    renderApp();
    await screen.findByRole('table', { name: /running jobs/i });

    const row = rowsOf(/running jobs/i)[1];
    expect(row).toContain('—');
    expect(row).toContain('unknown');
    expect(row).not.toMatch(/01\.01|1970|20641d/);
    expect(row).toContain('short-job');
  });

  test('an empty queue reads as good news, not a blank table', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(emptyQueue);
    vi.mocked(api.fetchRunningJobs).mockResolvedValue(emptyRunning);
    renderApp();
    expect(await screen.findByText(/no jobs waiting/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing to say/i)).not.toBeInTheDocument();
  });

  test('an empty queue that could not see everything warns instead of celebrating', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue({ ...emptyQueue, incomplete: true });
    vi.mocked(api.fetchRunningJobs).mockResolvedValue(emptyRunning);
    renderApp();
    expect(await screen.findByText(/no jobs found.*list may be short/i)).toBeInTheDocument();
    expect(screen.queryByText(/no jobs waiting/i)).not.toBeInTheDocument();
  });

  test('empty running jobs that could not see everything warns instead of celebrating', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(emptyQueue);
    vi.mocked(api.fetchRunningJobs).mockResolvedValue({ ...emptyRunning, incomplete: true });
    renderApp();
    expect(await screen.findByText(/no running jobs found.*list may be short/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing running/i)).not.toBeInTheDocument();
  });

  test('the scale-set filter narrows every section', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    await user.click(screen.getByLabelText('Scale set'));
    await user.click(await screen.findByRole('option', { name: 'arc-linux-x64' }));

    await waitFor(() => {
      expect(api.fetchRunningJobs).toHaveBeenCalledWith('arc-linux-x64');
      expect(api.fetchJobHistory).toHaveBeenCalledWith('arc-linux-x64', 200);
    });
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: /job queue/i })).not.toBeInTheDocument();
    });
    expect(screen.getByText(/no jobs waiting/i)).toBeInTheDocument();
  });

  test('"Scale set unknown" stays in the dropdown after a pool is picked', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    await user.click(screen.getByLabelText('Scale set'));
    await user.click(await screen.findByRole('option', { name: 'arc-gpu-a10' }));

    await user.click(screen.getByLabelText('Scale set'));
    expect(await screen.findByRole('option', { name: 'Scale set unknown' })).toBeInTheDocument();
  });

  test('selecting "Scale set unknown" shows only the jobs with no pool', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    await user.click(screen.getByLabelText('Scale set'));
    await user.click(await screen.findByRole('option', { name: 'Scale set unknown' }));

    await waitFor(() => {
      const rows = rowsOf(/job queue/i);
      expect(rows.some((row) => row.includes('infra-tools'))).toBe(true);
      expect(rows.some((row) => row.includes('web-app'))).toBe(false);
    });
    expect(screen.getByText(/nothing running/i)).toBeInTheDocument();
  });

  test('with "Scale set unknown" chosen, runner availability says so instead of disappearing', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    expect(screen.getByRole('heading', { name: /available runners/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'arc-gpu-a10 : 4' })).toBeInTheDocument();

    await user.click(screen.getByLabelText('Scale set'));
    await user.click(await screen.findByRole('option', { name: 'Scale set unknown' }));

    await screen.findByText(/no runner pool to show for this selection/i);

    expect(screen.getByRole('heading', { name: /available runners/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'arc-gpu-a10 : 4' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no scale sets found/i)).not.toBeInTheDocument();
  });

  test('the page refreshes itself while it just sits there', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp();
      await screen.findByRole('table', { name: /job queue/i });

      const before = vi.mocked(api.fetchQueue).mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
      });

      expect(vi.mocked(api.fetchQueue).mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  test('coming back to the browser tab fetches again', async () => {
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });
    const before = vi.mocked(api.fetchQueue).mock.calls.length;

    await act(async () => {
      setVisibility('hidden');
    });
    await act(async () => {
      setVisibility('visible');
    });

    await waitFor(() => {
      expect(vi.mocked(api.fetchQueue).mock.calls.length).toBeGreaterThan(before);
    });
  });

  test('going back to a pool already looked at asks for its numbers again', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    const pick = async (name: string) => {
      await user.click(screen.getByLabelText('Scale set'));
      await user.click(await screen.findByRole('option', { name }));
    };

    await pick('arc-gpu-a10');
    await waitFor(() => expect(api.fetchRunningJobs).toHaveBeenCalledWith('arc-gpu-a10'));
    await pick('arc-linux-x64');
    await waitFor(() => expect(api.fetchRunningJobs).toHaveBeenCalledWith('arc-linux-x64'));
    await pick('arc-gpu-a10');

    await waitFor(() => {
      const forGpu = vi
        .mocked(api.fetchRunningJobs)
        .mock.calls.filter(([scaleSet]) => scaleSet === 'arc-gpu-a10');
      expect(forGpu.length).toBe(2);
    });
  });

  test('every section header shows a plain count', async () => {
    renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    expect(screen.getByText('3 waiting')).toBeInTheDocument();
    expect(screen.getByText('2 running')).toBeInTheDocument();
    expect(screen.getByText('last 8 finished')).toBeInTheDocument();
  });

  test('the live region reports the filter outcome', async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await screen.findByRole('table', { name: /job queue/i });

    await user.click(screen.getByLabelText('Scale set'));
    await user.click(await screen.findByRole('option', { name: 'arc-gpu-a10' }));

    await waitFor(() => {
      const region = container.querySelector('[role="status"]');
      expect(region?.textContent).toMatch(/Showing arc-gpu-a10 — 2 jobs waiting, 2 running\./i);
    });
  });

  test('one outage is reported once, not four times', async () => {
    failEverythingWith(new Error('Request failed with status code 404'));

    renderApp();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't reach its backend/i);
    expect(screen.getAllByRole('button', { name: /try again/i })).toHaveLength(1);
    expect(screen.getByText(/request failed with status code 404/i)).toBeInTheDocument();
  });

  test("the backend's own explanation reaches the screen, and blames GitHub not the backend", async () => {
    const refused = toApiError({
      message: 'Request failed with status code 500',
      response: { status: 500, data: { error: 'GitHub token not configured' } },
    });
    failEverythingWith(refused);

    renderApp();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't get the data from GitHub/i);
    expect(alert).toHaveTextContent(/GitHub token not configured/i);

    expect(alert).not.toHaveTextContent(/can't reach its backend/i);
    expect(alert).not.toHaveTextContent(/try again in a moment/i);
    expect(alert).not.toHaveTextContent(/request failed with status code/i);

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  test('when nothing answers at all, the wait-and-retry wording stays', async () => {
    failEverythingWith(toApiError({ message: 'Network Error' }));

    renderApp();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't reach its backend/i);
    expect(alert).toHaveTextContent(/try again in a moment/i);
    expect(alert).toHaveTextContent(/Network Error/i);
    expect(alert).not.toHaveTextContent(/can't get the data from GitHub/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  test('every section says how fresh it is, and how often it refreshes', async () => {
    vi.mocked(api.fetchSettings).mockResolvedValue({ runnersRefreshSeconds: 45 });

    renderApp();

    const freshness = await screen.findAllByText(/^Updated /);
    expect(freshness).toHaveLength(4);

    const runners = freshness[0];
    expect(runners).toHaveAttribute('title', 'Refreshes every 45 seconds');
    expect(freshness[1]).toHaveAttribute(
      'title',
      `Refreshes every ${REFRESH_INTERVAL_MS / 1000} seconds`,
    );

    expect(screen.queryByText(/are updated every/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /time zone/i })).not.toBeInTheDocument();
  });

  test('the runner interval waits for the backend rather than inventing a number', async () => {
    vi.mocked(api.fetchSettings).mockRejectedValue(new Error('nope'));

    renderApp();

    const freshness = await screen.findAllByText(/^Updated /);
    expect(freshness[0]).not.toHaveAttribute('title');
    expect(freshness[1]).toHaveAttribute(
      'title',
      `Refreshes every ${REFRESH_INTERVAL_MS / 1000} seconds`,
    );
  });

  test('times are the clock of the computer the page is open on', async () => {
    renderApp();
    await screen.findByRole('table', { name: /running jobs/i });

    // The tests run with TZ pinned to Asia/Jerusalem — see vitest.config.ts.
    expect(screen.getAllByTitle(/Jerusalem, UTC\+\d/).length).toBeGreaterThan(0);
  });

  test('the toggle switches between the light and dark themes and remembers it', async () => {
    renderApp();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /switch to the dark theme/i }));

    expect(screen.getByRole('button', { name: /switch to the light theme/i })).toBeInTheDocument();
    expect(window.localStorage.getItem('runner-monitor.theme')).toBe('dark');

    await user.click(screen.getByRole('button', { name: /switch to the light theme/i }));

    expect(screen.getByRole('button', { name: /switch to the dark theme/i })).toBeInTheDocument();
    expect(window.localStorage.getItem('runner-monitor.theme')).toBe('light');
  });

  test('a single failing section shows the backend message too', async () => {
    vi.mocked(api.fetchJobHistory).mockRejectedValue(
      toApiError({
        message: 'Request failed with status code 500',
        response: { status: 500, data: { error: 'GitHub organization not configured' } },
      }),
    );

    renderApp();

    expect(await screen.findByText(/GitHub organization not configured/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
