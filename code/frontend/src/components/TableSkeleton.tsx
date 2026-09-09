import React from 'react';
import { Box, Paper, Skeleton } from '@mui/material';

interface TableSkeletonProps {
  rows: number;
  rowHeight?: number;
  headerHeight?: number;
}

const TableSkeleton: React.FC<TableSkeletonProps> = ({ rows, rowHeight = 43, headerHeight = 36 }) => (
  <Paper
    variant="outlined"
    aria-hidden="true"
    sx={{ px: 2, minHeight: headerHeight + rows * rowHeight, boxSizing: 'border-box' }}
  >
    <Box sx={{ height: headerHeight, display: 'flex', alignItems: 'center' }}>
      <Skeleton width="35%" height={18} />
    </Box>
    {Array.from({ length: rows }).map((_, index) => (
      <Box
        key={index}
        sx={{
          height: rowHeight,
          display: 'flex',
          alignItems: 'center',
          borderTop: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Skeleton width={`${75 - (index % 3) * 12}%`} height={18} />
      </Box>
    ))}
  </Paper>
);

export default TableSkeleton;
