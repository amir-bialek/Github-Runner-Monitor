import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';
import DebugRunDialog from './components/DebugRunDialog';
import * as api from './services/api';
import { ApiError } from './services/apiError';
import type { DebugPatchCheck, DebugRunResult, DebugRunResultView, DebugRunView } from './types/api';

vi.mock('./services/api', () => ({
  signInUrl: '/api/debug-it/sign-in',
  fetchDebugItRuns: vi.fn(),
  startDebugRun: vi.fn(),
  fetchDebugRun: vi.fn(),
  fetchDebugRunResult: vi.fn(),
  saveDebugRunFeedback: vi.fn(),
  openDebugFixPullRequest: vi.fn(),
}));

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const REPO = 'acme/payments-api';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const EXPLANATION = 'The refund test expects banker rounding.\nThe code now rounds half up.';
const PATCH = [
  'diff --git a/src/refund.ts b/src/refund.ts',
  '--- a/src/refund.ts',
  '+++ b/src/refund.ts',
  '@@ -1,2 +1,2 @@',
  ' const mode = 1;',
  '-round(half_up)',
  '+round(half_even)',
  '',
].join('\n');

function run(overrides: Partial<DebugRunView> = {}): DebugRunView {
  return {
    runId: RUN_ID,
    target: { kind: 'job', id: 1 },
    state: 'finished',
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:04:00.000Z',
    elapsedMs: 240_000,
    repository: REPO,
    jobName: 'test',
    failureReason: null,
    ...overrides,
  };
}

function result(overrides: Partial<DebugRunResult> = {}): DebugRunResult {
  return {
    explanation: EXPLANATION,
    causeLocation: { kind: 'this-repository' },
    patch: PATCH,
    costUsd: 0.4231,
    durationMs: 154_000,
    logTruncated: false,
    failureReason: 'none',
    ...overrides,
  };
}

function view(overrides: Partial<DebugRunResultView> = {}): DebugRunResultView {
  return {
    run: run(),
    result: result(),
    downloads: [
      { repository: REPO, commitSha: SHA, folder: 'payments-api' },
      { repository: 'acme/shared-config', commitSha: 'ffeeddccbbaa', folder: 'shared-config' },
    ],
    skippedRepositories: [],
    feedback: null,
    canGiveFeedback: true,
    ...overrides,
  };
}

function renderDialog() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  const ui = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <DebugRunDialog content={open ? { kind: 'run', runId: RUN_ID } : null} onClose={() => {}} />
    </QueryClientProvider>
  );
  const rendered = render(ui(true));
  return {
    ...rendered,
    queryClient,
    reopen: () => {
      rendered.rerender(ui(false));
      rendered.rerender(ui(true));
    },
  };
}

const dialog = () => screen.findByRole('dialog', { name: 'Debug run' });

beforeEach(() => {
  vi.mocked(api.fetchDebugRun).mockReset().mockResolvedValue(run());
  vi.mocked(api.fetchDebugRunResult).mockReset().mockResolvedValue(view());
  vi.mocked(api.saveDebugRunFeedback).mockReset();
  vi.mocked(api.openDebugFixPullRequest).mockReset();
});

describe('debug run result', () => {
  test('a finished run with a patch shows every part of the result', async () => {
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText(/The refund test expects banker rounding\./)).toBeInTheDocument();
    // The explanation keeps its line breaks.
    const explanation = within(d).getByText(/banker rounding/);
    expect(explanation.textContent).toBe(EXPLANATION);
    expect(explanation).toHaveStyle({ whiteSpace: 'pre-wrap' });
    expect(within(d).getByText('This repository')).toBeInTheDocument();
    expect(within(within(d).getByRole('list', { name: 'Changed files' })).getByText('src/refund.ts')).toBeInTheDocument();

    const patch = within(d).getByLabelText('Patch');
    expect(patch.tagName).toBe('PRE');
    expect(patch.textContent).toBe(PATCH);
    const added = within(patch).getByText('+round(half_even)');
    const removed = within(patch).getByText('-round(half_up)');
    expect(added).toHaveAttribute('data-kind', 'added');
    expect(removed).toHaveAttribute('data-kind', 'removed');
    expect(within(patch).getByText('+++ b/src/refund.ts')).toHaveAttribute('data-kind', 'context');
    expect(within(patch).getByText('--- a/src/refund.ts')).toHaveAttribute('data-kind', 'context');
    expect(getComputedStyle(added).color).not.toBe(getComputedStyle(removed).color);

    const downloads = within(d).getByRole('list', { name: 'Repositories downloaded' });
    expect(downloads).toHaveTextContent(`${REPO} at a1b2c3d`);
    expect(downloads).toHaveTextContent('acme/shared-config at ffeeddc');
    expect(within(d).getByText('$0.42')).toBeInTheDocument();
    expect(within(d).getByText('2m 34s')).toBeInTheDocument();
    expect(within(d).getByText('This patch was written without running any command or test.')).toBeInTheDocument();
    expect(within(d).queryByText('The log was cut to its last part.')).toBeNull();
    expect(api.fetchDebugRunResult).toHaveBeenCalledWith(RUN_ID);
  });

  test.each([
    [{ kind: 'extra-repository', repository: 'acme/shared-config' }, 'Extra repository acme/shared-config'],
    [{ kind: 'workflow-file' }, 'The workflow file'],
    [{ kind: 'runner' }, 'The runner or runner image'],
    [{ kind: 'infrastructure' }, 'Infrastructure'],
    [{ kind: 'unknown' }, 'Unknown'],
  ] as const)('cause %j reads %s', async (causeLocation, label) => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(view({ result: result({ causeLocation }) }));
    renderDialog();
    expect(await within(await dialog()).findByText(label)).toBeInTheDocument();
  });

  test('a truncated log says so', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(view({ result: result({ logTruncated: true }) }));
    renderDialog();
    expect(await within(await dialog()).findByText('The log was cut to its last part.')).toBeInTheDocument();
  });

  test('an empty patch: no change proposed, no Copy or Download', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(view({ result: result({ patch: '' }) }));
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText('No change was proposed.')).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(within(d).queryByRole('button', { name: 'Download .patch' })).toBeNull();
    expect(within(d).queryByText('This patch was written without running any command or test.')).toBeNull();
  });

  test('an active run does not ask for the result', async () => {
    vi.mocked(api.fetchDebugRun).mockResolvedValue(run({ state: 'analyzing' }));
    renderDialog();
    const d = await dialog();
    await waitFor(() => expect(within(d).getByRole('status')).toHaveTextContent('Analyzing'));
    expect(api.fetchDebugRunResult).not.toHaveBeenCalled();
  });

  test('a failed run with a partial result: reason and explanation', async () => {
    const reason = 'The Debug Job reached its time limit without sending a result.';
    vi.mocked(api.fetchDebugRun).mockResolvedValue(run({ state: 'failed', failureReason: reason }));
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      view({ result: result({ patch: '', failureReason: 'time-limit' }) }),
    );
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText(reason)).toBeInTheDocument();
    expect(await within(d).findByText(/banker rounding/)).toBeInTheDocument();
  });

  test('a failed run without a result: reason only, no feedback form', async () => {
    const reason = 'The Debug Job ended without sending a result.';
    vi.mocked(api.fetchDebugRun).mockResolvedValue(run({ state: 'failed', failureReason: reason }));
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(view({ result: null, downloads: [], canGiveFeedback: false }));
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText(reason)).toBeInTheDocument();
    await waitFor(() => expect(api.fetchDebugRunResult).toHaveBeenCalled());
    await waitFor(() => expect(within(d).queryByText('Loading the result…')).toBeNull());
    expect(within(d).queryByRole('form', { name: 'Rate this result' })).toBeNull();
    expect(within(d).queryByText('Explanation')).toBeNull();
  });

  test('the result is not polled and not fetched again on window focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderDialog();
      const d = await dialog();
      expect(await within(d).findByText(/banker rounding/)).toBeInTheDocument();
      expect(api.fetchDebugRunResult).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(api.fetchDebugRunResult).toHaveBeenCalledTimes(1);
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  test('a failed refetch keeps the result and the typed comment, with a warning', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderDialog();
    const d = await dialog();
    const form = await within(d).findByRole('form', { name: 'Rate this result' });
    await user.type(within(form).getByLabelText('Comment (optional)'), 'Half right');
    const sentence = 'S3 cannot be reached, so this debug run cannot be read right now.';
    vi.mocked(api.fetchDebugRunResult).mockRejectedValue(new ApiError(sentence, { source: 'backend', status: 503 }));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['debug-it-run-result', RUN_ID] });
    });
    expect(await within(d).findByText(sentence)).toBeInTheDocument();
    expect(within(d).getByText(/banker rounding/)).toBeInTheDocument();
    expect(within(d).getByLabelText('Comment (optional)')).toHaveValue('Half right');
  });

  test('a refused result shows only the backend sentence', async () => {
    const sentence = 'You do not have read access to acme/shared-config.';
    vi.mocked(api.fetchDebugRunResult).mockRejectedValue(new ApiError(sentence, { source: 'backend', status: 403 }));
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText(sentence)).toBeInTheDocument();
    expect(within(d).queryByText('Explanation')).toBeNull();
    expect(within(d).queryByLabelText('Patch')).toBeNull();
  });

  test('result strings render as text, never markup', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      view({
        result: result({
          explanation: '<img src=x onerror=alert(1)> **bold**',
          patch: '--- a/x\n+++ b/x\n+<script>alert(1)</script>\n',
          causeLocation: { kind: 'extra-repository', repository: '<b>acme/x</b>' },
        }),
        downloads: [{ repository: '<i>acme/y</i>', commitSha: SHA, folder: 'y' }],
      }),
    );
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText('<img src=x onerror=alert(1)> **bold**')).toBeInTheDocument();
    expect(within(d).getByText('+<script>alert(1)</script>')).toBeInTheDocument();
    expect(within(d).getByText('Extra repository <b>acme/x</b>')).toBeInTheDocument();
    expect(d.querySelector('img, script, b, i, strong')).toBeNull();
  });
});

describe('copy and download', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('Copy writes the patch to the clipboard and says Copied', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderDialog();
    const d = await dialog();
    fireEvent.click(await within(d).findByRole('button', { name: 'Copy' }));
    expect(await within(d).findByText('Copied')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(PATCH);
  });

  test('a clipboard failure says so', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderDialog();
    const d = await dialog();
    fireEvent.click(await within(d).findByRole('button', { name: 'Copy' }));
    expect(await within(d).findByText('The patch could not be copied.')).toBeInTheDocument();
  });

  test('Download builds a text/x-diff blob link and revokes it', async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:debug-run';
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const clicked: Array<{ href: string; download: string; attached: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
    });
    renderDialog();
    const d = await dialog();
    fireEvent.click(await within(d).findByRole('button', { name: 'Download .patch' }));
    // Revoked only after the click's task, so the download is not cancelled.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(clicked).toEqual([{ href: 'blob:debug-run', download: `debug-run-${RUN_ID}.patch`, attached: true }]);
    expect(created[0]?.type).toBe('text/x-diff');
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(created[0] as Blob);
    });
    expect(text).toBe(PATCH);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:debug-run'));
    expect(document.querySelector('a[download]')).toBeNull();
  });
});

describe('feedback', () => {
  test('only shown when canGiveFeedback', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(view({ canGiveFeedback: false }));
    renderDialog();
    const d = await dialog();
    await within(d).findByText(/banker rounding/);
    expect(within(d).queryByRole('form', { name: 'Rate this result' })).toBeNull();
    expect(within(d).queryByRole('button', { name: 'Useful' })).toBeNull();
  });

  test('the requester saves a rating; it is selected on reopen', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveDebugRunFeedback).mockImplementation(async (_runId, input) =>
      view({ feedback: { rating: input.rating, comment: input.comment ?? null, at: '2026-11-05T10:05:00.000Z' } }),
    );
    const { reopen } = renderDialog();
    let d = await dialog();
    const form = await within(d).findByRole('form', { name: 'Rate this result' });
    const save = within(form).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(within(form).getByRole('button', { name: 'Useful' }));
    await user.type(within(form).getByLabelText('Comment (optional)'), 'Spot on');
    await user.click(save);
    expect(await within(form).findByText('Thanks, your rating was saved.')).toBeInTheDocument();
    expect(api.saveDebugRunFeedback).toHaveBeenCalledWith(RUN_ID, { rating: 'useful', comment: 'Spot on' });

    reopen();
    d = await dialog();
    const again = await within(d).findByRole('form', { name: 'Rate this result' });
    expect(within(again).getByRole('button', { name: 'Useful' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(again).getByRole('button', { name: 'Not useful' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(again).getByLabelText('Comment (optional)')).toHaveValue('Spot on');
  });

  test('a saved rating from the server is selected', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      view({ feedback: { rating: 'not-useful', comment: null, at: '2026-11-05T10:05:00.000Z' } }),
    );
    renderDialog();
    const form = await within(await dialog()).findByRole('form', { name: 'Rate this result' });
    expect(within(form).getByRole('button', { name: 'Not useful' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('a refused save shows the backend sentence', async () => {
    const user = userEvent.setup();
    const sentence = 'Only the person who started this debug run can rate its result.';
    vi.mocked(api.saveDebugRunFeedback).mockRejectedValue(new ApiError(sentence, { source: 'backend', status: 403 }));
    renderDialog();
    const form = await within(await dialog()).findByRole('form', { name: 'Rate this result' });
    await user.click(within(form).getByRole('button', { name: 'Not useful' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(sentence)).toBeInTheDocument();
    expect(within(form).queryByText('Thanks, your rating was saved.')).toBeNull();
    expect(api.saveDebugRunFeedback).toHaveBeenCalledWith(RUN_ID, { rating: 'not-useful', comment: null });
  });

  test('the comment is held to 2000 characters', async () => {
    renderDialog();
    const form = await within(await dialog()).findByRole('form', { name: 'Rate this result' });
    const field = within(form).getByLabelText('Comment (optional)');
    expect(field).toHaveAttribute('maxLength', '2000');
    fireEvent.change(field, { target: { value: 'x'.repeat(2100) } });
    expect((field as HTMLTextAreaElement).value).toHaveLength(2000);
  });
});

describe('fix pull requests (story 4.3)', () => {
  const EXTRA = 'acme/shared-config';
  const PR_URL = 'https://github.com/acme/payments-api/pull/17';
  const EXTRA_URL = 'https://github.com/acme/shared-config/pull/4';
  const WORKFLOW_MESSAGE = 'Workflow files cannot be changed by Debug it; apply this change to the workflow by hand.';

  function check(overrides: Partial<DebugPatchCheck> = {}): DebugPatchCheck {
    return {
      status: 'passed',
      rule: null,
      message: null,
      repositories: [
        { repository: REPO, folder: 'payments-api', files: ['src/refund.ts'], status: 'passed', rule: null, message: null },
        { repository: EXTRA, folder: 'shared-config', files: ['config.yml'], status: 'passed', rule: null, message: null },
      ],
      ...overrides,
    };
  }

  const twoOffered = (overrides: Partial<DebugRunResultView> = {}) =>
    view({ patchCheck: check(), fixPullRequests: [], canOpenPullRequest: [REPO, EXTRA], ...overrides });

  test('one Open a PR button per offered repository', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(twoOffered());
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByRole('heading', { name: 'Fix pull requests' })).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: `Open a PR for ${REPO}` })).toBeEnabled();
    expect(within(d).getByRole('button', { name: `Open a PR for ${EXTRA}` })).toBeEnabled();
    expect(within(d).getByLabelText('Patch')).toBeInTheDocument();
  });

  test('nothing offered, opened or refused: no section, no heading, no row text', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(twoOffered({ canOpenPullRequest: [] }));
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByLabelText('Patch')).toBeInTheDocument();
    expect(within(d).queryByRole('heading', { name: 'Fix pull requests' })).toBeNull();
    expect(within(d).queryByRole('button', { name: /Open a PR/ })).toBeNull();
    expect(within(d).queryByText(/Fix pull request for/)).toBeNull();
  });

  test('a view without the new fields shows no button and no section', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(view({ patchCheck: check() }));
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByLabelText('Patch')).toBeInTheDocument();
    expect(within(d).queryByRole('heading', { name: 'Fix pull requests' })).toBeNull();
    expect(within(d).queryByRole('button', { name: /Open a PR/ })).toBeNull();
  });

  test('an opened link stays when the recomputed check no longer lists its repository', async () => {
    const message = 'The patch is larger than the limit.';
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      view({
        patchCheck: check({ status: 'refused', rule: 'too-large', message, repositories: [] }),
        fixPullRequests: [{ repository: REPO, url: PR_URL }],
        canOpenPullRequest: [],
      }),
    );
    renderDialog();
    const d = await dialog();
    const link = await within(d).findByRole('link', { name: `Fix pull request for ${REPO} — opens on github.com` });
    expect(link).toHaveAttribute('href', PR_URL);
    expect(within(d).getByText(message)).toBeInTheDocument();
    expect(within(d).getByRole('heading', { name: 'Fix pull requests' })).toBeInTheDocument();
  });

  test('an opened link stays when a passed check lists only other repositories', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      view({
        patchCheck: check({
          repositories: [
            { repository: EXTRA, folder: 'shared-config', files: ['config.yml'], status: 'passed', rule: null, message: null },
          ],
        }),
        fixPullRequests: [{ repository: REPO, url: PR_URL }],
        canOpenPullRequest: [],
      }),
    );
    renderDialog();
    const d = await dialog();
    expect(
      await within(d).findByRole('link', { name: `Fix pull request for ${REPO} — opens on github.com` }),
    ).toHaveAttribute('href', PR_URL);
  });

  test('a refused part shows its rule; the workflow message says to apply it by hand', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      twoOffered({
        patchCheck: check({
          status: 'refused',
          rule: 'workflow-file',
          message: WORKFLOW_MESSAGE,
          repositories: [
            { repository: REPO, folder: 'payments-api', files: ['src/refund.ts'], status: 'passed', rule: null, message: null },
            {
              repository: EXTRA,
              folder: 'shared-config',
              files: ['.github/workflows/ci.yml'],
              status: 'refused',
              rule: 'workflow-file',
              message: WORKFLOW_MESSAGE,
            },
          ],
        }),
        canOpenPullRequest: [REPO],
      }),
    );
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByRole('button', { name: `Open a PR for ${REPO}` })).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: `Open a PR for ${EXTRA}` })).toBeNull();
    const alert = within(d).getByText(`${EXTRA}: ${WORKFLOW_MESSAGE}`);
    expect(alert.closest('[role="alert"]')).toHaveClass('MuiAlert-standardWarning');
    expect(within(d).getByLabelText('Patch')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  test('an unreadable patch: one warning with the message; the patch stays visible', async () => {
    const message = 'The patch could not be read as a unified diff.';
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      view({ patchCheck: check({ status: 'refused', rule: 'unreadable', message, repositories: [] }), canOpenPullRequest: [] }),
    );
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText(message)).toBeInTheDocument();
    expect(d.querySelectorAll('.MuiAlert-standardWarning')).toHaveLength(1);
    expect(within(d).getByLabelText('Patch')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Download .patch' })).toBeInTheDocument();
  });

  test('an opened pull request shows its link, to every viewer', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      twoOffered({ canGiveFeedback: false, fixPullRequests: [{ repository: REPO, url: PR_URL }], canOpenPullRequest: [] }),
    );
    renderDialog();
    const d = await dialog();
    const link = await within(d).findByRole('link', { name: `Fix pull request for ${REPO} — opens on github.com` });
    expect(link).toHaveAttribute('href', PR_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(d).getByText(`Fix pull request for ${REPO}:`, { exact: false })).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: /Open a PR/ })).toBeNull();
  });

  test('a click opens the pull request; its link replaces the button', async () => {
    const user = userEvent.setup();
    let finish!: (value: { repository: string; url: string }) => void;
    vi.mocked(api.openDebugFixPullRequest).mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(twoOffered());
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: `Open a PR for ${EXTRA}` }));
    expect(api.openDebugFixPullRequest).toHaveBeenCalledWith(RUN_ID, EXTRA);
    expect(within(d).getByRole('button', { name: `Open a PR for ${EXTRA}` })).toBeDisabled();
    // The other repository's button is not affected.
    expect(within(d).getByRole('button', { name: `Open a PR for ${REPO}` })).toBeEnabled();
    await act(async () => finish({ repository: EXTRA, url: EXTRA_URL }));
    const link = await within(d).findByRole('link', { name: `Fix pull request for ${EXTRA} — opens on github.com` });
    expect(link).toHaveAttribute('href', EXTRA_URL);
    expect(within(d).queryByRole('button', { name: `Open a PR for ${EXTRA}` })).toBeNull();
    expect(within(d).getByRole('button', { name: `Open a PR for ${REPO}` })).toBeInTheDocument();
  });

  test('a refused click shows the API sentence under the button', async () => {
    const user = userEvent.setup();
    const sentence =
      'Debug it opens fix pull requests only where an active ruleset, with no bypass for Debug it, stops it from pushing to and merging into the default branch, and this repository has none.';
    vi.mocked(api.openDebugFixPullRequest).mockRejectedValue(new ApiError(sentence, { source: 'backend', status: 409 }));
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(twoOffered());
    renderDialog();
    const d = await dialog();
    await user.click(await within(d).findByRole('button', { name: `Open a PR for ${REPO}` }));
    const alert = await within(d).findByText(sentence);
    expect(alert.closest('[role="alert"]')).toHaveClass('MuiAlert-standardError');
    expect(within(d).getByRole('button', { name: `Open a PR for ${REPO}` })).toBeEnabled();
    expect(within(d).queryByRole('link', { name: /Fix pull request for/ })).toBeNull();
  });

  test('repository names and links render as text, never markup', async () => {
    vi.mocked(api.fetchDebugRunResult).mockResolvedValue(
      view({
        patchCheck: check({
          repositories: [
            { repository: '<b>acme/x</b>', folder: 'x', files: ['a'], status: 'refused', rule: 'file-mode', message: '<i>no</i>' },
            { repository: 'acme/y', folder: 'y', files: ['b'], status: 'passed', rule: null, message: null },
          ],
        }),
        // A listed, passed repository with a non-github.com URL: filtered out, so no link.
        fixPullRequests: [{ repository: 'acme/y', url: 'javascript:alert(1)' }],
        canOpenPullRequest: ['acme/y'],
      }),
    );
    renderDialog();
    const d = await dialog();
    expect(await within(d).findByText('<b>acme/x</b>: <i>no</i>')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Open a PR for acme/y' })).toBeInTheDocument();
    expect(within(d).queryByText(/Fix pull request for acme\/y/)).toBeNull();
    expect(d.querySelector('b, i, a[href^="javascript"]')).toBeNull();
  });
});
