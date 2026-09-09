import React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { formatAgo } from '../utils/format';

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  isFetching?: boolean;
  variant?: 'h5' | 'h6';
  action?: React.ReactNode;
  updatedAt?: number;
  now?: number;
  refreshSeconds?: number | null;
}

function refreshHint(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return `Refreshes every ${rounded === 1 ? '1 second' : `${rounded} seconds`}`;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  subtitle,
  isFetching,
  variant = 'h6',
  action,
  updatedAt,
  now,
  refreshSeconds,
}) => (
  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 2, flexWrap: 'wrap' }}>
    <Typography variant={variant} component="h2" sx={{ fontWeight: 700 }}>
      {title}
    </Typography>
    {subtitle && (
      <Typography variant="body2" color="text.secondary">
        {subtitle}
      </Typography>
    )}
    {isFetching && <CircularProgress size={14} thickness={5} aria-label="Refreshing" />}
    {action}
    {updatedAt !== undefined && updatedAt > 0 && now !== undefined && (
      <Typography
        variant="caption"
        color="text.secondary"
        title={refreshSeconds ? refreshHint(refreshSeconds) : undefined}
        sx={{ ml: 'auto' }}
      >
        {`Updated ${formatAgo(now - updatedAt)}`}
      </Typography>
    )}
  </Box>
);

export default SectionHeader;
