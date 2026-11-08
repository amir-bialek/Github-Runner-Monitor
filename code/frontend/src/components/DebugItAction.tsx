import React, { useCallback, useMemo, useState } from 'react';
import { Box, Button } from '@mui/material';
import { signInUrl } from '../services/api';
import { isActiveRun, useDebugItRuns, useStartDebugRun } from '../hooks/useDebugRuns';
import { usePersonalKey } from '../hooks/usePersonalKey';
import type { DebugItSession, DebugRunView, HistoryJob, HistoryTarget } from '../types/api';
import DebugRunDialog, { type DebugRunDialogContent } from './DebugRunDialog';
import PersonalKeyDialog, { KEY_WORKS_NOTICE } from './PersonalKeyDialog';

export const KEY_FIRST_REASON = 'Save your personal Anthropic API key to start this debug run.';

type ShownSession = Extract<DebugItSession, { state: 'signed-out' | 'signed-in' }>;

/** Which Debug it column the Recent history table shows. */
export type DebugItMode = 'off' | 'signed-out' | 'allowed';

export function debugItMode(session: ShownSession | null | undefined): DebugItMode {
  if (!session) return 'off';
  if (session.state === 'signed-out') return 'signed-out';
  return session.allowedUser ? 'allowed' : 'off';
}

/** Whether the personal key UI shows: a signed in allowed user in personal key mode. */
export function personalKeyMode(session: ShownSession | null | undefined): boolean {
  return (
    session?.state === 'signed-in' && session.allowedUser && session.credentialsMode === 'personal'
  );
}

const targetKey = (target: HistoryTarget) => `${target.kind}:${target.id}`;

const cellButtonSx = { textTransform: 'none' as const, whiteSpace: 'nowrap' as const, py: 0.25 };

interface DebugItCellProps {
  job: HistoryJob;
  target: HistoryTarget;
  mode: DebugItMode;
  allowedRepositories: ReadonlySet<string> | null;
  existingRun: DebugRunView | undefined;
  onStart: (target: HistoryTarget) => void;
  onOpen: (runId: string) => void;
}

/** The Debug it cell of one Recent history row: only failed rows get an action. */
export const DebugItCell: React.FC<DebugItCellProps> = ({
  job,
  target,
  mode,
  allowedRepositories,
  existingRun,
  onStart,
  onOpen,
}) => {
  if (job.result !== 'failure') return null;
  const about = `${job.name} in ${job.repository}`;
  if (mode === 'signed-out') {
    return (
      <Button
        component="a"
        href={signInUrl}
        size="small"
        variant="text"
        aria-label={`Sign in to debug: ${about}`}
        sx={cellButtonSx}
      >
        Sign in to debug
      </Button>
    );
  }
  if (mode !== 'allowed' || !allowedRepositories) return null;
  if (!allowedRepositories.has(job.repository.trim().toLowerCase())) return null;
  const view = existingRun ? (
    <Button
      size="small"
      variant="text"
      aria-label={`View debug run: ${about}`}
      onClick={() => onOpen(existingRun.runId)}
      sx={cellButtonSx}
    >
      View debug run
    </Button>
  ) : null;
  // An active run holds the target; a finished or failed one can be debugged again.
  if (existingRun && isActiveRun(existingRun.state)) return view;
  const start = (
    <Button
      size="small"
      variant="outlined"
      aria-label={`Debug it: ${about}`}
      onClick={() => onStart(target)}
      sx={cellButtonSx}
    >
      Debug it
    </Button>
  );
  if (!view) return start;
  return (
    <Box sx={{ display: 'inline-flex', gap: 1, alignItems: 'center' }}>
      {view}
      {start}
    </Box>
  );
};

/**
 * Debug it for the Recent history table: whether the column shows, the cell
 * of each row and the progress dialog. Debug it off, a session still loading
 * or a signed in user who is not allowed: no column and no request.
 */
export function useDebugItColumn(session: ShownSession | null | undefined) {
  const mode = debugItMode(session);
  const runsQuery = useDebugItRuns(mode === 'allowed');
  const startMutation = useStartDebugRun();
  const [dialog, setDialog] = useState<DebugRunDialogContent | null>(null);
  // Personal key mode (story 5.2): the key status decides whether a click asks for the key first.
  const personal = mode === 'allowed' && personalKeyMode(session);
  const keyQuery = usePersonalKey(personal);
  const keyMissing = personal && keyQuery.data?.saved === false;
  const [keyTarget, setKeyTarget] = useState<HistoryTarget | null>(null);

  const allowedRepositories = useMemo(() => {
    const listed = runsQuery.data?.allowedRepositories;
    return listed ? new Set(listed.map((r) => r.trim().toLowerCase())) : null;
  }, [runsQuery.data]);

  const runsByTarget = useMemo(() => {
    const byTarget = new Map<string, DebugRunView>();
    for (const run of runsQuery.data?.runs ?? []) byTarget.set(targetKey(run.target), run);
    return byTarget;
  }, [runsQuery.data]);

  const onOpen = useCallback((runId: string) => setDialog({ kind: 'run', runId }), []);

  const { mutate } = startMutation;
  const startRun = useCallback(
    (target: HistoryTarget, notice?: string) => {
      setDialog(notice ? { kind: 'starting', notice } : { kind: 'starting' });
      mutate(target, {
        // A dialog closed while the start was in flight stays closed; the row then offers the run.
        onSuccess: (view) =>
          setDialog((d) =>
            d?.kind === 'starting' ? { kind: 'run', runId: view.runId, ...(d.notice ? { notice: d.notice } : {}) } : d,
          ),
        onError: (error) =>
          setDialog((d) =>
            d?.kind === 'starting'
              ? { kind: 'refused', message: error.message, ...(d.notice ? { notice: d.notice } : {}) }
              : d,
          ),
      });
    },
    [mutate],
  );

  // No saved personal key: ask for it first and send no start. A status still
  // loading or unreadable starts as usual; the backend then explains a refusal.
  const onStart = useCallback(
    (target: HistoryTarget) => {
      if (keyMissing) setKeyTarget(target);
      else startRun(target);
    },
    [keyMissing, startRun],
  );

  const onKeySaved = useCallback(() => {
    const target = keyTarget;
    setKeyTarget(null);
    if (target) startRun(target, KEY_WORKS_NOTICE);
  }, [keyTarget, startRun]);

  const showColumn = mode === 'signed-out' || mode === 'allowed';

  const renderCell = (job: HistoryJob, target: HistoryTarget) => (
    <DebugItCell
      job={job}
      target={target}
      mode={mode}
      allowedRepositories={allowedRepositories}
      existingRun={runsByTarget.get(targetKey(target))}
      onStart={onStart}
      onOpen={onOpen}
    />
  );

  const dialogElement = showColumn ? (
    <>
      <DebugRunDialog content={dialog} onClose={() => setDialog(null)} />
      {personal && (
        <PersonalKeyDialog
          open={keyTarget !== null}
          onClose={() => setKeyTarget(null)}
          startReason={KEY_FIRST_REASON}
          onSaved={onKeySaved}
        />
      )}
    </>
  ) : null;

  return { showColumn, renderCell, dialog: dialogElement };
}
