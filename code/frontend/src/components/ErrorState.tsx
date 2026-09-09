import React from 'react';
import { Alert, AlertTitle, Box, Button, Typography } from '@mui/material';

interface ErrorStateProps {
  title: string;
  message?: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
  prominent?: boolean;
}

const ErrorState: React.FC<ErrorStateProps> = ({
  title,
  message,
  detail,
  onRetry,
  retryLabel = 'Try again',
  prominent = false,
}) => {
  return (
    <Alert
      severity="error"
      role={prominent ? 'alert' : 'status'}
      sx={{ mt: 2 }}
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>{title}</AlertTitle>
      {message && <Box sx={{ mb: detail ? 0.5 : 0 }}>{message}</Box>}
      {detail && (
        <Typography variant="caption" sx={{ display: 'block', opacity: 0.8 }}>
          {detail}
        </Typography>
      )}
    </Alert>
  );
};

export default ErrorState;
