import React, { useEffect, useRef, useState } from 'react';
import { Box, Button, TablePagination } from '@mui/material';

// One page of rows, plus the arrows under the table. All three sections page
// the same way, so the sizes live in appConfig and the behaviour lives here.
export function usePage<T>(rows: T[], pageSize: number, resetKey: unknown) {
  const [page, setPage] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  // Only a deliberate change — a different sort, a different pool — goes back
  // to the first page. The fifteen second refetch must not move someone who is
  // in the middle of reading page three.
  useEffect(() => {
    setPage(0);
  }, [resetKey]);

  // A list that shrank can leave the page past its end.
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const current = Math.min(page, pageCount - 1);
  const start = current * pageSize;

  return {
    visible: showAll ? rows : rows.slice(start, start + pageSize),
    page: current,
    setPage,
    showAll,
    setShowAll,
  };
}

interface TablePagerProps {
  label: string;
  count: number;
  page: number;
  pageSize: number;
  showAll: boolean;
  onPageChange: (page: number) => void;
  onShowAllChange: (showAll: boolean) => void;
  scrollTargetRef?: React.RefObject<HTMLElement | null>;
}

const TablePager: React.FC<TablePagerProps> = ({
  label,
  count,
  page,
  pageSize,
  showAll,
  onPageChange,
  onShowAllChange,
  scrollTargetRef,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const focusAfterChange = useRef<'previous' | 'next' | null>(null);
  const lastPage = Math.max(0, Math.ceil(count / pageSize) - 1);

  // Paging to the last page disables the button that was just pressed, which
  // drops focus onto the body. Hand it to the other arrow instead.
  useEffect(() => {
    const wanted = focusAfterChange.current;
    focusAfterChange.current = null;
    if (!wanted || !rootRef.current) return;
    const button = rootRef.current.querySelector<HTMLButtonElement>(
      `button[aria-label="Go to ${wanted} page"]`,
    );
    if (button && !button.disabled) button.focus();
  }, [page]);

  if (count <= pageSize) return null;

  const changePage = (nextPage: number) => {
    if (nextPage > page && nextPage >= lastPage) focusAfterChange.current = 'previous';
    if (nextPage < page && nextPage === 0) focusAfterChange.current = 'next';
    onPageChange(nextPage);
    scrollTargetRef?.current?.scrollIntoView({ block: 'start' });
  };

  const first = page * pageSize + 1;
  const last = Math.min(count, (page + 1) * pageSize);

  return (
    <Box
      ref={rootRef}
      component="nav"
      aria-label={`${label} pages`}
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}
    >
      <Button size="small" onClick={() => onShowAllChange(!showAll)}>
        {showAll ? 'Show pages' : `Show all ${count}`}
      </Button>

      {/* Paging is a click, not a navigation, so nothing else announces it. */}
      <Box role="status" aria-live="polite" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        {showAll ? `${label}: all ${count} shown` : `${label}: ${first} to ${last} of ${count}`}
      </Box>

      {!showAll && (
        <TablePagination
          component="div"
          count={count}
          page={page}
          onPageChange={(_event, nextPage) => changePage(nextPage)}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[pageSize]}
          labelRowsPerPage="Rows per page"
        />
      )}
    </Box>
  );
};

export default TablePager;
