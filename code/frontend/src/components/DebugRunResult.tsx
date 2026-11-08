// The result of a finished or failed debug run (story 3.12), shown in the run
// dialog under the progress: explanation, cause, changed files, the patch with
// Copy and Download, and the requester's rating. Every string from the backend
// renders as a React text node; the patch is split into lines, never parsed as
// HTML or markdown.
//
// Fix pull requests (story 4.3): inside the patch section, one row per
// repository of the backend's patch check: the link of an opened fix pull
// request, the broken rule of a refused part, or an Open a PR button when the
// backend offers it to this viewer. The patch, Copy and Download stay visible.
import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { useDebugRunResult, useOpenFixPullRequest, useSaveDebugFeedback } from '../hooks/useDebugRuns';
import type {
  DebugCauseLocation,
  DebugFeedbackRating,
  DebugFixPullRequest,
  DebugPatchCheck,
  DebugRunFeedback,
  DebugRunResultView,
} from '../types/api';
import ExternalLink from './ExternalLink';
import { formatDuration } from '../utils/format';
import { patchFiles, patchLineKinds, patchLines, type PatchLineKind } from '../utils/patch';

export const COMMENT_MAX = 2000;

export function causeLabel(cause: DebugCauseLocation | null | undefined): string {
  switch (cause?.kind) {
    case 'this-repository':
      return 'This repository';
    case 'extra-repository':
      return `Extra repository ${cause.repository}`;
    case 'workflow-file':
      return 'The workflow file';
    case 'runner':
      return 'The runner or runner image';
    case 'infrastructure':
      return 'Infrastructure';
    default:
      return 'Unknown';
  }
}

const formatUsd = (value: number): string => `$${(Number.isFinite(value) ? value : 0).toFixed(2)}`;

const lineColor = (kind: PatchLineKind) => (theme: Theme) => {
  if (kind === 'context') return undefined;
  const palette = kind === 'added' ? theme.palette.success : theme.palette.error;
  return theme.palette.mode === 'dark' ? palette.light : palette.dark;
};

const Heading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700 }}>
    {children}
  </Typography>
);

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <Typography variant="body2">
    <Box component="span" sx={{ fontWeight: 700 }}>
      {label}
    </Box>{' '}
    {children}
  </Typography>
);

const PatchBlock: React.FC<{ patch: string }> = ({ patch }) => {
  const lines = patchLines(patch);
  const kinds = patchLineKinds(lines);
  return (
    <Box
      component="pre"
      aria-label="Patch"
      tabIndex={0}
      sx={{
        m: 0,
        p: 1.5,
        maxHeight: 360,
        overflow: 'auto',
        fontFamily: 'monospace',
        fontSize: '0.8125rem',
        lineHeight: 1.5,
        bgcolor: 'action.hover',
        borderRadius: 1,
      }}
    >
      {lines.map((line, index) => {
        const kind = kinds[index] ?? 'context';
        return (
          <React.Fragment key={index}>
            <Box component="span" data-kind={kind} sx={{ color: lineColor(kind) }}>
              {line}
            </Box>
            {'\n'}
          </React.Fragment>
        );
      })}
    </Box>
  );
};

function downloadPatch(runId: string, patch: string): void {
  const blob = new Blob([patch], { type: 'text/x-diff' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `debug-run-${runId}.patch`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Revoked after this task, so the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const sameRepository = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const OpenFixPullRequestButton: React.FC<{ runId: string; repository: string }> = ({ runId, repository }) => {
  const mutation = useOpenFixPullRequest(runId);
  const error = mutation.error as Error | null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Button
          size="small"
          variant="contained"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(repository)}
        >
          Open a PR for {repository}
        </Button>
        {mutation.isPending && <CircularProgress size={18} aria-hidden />}
      </Box>
      {error && !mutation.isPending && <Alert severity="error">{error.message}</Alert>}
    </Box>
  );
};

const FixPullRequestLink: React.FC<{ link: DebugFixPullRequest }> = ({ link }) => (
  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
    Fix pull request for {link.repository}:{' '}
    <ExternalLink href={link.url} label={`Fix pull request for ${link.repository}`}>
      {link.url}
    </ExternalLink>
  </Typography>
);

const FixPullRequests: React.FC<{
  runId: string;
  check: DebugPatchCheck;
  opened: DebugFixPullRequest[];
  offered: string[];
}> = ({ runId, check, opened, offered }) => {
  const repositories = Array.isArray(check.repositories) ? check.repositories : [];
  const rows: React.ReactNode[] = [];
  if (repositories.length === 0 && check.status === 'refused') {
    rows.push(
      <Alert key="whole-patch" severity="warning">
        {check.message ?? 'The patch cannot become a fix pull request.'}
      </Alert>,
    );
  }
  repositories.forEach((part, index) => {
    const key = `${part.repository}-${index}`;
    const link = opened.find((e) => sameRepository(e.repository, part.repository));
    if (link) {
      rows.push(<FixPullRequestLink key={key} link={link} />);
    } else if (part.status === 'refused') {
      rows.push(
        <Alert key={key} severity="warning">
          {part.repository}: {part.message ?? 'This part of the patch cannot become a fix pull request.'}
        </Alert>,
      );
    } else if (offered.some((r) => sameRepository(r, part.repository))) {
      rows.push(<OpenFixPullRequestButton key={key} runId={runId} repository={part.repository} />);
    }
  });
  // Opened pull requests whose part the recomputed check no longer lists keep their link.
  opened.forEach((link, index) => {
    if (!repositories.some((part) => sameRepository(part.repository, link.repository))) {
      rows.push(<FixPullRequestLink key={`opened-${link.repository}-${index}`} link={link} />);
    }
  });
  if (rows.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Heading>Fix pull requests</Heading>
      {rows}
    </Box>
  );
};

const PatchSection: React.FC<{ runId: string; patch: string; view: DebugRunResultView }> = ({ runId, patch, view }) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const files = patchFiles(patch);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('No clipboard');
      await navigator.clipboard.writeText(patch);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  if (patch.trim() === '') {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Heading>Patch</Heading>
        <Typography variant="body2">No change was proposed.</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {files.length > 0 && (
        <>
          <Heading>Changed files</Heading>
          <Box component="ul" aria-label="Changed files" sx={{ m: 0, pl: 3 }}>
            {files.map((file) => (
              <Typography key={file} component="li" variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {file}
              </Typography>
            ))}
          </Box>
        </>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Heading>Patch</Heading>
        <Box sx={{ flexGrow: 1 }} />
        <Button size="small" variant="outlined" onClick={() => void copy()}>
          Copy
        </Button>
        <Button size="small" variant="outlined" onClick={() => downloadPatch(runId, patch)}>
          Download .patch
        </Button>
      </Box>
      <Box role="status" aria-live="polite">
        {copyState === 'copied' && <Typography variant="body2">Copied</Typography>}
        {copyState === 'failed' && (
          <Typography variant="body2" color="error">
            The patch could not be copied.
          </Typography>
        )}
      </Box>
      <PatchBlock patch={patch} />
      <Typography variant="body2" color="text.secondary">
        This patch was written without running any command or test.
      </Typography>
      {view.patchCheck && (
        <FixPullRequests
          runId={runId}
          check={view.patchCheck}
          // Only links to github.com are shown.
          opened={(Array.isArray(view.fixPullRequests) ? view.fixPullRequests : []).filter(
            (e) => typeof e?.url === 'string' && e.url.startsWith('https://github.com/'),
          )}
          offered={Array.isArray(view.canOpenPullRequest) ? view.canOpenPullRequest : []}
        />
      )}
    </Box>
  );
};

const FeedbackForm: React.FC<{ runId: string; saved: DebugRunFeedback | null }> = ({ runId, saved }) => {
  const [rating, setRating] = useState<DebugFeedbackRating | null>(saved?.rating ?? null);
  const [comment, setComment] = useState(saved?.comment ?? '');
  const [thanked, setThanked] = useState(false);
  const mutation = useSaveDebugFeedback(runId);
  const error = mutation.error as Error | null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!rating) return;
    setThanked(false);
    mutation.mutate(
      { rating, comment: comment.trim() === '' ? null : comment },
      { onSuccess: () => setThanked(true) },
    );
  };

  return (
    <Box
      component="form"
      aria-label="Rate this result"
      onSubmit={submit}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      <Heading>Was this result useful?</Heading>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={rating}
        aria-label="Rating"
        onChange={(_event, value: DebugFeedbackRating | null) => {
          if (value) setRating(value);
          setThanked(false);
        }}
      >
        <ToggleButton value="useful">Useful</ToggleButton>
        <ToggleButton value="not-useful">Not useful</ToggleButton>
      </ToggleButtonGroup>
      <TextField
        label="Comment (optional)"
        multiline
        minRows={2}
        value={comment}
        onChange={(event) => {
          setComment(event.target.value.slice(0, COMMENT_MAX));
          setThanked(false);
        }}
        slotProps={{ htmlInput: { maxLength: COMMENT_MAX } }}
        helperText={`${comment.length}/${COMMENT_MAX}`}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Button type="submit" variant="contained" disabled={!rating || mutation.isPending}>
          Save
        </Button>
        {mutation.isPending && <CircularProgress size={18} aria-hidden />}
      </Box>
      <Box role="status" aria-live="polite">
        {thanked && <Typography variant="body2">Thanks, your rating was saved.</Typography>}
      </Box>
      {error && <Alert severity="error">{error.message}</Alert>}
    </Box>
  );
};

const ResultBody: React.FC<{ runId: string; view: DebugRunResultView }> = ({ runId, view }) => {
  const result = view.result;
  if (!result) return null;
  const downloads = Array.isArray(view.downloads) ? view.downloads : [];
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Heading>Explanation</Heading>
        <Typography variant="body2" component="div" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {result.explanation}
        </Typography>
      </Box>

      <Fact label="Cause:">{causeLabel(result.causeLocation)}</Fact>

      <PatchSection runId={runId} patch={typeof result.patch === 'string' ? result.patch : ''} view={view} />

      {downloads.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Heading>Repositories downloaded</Heading>
          <Box component="ul" aria-label="Repositories downloaded" sx={{ m: 0, pl: 3 }}>
            {downloads.map((download, index) => (
              <Typography key={`${download.repository}-${index}`} component="li" variant="body2">
                {download.repository}
                {download.commitSha ? ' at ' : ''}
                {download.commitSha ? (
                  <Box component="span" sx={{ fontFamily: 'monospace' }}>
                    {download.commitSha.slice(0, 7)}
                  </Box>
                ) : null}
              </Typography>
            ))}
          </Box>
        </Box>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Fact label="Cost:">{formatUsd(result.costUsd)}</Fact>
        <Fact label="Time taken:">{formatDuration(result.durationMs)}</Fact>
        {result.logTruncated && (
          <Typography variant="body2" color="text.secondary">
            The log was cut to its last part.
          </Typography>
        )}
      </Box>

      {view.canGiveFeedback && <FeedbackForm runId={runId} saved={view.feedback} />}
    </Box>
  );
};

interface DebugRunResultProps {
  runId: string;
  /** Whether the run is in a final state; the result is asked for only then. */
  enabled: boolean;
}

const DebugRunResult: React.FC<DebugRunResultProps> = ({ runId, enabled }) => {
  const query = useDebugRunResult(runId, enabled);
  if (!enabled) return null;
  const error = query.error as Error | null;
  if (error && !query.data) return <Alert severity="error">{error.message}</Alert>;
  if (!query.data) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <CircularProgress size={20} aria-hidden />
        <Typography>Loading the result…</Typography>
      </Box>
    );
  }
  return (
    <>
      {error && <Alert severity="warning">{error.message}</Alert>}
      <ResultBody runId={runId} view={query.data} />
    </>
  );
};

export default DebugRunResult;
