import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchDebugItRuns,
  fetchDebugRun,
  fetchDebugRunResult,
  openDebugFixPullRequest,
  saveDebugRunFeedback,
  startDebugRun,
} from '../services/api';
import { shouldRetry } from '../queryClient';
import type {
  DebugFeedbackInput,
  DebugFixPullRequest,
  DebugRunResultView,
  DebugRunState,
  DebugRunView,
} from '../types/api';

export const DEBUG_IT_RUNS_KEY = ['debug-it-runs'];
export const debugRunKey = (runId: string) => ['debug-it-run', runId];
export const debugRunResultKey = (runId: string) => ['debug-it-run-result', runId];

/** How often an active run is fetched again while its dialog is open. */
export const DEBUG_RUN_REFETCH_MS = 5000;

const ACTIVE: ReadonlySet<DebugRunState> = new Set<DebugRunState>(['waiting', 'cloning', 'analyzing']);

export const isActiveRun = (state: DebugRunState | undefined): boolean => state !== undefined && ACTIVE.has(state);

/** The allowed repositories and the user's latest run per target; only for allowed users. */
export const useDebugItRuns = (enabled: boolean) => {
  return useQuery({
    queryKey: DEBUG_IT_RUNS_KEY,
    queryFn: fetchDebugItRuns,
    enabled,
    retry: shouldRetry,
  });
};

export const useStartDebugRun = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startDebugRun,
    onSuccess: (view) => {
      // The dialog shows the answered run at once, then polls it.
      const { existing: _existing, ...run } = view;
      queryClient.setQueryData<DebugRunView>(debugRunKey(run.runId), run);
      void queryClient.invalidateQueries({ queryKey: DEBUG_IT_RUNS_KEY });
    },
  });
};

/** One run, polled every 5 seconds while active; no polling once it ends or a read fails. */
export const useDebugRun = (runId: string | null) => {
  return useQuery({
    queryKey: debugRunKey(runId ?? ''),
    queryFn: () => fetchDebugRun(runId as string),
    enabled: runId !== null,
    retry: shouldRetry,
    refetchInterval: (query) =>
      query.state.status !== 'error' && isActiveRun(query.state.data?.state) ? DEBUG_RUN_REFETCH_MS : false,
  });
};

/** The result of a run in a final state; fetched once, not polled. */
export const useDebugRunResult = (runId: string, enabled: boolean) => {
  return useQuery({
    queryKey: debugRunResultKey(runId),
    queryFn: () => fetchDebugRunResult(runId),
    enabled,
    retry: shouldRetry,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
};

/** Saves the requester's rating; the answered result view replaces the cached one. */
export const useSaveDebugFeedback = (runId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DebugFeedbackInput) => saveDebugRunFeedback(runId, input),
    onSuccess: (view) => {
      queryClient.setQueryData<DebugRunResultView>(debugRunResultKey(runId), view);
    },
  });
};

const sameRepository = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Opens a fix pull request for one repository of a run (story 4.3); the
 * answered link joins the cached result view's fixPullRequests and the
 * repository leaves canOpenPullRequest.
 */
export const useOpenFixPullRequest = (runId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repository: string) => openDebugFixPullRequest(runId, repository),
    onSuccess: (answer: DebugFixPullRequest, repository: string) => {
      queryClient.setQueryData<DebugRunResultView>(debugRunResultKey(runId), (current) => {
        if (!current) return current;
        const opened = Array.isArray(current.fixPullRequests) ? current.fixPullRequests : [];
        const offered = Array.isArray(current.canOpenPullRequest) ? current.canOpenPullRequest : [];
        return {
          ...current,
          fixPullRequests: opened.some((e) => sameRepository(e.repository, answer.repository))
            ? opened
            : [...opened, { repository: answer.repository, url: answer.url }],
          canOpenPullRequest: offered.filter(
            (r) => !sameRepository(r, repository) && !sameRepository(r, answer.repository),
          ),
        };
      });
    },
  });
};
