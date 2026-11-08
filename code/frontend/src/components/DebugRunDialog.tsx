import React, { useId } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Step,
  StepLabel,
  Stepper,
  Typography,
} from '@mui/material';
import { isActiveRun, useDebugRun } from '../hooks/useDebugRuns';
import { useNow } from '../hooks/useNow';
import type { DebugRunState, DebugRunView } from '../types/api';
import { formatDuration } from '../utils/format';
import DebugRunResult from './DebugRunResult';

/**
 * What the dialog shows: a start in flight, a refused start, or a run. A
 * notice (such as "Your personal key works.") shows above a start or a run.
 */
export type DebugRunDialogContent =
  | { kind: 'starting'; notice?: string }
  | { kind: 'refused'; message: string; notice?: string }
  | { kind: 'run'; runId: string; notice?: string };

interface DebugRunDialogProps {
  content: DebugRunDialogContent | null;
  onClose: () => void;
}

export const STATE_WORDS: Record<DebugRunState, string> = {
  waiting: 'Waiting',
  cloning: 'Cloning',
  analyzing: 'Analyzing',
  finished: 'Finished',
  failed: 'Failed',
};

const STEP_INDEX: Record<DebugRunState, number> = { waiting: 0, cloning: 1, analyzing: 2, finished: 4, failed: 3 };

// Every string from the backend is rendered as a text node. Exported as
// DebugRunProgress so the preview page can show it inline (story 3.14).
const RunProgress: React.FC<{ runId: string }> = ({ runId }) => {
  const query = useDebugRun(runId);
  const run: DebugRunView | undefined = query.data;
  const error = query.error as Error | null;
  const active = isActiveRun(run?.state);
  const now = useNow(1000);

  if (!run) {
    if (error) {
      return <Alert severity="error">{error.message}</Alert>;
    }
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <CircularProgress size={20} aria-hidden />
        <Typography>Loading the debug run…</Typography>
      </Box>
    );
  }

  // The answer's elapsed time, plus the local time since that answer while the run is active.
  const since = active && query.dataUpdatedAt > 0 ? Math.max(0, now - query.dataUpdatedAt) : 0;
  const elapsed = (Number.isFinite(run.elapsedMs) ? run.elapsedMs : 0) + since;
  const failed = run.state === 'failed';
  const lastStep = failed ? 'Failed' : 'Finished';
  const steps = ['Waiting', 'Cloning', 'Analyzing', lastStep];
  // Where a failed run stopped is not known, so no step is marked completed.

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        {run.jobName}
        {' in '}
        {run.repository}
      </Typography>

      <Box aria-live="polite" role="status">
        <Typography variant="h6" component="p" sx={{ fontWeight: 700 }}>
          {STATE_WORDS[run.state] ?? run.state}
        </Typography>
      </Box>

      <Stepper activeStep={STEP_INDEX[run.state] ?? 0} alternativeLabel aria-label="Debug run steps">
        {steps.map((label, index) => (
          <Step key={label} completed={!failed && index < (STEP_INDEX[run.state] ?? 0)}>
            <StepLabel error={failed && index === 3}>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {'Elapsed '}
        {formatDuration(elapsed)}
      </Typography>

      {run.state === 'finished' && <Alert severity="success">The debug run finished.</Alert>}
      {failed && (
        <Alert severity="error">{run.failureReason ? run.failureReason : 'The debug run failed.'}</Alert>
      )}
      {error && <Alert severity="warning">{error.message}</Alert>}

      <DebugRunResult runId={run.runId} enabled={run.state === 'finished' || failed} />
    </Box>
  );
};

export { RunProgress as DebugRunProgress };

const DebugRunDialog: React.FC<DebugRunDialogProps> = ({ content, onClose }) => {
  const titleId = useId();
  return (
    <Dialog open={content !== null} onClose={onClose} maxWidth="md" fullWidth aria-labelledby={titleId}>
      <DialogTitle id={titleId} sx={{ fontWeight: 700 }}>
        Debug run
      </DialogTitle>
      <DialogContent dividers>
        {content?.notice && (
          <Alert severity="success" sx={{ mb: 2 }}>
            {content.notice}
          </Alert>
        )}
        {content?.kind === 'starting' && (
          <Box aria-live="polite" role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CircularProgress size={20} aria-hidden />
            <Typography>Starting the debug run…</Typography>
          </Box>
        )}
        {content?.kind === 'refused' && <Alert severity="error">{content.message}</Alert>}
        {content?.kind === 'run' && <RunProgress runId={content.runId} />}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

export default DebugRunDialog;
