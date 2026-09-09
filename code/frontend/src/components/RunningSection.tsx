import React, { useRef } from 'react';
import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { RunningJob } from '../types/api';
import {
  formatCompactDuration,
  formatDuration,
  formatFullTimestamp,
  formatShortDateTime,
  parseTimestamp,
} from '../utils/format';
import { MISSING_TEXT, orUnknown } from '../utils/labels';
import { SortValue, sortRows, useTableSort } from '../utils/sorting';
import SectionHeader from './SectionHeader';
import EmptyState from './EmptyState';
import ErrorState from './ErrorState';
import ExternalLink from './ExternalLink';
import RepositoryPath, { repositoryPathText } from './RepositoryPath';
import SortableHeadCell from './SortableHeadCell';
import TableSkeleton from './TableSkeleton';
import TablePager, { usePage } from './TablePager';
import { RUNNING_PAGE_SIZE } from '../appConfig';

interface RunningSectionProps {
  filterKey: string;
  total?: number;
  items: RunningJob[];
  incomplete: boolean;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  onRetry: () => void;
  now: number;
  updatedAt: number;
  refreshSeconds: number;
  showScaleSetColumn: boolean;
}

type RunningColumn = 'repository' | 'job' | 'triggeredBy' | 'scaleSet' | 'startedAt' | 'runningFor';

function runningSortValue(job: RunningJob, column: RunningColumn): SortValue {
  switch (column) {
    case 'repository':
      return repositoryPathText(job.repository, job.branch);
    case 'job':
      return job.name;
    case 'triggeredBy':
      return job.actor?.login ?? null;
    case 'scaleSet':
      return job.scaleSet;
    case 'startedAt':
    case 'runningFor': {
      const startedAt = parseTimestamp(job.startedAt);
      if (!startedAt) return null;
      return column === 'runningFor' ? -startedAt.getTime() : startedAt.getTime();
    }
  }
}

function runningDefaultDirection(column: RunningColumn) {
  return column === 'runningFor' ? ('desc' as const) : ('asc' as const);
}

const RunningSection: React.FC<RunningSectionProps> = ({
  filterKey,
  total,
  items,
  incomplete,
  isLoading,
  isFetching,
  error,
  onRetry,
  now,
  updatedAt,
  refreshSeconds,
  showScaleSetColumn,
}) => {
  const { sort, toggle } = useTableSort<RunningColumn>(
    { column: 'runningFor', direction: 'desc' },
    runningDefaultDirection,
  );

  const tableRef = useRef<HTMLDivElement>(null);
  // A pool filter hides the scale-set column. Ordering by a column nobody can
  // see leaves rows in an order nothing on screen explains, so fall back.
  const effectiveSort =
    !showScaleSetColumn && sort.column === 'scaleSet'
      ? { column: 'runningFor' as RunningColumn, direction: 'desc' as const }
      : sort;
  const ordered = sortRows(items, effectiveSort, runningSortValue);
  const { visible, page, setPage, showAll, setShowAll } = usePage(
    ordered,
    RUNNING_PAGE_SIZE,
    `${filterKey}:${effectiveSort.column}:${effectiveSort.direction}`,
  );

  return (
    <Box component="section" sx={{ mb: 6 }}>
      <SectionHeader
        title="Running jobs"
        subtitle={!isLoading && !error ? `${total ?? ordered.length} running` : undefined}
        isFetching={isFetching && !isLoading}
        updatedAt={updatedAt}
        now={now}
        refreshSeconds={refreshSeconds}
      />

      {isLoading && <TableSkeleton rows={Math.min(RUNNING_PAGE_SIZE, 8)} rowHeight={53} />}

      {!isLoading && !error && total !== undefined && total > ordered.length && (
        <Box sx={{ mb: 2.5 }}>
          <Typography variant="body2" color="text.secondary">
            {`Only the first ${ordered.length} are listed.`}
          </Typography>
        </Box>
      )}

      {!isLoading && error && (
        <ErrorState
          title="Couldn't load running jobs"
          message="The list of jobs on runners could not be fetched just now."
          detail={error.message}
          onRetry={onRetry}
        />
      )}

      {!isLoading && !error && ordered.length === 0 && incomplete && (
        <EmptyState
          title="No running jobs found — the list may be short"
          detail="This refresh couldn't check every repository, so running jobs may be missing from this list."
        />
      )}

      {!isLoading && !error && ordered.length === 0 && !incomplete && (
        <EmptyState title="Nothing running" detail="No job is on a runner right now." />
      )}

      {!isLoading && !error && ordered.length > 0 && (
        <TableContainer ref={tableRef} component={Paper} variant="outlined">
          <Table size="small" aria-label="Running jobs">
            <TableHead>
              <TableRow>
                <SortableHeadCell column="repository" label="Repository / branch" sort={effectiveSort} onSort={toggle} />
                <SortableHeadCell column="job" label="Job" sort={effectiveSort} onSort={toggle} />
                <SortableHeadCell column="triggeredBy" label="Triggered by" sort={effectiveSort} onSort={toggle} />
                {showScaleSetColumn && (
                  <SortableHeadCell column="scaleSet" label="Scale set" sort={effectiveSort} onSort={toggle} />
                )}
                <SortableHeadCell
                  column="startedAt"
                  label="Started at"
                  sort={effectiveSort}
                  onSort={toggle}
                  sx={{ whiteSpace: 'nowrap' }}
                />
                <SortableHeadCell
                  column="runningFor"
                  label="Running for"
                  sort={effectiveSort}
                  onSort={toggle}
                  sx={{ whiteSpace: 'nowrap' }}
                />
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((job) => {
                const startedAt = parseTimestamp(job.startedAt);
                const liveRunningMs = startedAt ? now - startedAt.getTime() : job.runningMs;
                return (
                  <TableRow key={job.id} hover>
                    <TableCell sx={{ maxWidth: 320, overflowWrap: 'anywhere' }}>
                      <RepositoryPath repository={job.repository} branch={job.branch} />
                    </TableCell>
                    <TableCell>
                      <ExternalLink
                        href={job.htmlUrl}
                        label={`Job ${job.name} in ${job.repository}, branch ${orUnknown(job.branch)}`}
                      >
                        {job.name}
                      </ExternalLink>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {orUnknown(job.actor?.login)}
                      {job.event && (
                        <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.8125rem' }}>
                          {' · '}
                          {job.event}
                        </Box>
                      )}
                    </TableCell>
                    {showScaleSetColumn && <TableCell>{orUnknown(job.scaleSet)}</TableCell>}
                    <TableCell
                      title={startedAt ? formatFullTimestamp(startedAt) : undefined}
                      sx={{ whiteSpace: 'nowrap' }}
                    >
                      {startedAt ? formatShortDateTime(startedAt) : MISSING_TEXT}
                    </TableCell>
                    <TableCell
                      title={liveRunningMs === null ? undefined : `Running for ${formatDuration(liveRunningMs)}`}
                      sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                    >
                      {liveRunningMs === null ? MISSING_TEXT : formatCompactDuration(liveRunningMs)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {!isLoading && !error && ordered.length > 0 && (
        <TablePager
          label="Running jobs"
          count={ordered.length}
          page={page}
          pageSize={RUNNING_PAGE_SIZE}
          showAll={showAll}
          onPageChange={setPage}
          onShowAllChange={setShowAll}
          scrollTargetRef={tableRef}
        />
      )}
    </Box>
  );
};

export default RunningSection;
