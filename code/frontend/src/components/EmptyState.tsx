import React from 'react';
import { Box, Typography } from '@mui/material';

interface EmptyStateProps {
  symbol?: string;
  title: string;
  detail?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ symbol = '–', title, detail }) => (
  <Box
    sx={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      gap: 0.5,
      py: 4,
      px: 2,
      color: 'text.secondary',
    }}
  >
    <Typography aria-hidden="true" sx={{ fontSize: '1.75rem', lineHeight: 1 }}>
      {symbol}
    </Typography>
    <Typography component="p" variant="subtitle1" sx={{ fontWeight: 600, color: 'text.primary' }}>
      {title}
    </Typography>
    {detail && <Typography variant="body2">{detail}</Typography>}
  </Box>
);

export default EmptyState;
