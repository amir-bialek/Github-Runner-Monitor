import React from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useDebugItUsage } from '../hooks/useDebugItSettings';

const HEADING_ID = 'usage-this-month-heading';

const formatUsd = (value: number): string => `$${(Number.isFinite(value) ? value : 0).toFixed(2)}`;

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() ? message : 'Something went wrong talking to the monitor.';
}

/** Runs, cost and fix pull requests of the current UTC month, per user (story 3.13). */
const DebugItUsageSection: React.FC = () => {
  const query = useDebugItUsage();
  const data = query.data;
  const cap = typeof data?.monthlyCap === 'number' ? data.monthlyCap : null;

  return (
    <Paper component="section" aria-labelledby={HEADING_ID} variant="outlined" sx={{ p: 2.5 }}>
      <Typography id={HEADING_ID} variant="h6" component="h3" sx={{ fontSize: 16, fontWeight: 600 }}>
        Usage this month
      </Typography>

      {query.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} aria-label="Loading Debug it usage" />
        </Box>
      ) : !data ? (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {messageOf(query.error)}
        </Alert>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {`Runs, cost and fix pull requests of ${data.month} (UTC).`}
          </Typography>
          {data.credentialsMode === 'personal' ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Runs use personal keys, so there is no monthly cap.
            </Typography>
          ) : null}
          {data.users.length === 0 ? (
            <Typography variant="body2" sx={{ py: 1, mt: 1 }}>
              Nobody has used Debug it this month.
            </Typography>
          ) : (
            <TableContainer sx={{ mt: 1.5 }}>
              <Table size="small" aria-label="Usage this month">
                <TableHead>
                  <TableRow>
                    <TableCell>User</TableCell>
                    <TableCell align="right">Runs</TableCell>
                    <TableCell align="right">Cost</TableCell>
                    <TableCell align="right">Fix pull requests</TableCell>
                    {cap !== null ? <TableCell align="right">Monthly cap</TableCell> : null}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.users.map((row) => (
                    <TableRow key={row.githubUserId}>
                      <TableCell sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                        {row.login ?? `user ID ${row.githubUserId}`}
                      </TableCell>
                      <TableCell align="right">{String(row.runs)}</TableCell>
                      <TableCell align="right">{formatUsd(row.costUsd)}</TableCell>
                      <TableCell align="right">{String(row.fixPullRequests)}</TableCell>
                      {cap !== null ? <TableCell align="right">{`${row.runs} of ${cap}`}</TableCell> : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}
    </Paper>
  );
};

export default DebugItUsageSection;
