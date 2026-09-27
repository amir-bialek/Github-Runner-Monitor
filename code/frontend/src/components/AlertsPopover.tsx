import React, { useMemo } from 'react';
import { Box, Divider, Link, Popover, SvgIcon, Typography } from '@mui/material';
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
  <SvgIcon viewBox="0 0 24 24" color="error" sx={{ fontSize: 22 }} aria-hidden>
    <path
      d="M12 3.5 2.5 20h19L12 3.5z"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinejoin="round"
    />
    <path d="M10.8 9h2.4l-.4 6h-1.6l-.4-6zm1.2 7.3a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z" fill="currentColor" />
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
      <Box sx={{ px: 2, py: 1, display: 'flex', justifyContent: 'flex-end' }}>
        <Link component="button" variant="body2" underline="hover" onClick={onOpenSettings}>
          Alert settings
        </Link>
      </Box>
    </Popover>
  );
};

export default AlertsPopover;
