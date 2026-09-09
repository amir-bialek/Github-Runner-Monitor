import React from 'react';
import { Box } from '@mui/material';
import { JobResult } from '../types/api';

const STYLES: Record<JobResult, { symbol: string; label: string }> = {
  success: { symbol: '✓', label: 'Success' },
  failure: { symbol: '✕', label: 'Failed' },
  cancelled: { symbol: '⊘', label: 'Cancelled' },
  timed_out: { symbol: '⏱', label: 'Timed out' },
  other: { symbol: '•', label: 'Other' },
};

export function resultLabel(result: JobResult): string {
  return (STYLES[result] ?? STYLES.other).label;
}

interface StatusBadgeProps {
  result: JobResult;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ result }) => {
  const style = STYLES[result] ?? STYLES.other;
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      <span aria-hidden="true">{style.symbol}</span>
      {style.label}
    </Box>
  );
};

export default StatusBadge;
