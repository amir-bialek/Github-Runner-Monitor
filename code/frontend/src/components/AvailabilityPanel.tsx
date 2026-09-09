import React from 'react';
import { Box, Paper, Skeleton, Typography } from '@mui/material';
import { useStatusColors } from '../theme';
import { ScaleSet } from '../types/api';
import SectionHeader from './SectionHeader';
import EmptyState from './EmptyState';
import ErrorState from './ErrorState';

interface AvailabilityPanelProps {
  scaleSets: ScaleSet[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  onRetry: () => void;
  noPoolSelected?: boolean;
  /** The scale set scope switcher, which sits on this section's heading line. */
  action?: React.ReactNode;
  updatedAt?: number;
  now?: number;
  refreshSeconds?: number | null;
}

const Stat: React.FC<{ label: string; value: number; color?: string }> = ({ label, value, color }) => (
  <>
    <Typography component="span" variant="body2" sx={{ color: color ?? 'text.primary' }}>
      {label}:
    </Typography>
    <Typography
      component="span"
      variant="body2"
      sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: color ?? 'text.primary' }}
    >
      {value}
    </Typography>
  </>
);

const ScaleSetCard: React.FC<{ scaleSet: ScaleSet }> = ({ scaleSet }) => {
  const statusColors = useStatusColors();
  const offline = Math.max(scaleSet.totalRunners - scaleSet.online, 0);
  const total = Math.max(scaleSet.totalRunners, 1);

  const summary =
    `${scaleSet.name}: ${scaleSet.totalRunners} total, ${scaleSet.free} available, ` +
    `${scaleSet.busy} working, ${offline} offline`;

  return (
    <Paper
      variant="outlined"
      role="group"
      aria-label={summary}
      sx={{ p: 1.5, width: 340, maxWidth: '100%', flex: '0 1 340px' }}
    >
      <Typography component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>
        {scaleSet.name} : {scaleSet.totalRunners}
      </Typography>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto auto',
          justifyContent: 'start',
          columnGap: 1.5,
          rowGap: 0.25,
          mt: 0.75,
        }}
      >
        <Stat label="Available" value={scaleSet.free} color={statusColors.available} />
        <Stat label="Working" value={scaleSet.busy} />
        <Stat label="Offline" value={offline} color={offline > 0 ? statusColors.offline : undefined} />
      </Box>

      <Box
        aria-hidden="true"
        sx={{
          display: 'flex',
          gap: '2px',
          height: 6,
          borderRadius: 3,
          overflow: 'hidden',
          mt: 1,
          bgcolor: statusColors.barTrack,
        }}
      >
        <Box
          title={`${scaleSet.free} available of ${scaleSet.totalRunners}`}
          sx={{ width: `${(scaleSet.free / total) * 100}%`, bgcolor: statusColors.barAvailable }}
        />
        <Box
          title={`${scaleSet.busy} working of ${scaleSet.totalRunners}`}
          sx={{ width: `${(scaleSet.busy / total) * 100}%`, bgcolor: statusColors.barBusy }}
        />
        <Box
          title={`${offline} offline of ${scaleSet.totalRunners}`}
          sx={{ width: `${(offline / total) * 100}%`, bgcolor: statusColors.barOffline }}
        />
      </Box>
    </Paper>
  );
};

const CARD_MIN_HEIGHT = 148;

const CardSkeleton: React.FC = () => (
  <Paper
    variant="outlined"
    sx={{ p: 1.5, width: 340, maxWidth: '100%', flex: '0 1 340px', minHeight: CARD_MIN_HEIGHT }}
  >
    <Skeleton width="55%" height={28} />
    <Skeleton width="40%" height={20} />
    <Skeleton width="40%" height={20} />
    <Skeleton width="40%" height={20} />
  </Paper>
);

const AvailabilityPanel: React.FC<AvailabilityPanelProps> = ({
  scaleSets,
  isLoading,
  isFetching,
  error,
  onRetry,
  noPoolSelected = false,
  action,
  updatedAt,
  now,
  refreshSeconds,
}) => {
  return (
    <Box component="section" sx={{ mb: 5 }}>
      <SectionHeader
        title="Available runners"
        isFetching={isFetching && !isLoading && !noPoolSelected}
        variant="h6"
        action={action}
        updatedAt={updatedAt}
        now={now}
        refreshSeconds={refreshSeconds}
      />

      {noPoolSelected && <EmptyState title="No runner pool to show for this selection" />}

      {!noPoolSelected && isLoading && (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }} aria-hidden="true">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </Box>
      )}

      {!noPoolSelected && !isLoading && error && (
        <ErrorState title="Couldn't load runner availability" detail={error.message} onRetry={onRetry} />
      )}

      {!noPoolSelected && !isLoading && !error && scaleSets && scaleSets.length === 0 && (
        <EmptyState
          title="No scale sets found"
          detail="No self-hosted runner scale sets are configured for this organization."
        />
      )}

      {!noPoolSelected && !isLoading && !error && scaleSets && scaleSets.length > 0 && (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {scaleSets.map((s) => (
            <ScaleSetCard key={s.id} scaleSet={s} />
          ))}
        </Box>
      )}
    </Box>
  );
};

export default AvailabilityPanel;
