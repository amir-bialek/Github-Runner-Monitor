import React, { useState } from 'react';
import { Alert, AlertTitle, Box, Button, Stack, Typography } from '@mui/material';
import type { MonitorAlert } from '../types/api';
import { formatCompactDuration } from '../utils/format';
import ExternalLink from './ExternalLink';
import { repositoryShortName } from '../utils/repository';

interface AlertBannerProps {
  alerts: MonitorAlert[];
  now: number;
  onOpenSettings: () => void;
}

const VISIBLE_JOBS = 3;

function sinceLabel(alert: MonitorAlert, now: number): string {
  const since = new Date(alert.since).getTime();
  if (!Number.isFinite(since)) return '';
  const duration = formatCompactDuration(Math.max(0, now - since));
  return alert.kind === 'runner_group_offline'
    ? `No runners online for ${duration}`
    : `Oldest job waiting ${duration}`;
}

const AlertJobs: React.FC<{ alert: MonitorAlert; now: number }> = ({ alert, now }) => {
  const [expanded, setExpanded] = useState(false);
  const jobs = alert.jobs ?? [];
  if (jobs.length === 0) return null;
  const shown = expanded ? jobs : jobs.slice(0, VISIBLE_JOBS);
  const hidden = (alert.jobCount ?? jobs.length) - shown.length;

  return (
    <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
      {shown.map((job) => (
        <Typography component="li" variant="body2" key={job.id}>
          <ExternalLink href={job.htmlUrl} label={job.name} color="inherit" underline="always">
            {job.name}
          </ExternalLink>
          {` in ${repositoryShortName(job.repository)} — waiting ${formatCompactDuration(now - new Date(job.createdAt).getTime())}`}
        </Typography>
      ))}
      {(hidden > 0 || expanded) && jobs.length > VISIBLE_JOBS && (
        <Box component="li" sx={{ listStyle: 'none', ml: -1 }}>
          <Button size="small" color="inherit" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Show fewer' : `Show ${hidden} more`}
          </Button>
        </Box>
      )}
    </Box>
  );
};

const AlertBanner: React.FC<AlertBannerProps> = ({ alerts, now, onOpenSettings }) => {
  if (alerts.length === 0) return null;

  return (
    <Stack component="section" aria-label="Active alerts" spacing={1} sx={{ mb: 3 }}>
      {alerts.map((alert) => {
        const offline = alert.kind === 'runner_group_offline';
        return (
          <Alert
            key={alert.id}
            severity={offline ? 'error' : 'warning'}
            variant="outlined"
            role="alert"
            action={
              <Button color="inherit" size="small" onClick={onOpenSettings}>
                Alert settings
              </Button>
            }
          >
            <AlertTitle sx={{ fontWeight: 700 }}>
              {offline ? 'Runner group offline' : 'Jobs stuck in the queue'}
            </AlertTitle>
            <Typography variant="body2">{alert.message}</Typography>
            <Typography variant="caption" sx={{ display: 'block', opacity: 0.85 }}>
              {sinceLabel(alert, now)}
            </Typography>
            {!offline && <AlertJobs alert={alert} now={now} />}
          </Alert>
        );
      })}
    </Stack>
  );
};

export default AlertBanner;
