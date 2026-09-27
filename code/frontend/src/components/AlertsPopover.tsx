import React, { useMemo } from 'react';
import { Box, Button, Divider, Popover, SvgIcon, Typography } from '@mui/material';
import type { MonitorAlert } from '../types/api';
import { formatCompactDuration } from '../utils/format';
import ExternalLink from './ExternalLink';
import TablePager, { usePage } from './TablePager';

interface AlertsPopoverProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onOpenSettings: () => void;
  alerts: MonitorAlert[];
  now: number;
}

const LINES_PER_PAGE = 10;

interface AlertLine {
  key: string;
  content: React.ReactNode;
}

const WarningIcon: React.FC = () => (
  <SvgIcon viewBox="0 0 24 24" sx={{ fontSize: 20, color: 'text.secondary' }} aria-hidden>
    <path d="M12 2 1 21h22L12 2zm0 4.2L19.5 19h-15L12 6.2zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z" />
  </SvgIcon>
);

function elapsed(from: string, now: number): string {
  const start = new Date(from).getTime();
  return formatCompactDuration(Number.isFinite(start) ? Math.max(0, now - start) : 0);
}

function linesFor(alerts: MonitorAlert[], now: number): AlertLine[] {
  const lines: AlertLine[] = [];
  for (const alert of alerts) {
    if (alert.kind === 'runner_group_offline') {
      const issue =
        alert.totalRunners === 0
          ? 'had no runners registered'
          : `had no online runners (0 of ${alert.totalRunners})`;
      lines.push({
        key: alert.id,
        content: `Runner group ${alert.scaleSet} has ${issue} for ${elapsed(alert.since, now)}.`,
      });
      continue;
    }
    for (const job of alert.jobs ?? []) {
      lines.push({
        key: `${alert.id}:${job.id}`,
        content: (
          <>
            {'Job '}
            <ExternalLink href={job.htmlUrl} label={job.name}>
              {job.name}
            </ExternalLink>
            {` is waiting for ${elapsed(job.createdAt, now)}.`}
          </>
        ),
      });
    }
  }
  return lines;
}

const AlertsPopover: React.FC<AlertsPopoverProps> = ({ anchorEl, onClose, onOpenSettings, alerts, now }) => {
  const lines = useMemo(() => linesFor(alerts, now), [alerts, now]);
  const { visible, page, setPage, showAll, setShowAll } = usePage(lines, LINES_PER_PAGE, anchorEl);

  return (
    <Popover
      open={Boolean(anchorEl)}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { mt: 1, width: 440, maxWidth: 'calc(100vw - 32px)' } } }}
    >
      <Box component="section" aria-labelledby="alerts-heading" sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <WarningIcon />
          <Typography id="alerts-heading" variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>
            Alerts:
          </Typography>
        </Box>
        {lines.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No active alerts.
          </Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, pl: 3 }}>
            {visible.map((line) => (
              <Typography component="li" variant="body2" key={line.key} sx={{ py: 0.25 }}>
                {line.content}
              </Typography>
            ))}
          </Box>
        )}
        {lines.length > LINES_PER_PAGE && (
          <TablePager
            label="Alerts"
            count={lines.length}
            page={page}
            pageSize={LINES_PER_PAGE}
            showAll={showAll}
            onPageChange={setPage}
            onShowAllChange={setShowAll}
          />
        )}
      </Box>
      <Divider />
      <Box sx={{ px: 1, py: 0.5, display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="small" color="inherit" onClick={onOpenSettings} sx={{ textTransform: 'none' }}>
          Alert settings
        </Button>
      </Box>
    </Popover>
  );
};

export default AlertsPopover;
