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
} from '@mui/material';
import { HistoryJob } from '../types/api';
import {
  formatCompactDuration,
  formatDuration,
  formatFullTimestamp,
  formatShortDateTime,
  parseTimestamp,
} from '../utils/format';
import { HISTORY_PAGE_SIZE } from '../appConfig';
import { MISSING_TEXT, orUnknown } from '../utils/labels';
import { SortValue, sortRows, useTableSort } from '../utils/sorting';
import SectionHeader from './SectionHeader';
import EmptyState from './EmptyState';
import ErrorState from './ErrorState';
import ExternalLink from './ExternalLink';
import RepositoryPath, { repositoryPathText } from './RepositoryPath';
import SortableHeadCell from './SortableHeadCell';
import StatusBadge, { resultLabel } from './StatusBadge';
import TableSkeleton from './TableSkeleton';
import TablePager, { usePage } from './TablePager';

interface HistorySectionProps {
  filterKey: string;
  items: HistoryJob[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  onRetry: () => void;
  now: number;
  updatedAt: number;
  refreshSeconds: number;
  showScaleSetColumn: boolean;
}

export const HISTORY_ROWS_PER_PAGE = HISTORY_PAGE_SIZE;

type HistoryColumn =
  | 'result'
  | 'repository'
  | 'job'
  | 'triggeredBy'
  | 'scaleSet'
  | 'duration'
  | 'finishedAt';

function historySortValue(job: HistoryJob, column: HistoryColumn): SortValue {
  switch (column) {
    case 'result':
      return job.result;
    case 'repository':
      return repositoryPathText(job.repository, job.branch);
    case 'job':
      return job.name;
    case 'triggeredBy':
      return job.actor?.login ?? null;
    case 'scaleSet':
      return job.scaleSet;
    case 'duration':
      return job.durationMs;
    case 'finishedAt': {
      const completedAt = parseTimestamp(job.completedAt);
      return completedAt ? completedAt.getTime() : null;
    }
  }
}

function historyDefaultDirection(column: HistoryColumn) {
  return column === 'finishedAt' || column === 'duration' ? ('desc' as const) : ('asc' as const);
}

const HistorySection: React.FC<HistorySectionProps> = ({
  filterKey,
  items,
  isLoading,
  isFetching,
  error,
  onRetry,
  now,
  updatedAt,
  refreshSeconds,
  showScaleSetColumn,
}) => {
  const { sort, toggle } = useTableSort<HistoryColumn>(
    { column: 'finishedAt', direction: 'desc' },
    historyDefaultDirection,
  );

  const tableRef = useRef<HTMLDivElement>(null);
  // A pool filter hides the scale-set column. Ordering by a column nobody can
  // see leaves rows in an order nothing on screen explains, so fall back.
  const effectiveSort =
    !showScaleSetColumn && sort.column === 'scaleSet'
      ? { column: 'finishedAt' as HistoryColumn, direction: 'desc' as const }
      : sort;
  const ordered = sortRows(items, effectiveSort, historySortValue);
  const { visible, page, setPage, showAll, setShowAll } = usePage(
    ordered,
    HISTORY_ROWS_PER_PAGE,
    `${filterKey}:${effectiveSort.column}:${effectiveSort.direction}`,
  );

  return (
    <Box component="section" sx={{ mb: 2 }}>
      <SectionHeader
        title="Recent history"
        subtitle={!isLoading && !error ? `last ${items.length} finished` : undefined}
        isFetching={isFetching && !isLoading}
        variant="h6"
        updatedAt={updatedAt}
        now={now}
        refreshSeconds={refreshSeconds}
      />

      {isLoading && <TableSkeleton rows={Math.min(HISTORY_ROWS_PER_PAGE, 8)} rowHeight={36} />}

      {!isLoading && error && (
        <ErrorState
          title="Couldn't load job history"
          message="Recent finished jobs could not be fetched just now."
          detail={error.message}
          onRetry={onRetry}
        />
      )}

      {!isLoading && !error && items.length === 0 && (
        <EmptyState title="Nothing ran recently" detail="No job has run in the past week." />
      )}

      {!isLoading && !error && visible.length > 0 && (
        <>
          <TableContainer ref={tableRef} component={Paper} variant="outlined">
            <Table size="small" aria-label="Job history">
              <TableHead>
                <TableRow>
                  <SortableHeadCell column="result" label="Result" sort={effectiveSort} onSort={toggle} />
                  <SortableHeadCell
                    column="repository"
                    label="Repository / branch"
                    sort={effectiveSort}
                    onSort={toggle}
                  />
                  <SortableHeadCell column="job" label="Job" sort={effectiveSort} onSort={toggle} />
                  <SortableHeadCell column="triggeredBy" label="Triggered by" sort={effectiveSort} onSort={toggle} />
                  {showScaleSetColumn && (
                    <SortableHeadCell column="scaleSet" label="Scale set" sort={effectiveSort} onSort={toggle} />
                  )}
                  <SortableHeadCell column="duration" label="Duration" sort={effectiveSort} onSort={toggle} />
                  <SortableHeadCell
                    column="finishedAt"
                    label="Finished at"
                    sort={effectiveSort}
                    onSort={toggle}
                    sx={{ whiteSpace: 'nowrap' }}
                  />
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map((job) => {
                  const completedAt = parseTimestamp(job.completedAt);
                  return (
                    <TableRow key={job.id} hover>
                      <TableCell>
                        <StatusBadge result={job.result} />
                      </TableCell>
                      <TableCell sx={{ maxWidth: 300, overflowWrap: 'anywhere' }}>
                        <RepositoryPath repository={job.repository} branch={job.branch} />
                      </TableCell>
                      <TableCell>
                        <ExternalLink
                          href={job.htmlUrl}
                          label={`Job ${job.name} in ${job.repository}, ${resultLabel(job.result)}`}
                        >
                          {job.name}
                        </ExternalLink>
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{orUnknown(job.actor?.login)}</TableCell>
                      {showScaleSetColumn && <TableCell>{orUnknown(job.scaleSet)}</TableCell>}
                      <TableCell
                        title={job.durationMs === null ? undefined : `Ran for ${formatDuration(job.durationMs)}`}
                        sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                      >
                        {job.durationMs === null ? MISSING_TEXT : formatCompactDuration(job.durationMs)}
                      </TableCell>
                      <TableCell
                        title={completedAt ? formatFullTimestamp(completedAt) : undefined}
                        sx={{ whiteSpace: 'nowrap' }}
                      >
                        {completedAt ? formatShortDateTime(completedAt) : MISSING_TEXT}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>

          <TablePager
            label="Recent history"
            count={ordered.length}
            page={page}
            pageSize={HISTORY_ROWS_PER_PAGE}
            showAll={showAll}
            onPageChange={setPage}
            onShowAllChange={setShowAll}
            scrollTargetRef={tableRef}
          />
        </>
      )}
    </Box>
  );
};

export default HistorySection;
