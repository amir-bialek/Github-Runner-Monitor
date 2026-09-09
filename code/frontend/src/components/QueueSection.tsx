import React, { useRef } from 'react';
import {
  Box,
  Paper,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { QueueItem } from '../types/api';
import { formatCompactDuration, formatFullTimestamp, parseTimestamp } from '../utils/format';
import { orUnknown } from '../utils/labels';
import { UNKNOWN_QUEUED_FOR_EXPLANATION } from '../utils/scaleSets';
import { SortValue, sortRows, useTableSort } from '../utils/sorting';
import { useStatusColors } from '../theme';
import SectionHeader from './SectionHeader';
import EmptyState from './EmptyState';
import ErrorState from './ErrorState';
import ExternalLink from './ExternalLink';
import BranchLink from './BranchLink';
import RepositoryLink from './RepositoryLink';
import { repositoryShortName } from '../utils/repository';
import SortableHeadCell from './SortableHeadCell';
import TableSkeleton from './TableSkeleton';
import TablePager, { usePage } from './TablePager';
import { QUEUE_PAGE_SIZE } from '../appConfig';

interface QueueSectionProps {
  filterKey: string;
  items: QueueItem[];
  total?: number;
  note: string | undefined;
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

type QueueColumn = 'job' | 'repository' | 'branch' | 'triggeredBy' | 'queuedFor' | 'waiting';

export const UNKNOWN_QUEUED_FOR = 'Unknown';

function queueSortValue(item: QueueItem, column: QueueColumn): SortValue {
  switch (column) {
    case 'job':
      return item.name;
    case 'repository':
      return repositoryShortName(item.repository);
    case 'branch':
      return item.branch || null;
    case 'triggeredBy':
      return item.actor?.login ?? null;
    case 'queuedFor':
      return item.scaleSet ?? UNKNOWN_QUEUED_FOR;
    case 'waiting':
      return item.waitMs;
  }
}

function queueDefaultDirection(column: QueueColumn) {
  return column === 'waiting' ? ('desc' as const) : ('asc' as const);
}

const QueueSection: React.FC<QueueSectionProps> = ({
  filterKey,
  items,
  total,
  note,
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
  const statusColors = useStatusColors();
  const { sort, toggle } = useTableSort<QueueColumn>(
    { column: 'waiting', direction: 'desc' },
    queueDefaultDirection,
  );

  const tableRef = useRef<HTMLDivElement>(null);
  // A pool filter hides the queued-for column. Ordering by a column nobody can
  // see leaves rows in an order nothing on screen explains, so fall back.
  const effectiveSort =
    !showScaleSetColumn && sort.column === 'queuedFor'
      ? { column: 'waiting' as QueueColumn, direction: 'desc' as const }
      : sort;
  const ordered = sortRows(items, effectiveSort, queueSortValue);
  const { visible: rows, page, setPage, showAll, setShowAll } = usePage(
    ordered,
    QUEUE_PAGE_SIZE,
    `${filterKey}:${effectiveSort.column}:${effectiveSort.direction}`,
  );
  const hasUnknownPool = items.some((item) => item.scaleSet === null);

  return (
    <Box component="section" sx={{ mb: 6 }}>
      <SectionHeader
        title="Job queue"
        subtitle={!isLoading && !error ? `${total ?? items.length} waiting` : undefined}
        isFetching={isFetching && !isLoading}
        variant="h5"
        updatedAt={updatedAt}
        now={now}
        refreshSeconds={refreshSeconds}
      />

      {!isLoading && !error && items.length > 0 && (
        <Box sx={{ mb: 2.5 }}>
          {note && (
            <Typography variant="body2" color="text.secondary">
              {note}
            </Typography>
          )}
          {total !== undefined && total > items.length && (
            <Typography variant="body2" color="text.secondary">
              {`Only the first ${items.length} are listed.`}
            </Typography>
          )}
          {hasUnknownPool && (
            <Typography variant="body2" color="text.secondary">
              {UNKNOWN_QUEUED_FOR_EXPLANATION}
            </Typography>
          )}
        </Box>
      )}

      {isLoading && (
        <Box aria-hidden="true">
          <Skeleton width="55%" height={22} sx={{ mb: 2.5 }} />
          <TableSkeleton rows={Math.min(QUEUE_PAGE_SIZE, 8)} />
        </Box>
      )}

      {!isLoading && error && (
        <ErrorState
          title="Couldn't load the queue"
          message="The queue could not be fetched just now."
          detail={error.message}
          onRetry={onRetry}
        />
      )}

      {!isLoading && !error && items.length === 0 && incomplete && (
        <EmptyState
          title="No jobs found — the list may be short"
          detail="This refresh couldn't check every repository, so waiting jobs may be missing from this list."
        />
      )}

      {!isLoading && !error && items.length === 0 && !incomplete && (
        <EmptyState
          symbol="✓"
          title="No jobs waiting"
          detail="Nothing is queued right now — a new job should pick up a runner right away."
        />
      )}

      {!isLoading && !error && items.length > 0 && (
        <TableContainer ref={tableRef} component={Paper} variant="outlined">
          <Table size="small" aria-label="Job queue">
            <TableHead>
              <TableRow>
                <SortableHeadCell column="job" label="Job" sort={effectiveSort} onSort={toggle} />
                <SortableHeadCell column="repository" label="Repository" sort={effectiveSort} onSort={toggle} />
                <SortableHeadCell column="branch" label="Branch" sort={effectiveSort} onSort={toggle} />
                <SortableHeadCell column="triggeredBy" label="Triggered by" sort={effectiveSort} onSort={toggle} />
                {showScaleSetColumn && (
                  <SortableHeadCell column="queuedFor" label="Queued for" sort={effectiveSort} onSort={toggle} />
                )}
                <SortableHeadCell
                  column="waiting"
                  label="Waiting"
                  sort={effectiveSort}
                  onSort={toggle}
                  sx={{ width: 110 }}
                />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((item) => {
                const createdAt = parseTimestamp(item.createdAt);
                const liveWaitMs = createdAt ? now - createdAt.getTime() : item.waitMs;
                const isNext = item.position === 1 && item.scaleSet !== null;
                return (
                  <TableRow
                    key={item.id}
                    hover
                    sx={
                      isNext
                        ? { '& td:first-of-type': { borderLeft: `3px solid ${statusColors.nextUp}` } }
                        : undefined
                    }
                  >
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <ExternalLink
                          href={item.htmlUrl}
                          label={`Job ${item.name} in ${item.repository}, branch ${orUnknown(item.branch)}`}
                        >
                          {item.name}
                        </ExternalLink>
                        {isNext && (
                          <Box
                            component="span"
                            sx={{
                              bgcolor: statusColors.nextUpChipBg,
                              color: statusColors.nextUpChipFg,
                              borderRadius: '999px',
                              px: 0.75,
                              fontSize: '0.6875rem',
                              fontWeight: 700,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Next up
                          </Box>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 220, overflowWrap: 'anywhere' }}>
                      <RepositoryLink
                        repository={item.repository}
                        repositoryUrl={item.repositoryUrl}
                      />
                    </TableCell>
                    <TableCell sx={{ maxWidth: 220, overflowWrap: 'anywhere' }}>
                      <BranchLink
                        repository={item.repository}
                        repositoryUrl={item.repositoryUrl}
                        branch={item.branch}
                      />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {orUnknown(item.actor?.login)}
                      {item.event && (
                        <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.8125rem' }}>
                          {' · '}
                          {item.event}
                        </Box>
                      )}
                    </TableCell>
                    {showScaleSetColumn && (
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {item.scaleSet ?? UNKNOWN_QUEUED_FOR}
                      </TableCell>
                    )}
                    <TableCell
                      title={createdAt ? `Queued at ${formatFullTimestamp(createdAt)}` : undefined}
                      sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                    >
                      {formatCompactDuration(liveWaitMs)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {!isLoading && !error && items.length > 0 && (
        <TablePager
          label="Job queue"
          count={ordered.length}
          page={page}
          pageSize={QUEUE_PAGE_SIZE}
          showAll={showAll}
          onPageChange={setPage}
          onShowAllChange={setShowAll}
          scrollTargetRef={tableRef}
        />
      )}
    </Box>
  );
};

export default QueueSection;
