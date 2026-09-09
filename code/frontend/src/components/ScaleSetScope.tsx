import React from 'react';
import { Box, MenuItem, Select, SelectChangeEvent, Typography } from '@mui/material';
import { ScaleSet } from '../types/api';
import {
  ALL_SCALE_SETS,
  GITHUB_HOSTED_POOL,
  UNKNOWN_SCALE_SET,
  UNKNOWN_SCALE_SET_LABEL,
} from '../utils/scaleSets';

interface ScaleSetScopeProps {
  scaleSets: ScaleSet[];
  offerUnknownScaleSet: boolean;
  offerGitHubHosted: boolean;
  selected: string;
  onChange: (scaleSet: string) => void;
}

const ScaleSetScope: React.FC<ScaleSetScopeProps> = ({
  scaleSets,
  offerUnknownScaleSet,
  offerGitHubHosted,
  selected,
  onChange,
}) => (
  // "Scope" rather than a bare pool name: the choice filters every section on
  // the page, not just the runner cards it happens to sit beside.
  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
    <Typography variant="body2" color="text.secondary">
      Scope:
    </Typography>
    <Select
      variant="standard"
      id="scale-set-filter"
      name="scaleSet"
      value={selected}
      onChange={(event: SelectChangeEvent) => onChange(event.target.value)}
      inputProps={{ 'aria-label': 'Scale set' }}
      sx={{
        color: 'text.secondary',
        fontSize: '0.875rem',
        '& .MuiSelect-select': { py: 0.25, pl: 0.5 },
      }}
    >
      <MenuItem value={ALL_SCALE_SETS}>All scale sets</MenuItem>
      {scaleSets.map((s) => (
        <MenuItem key={s.id} value={s.id}>
          {s.name}
        </MenuItem>
      ))}
      {(offerGitHubHosted || selected === GITHUB_HOSTED_POOL) && (
        <MenuItem value={GITHUB_HOSTED_POOL}>{GITHUB_HOSTED_POOL}</MenuItem>
      )}
      {(offerUnknownScaleSet || selected === UNKNOWN_SCALE_SET) && (
        <MenuItem value={UNKNOWN_SCALE_SET}>{UNKNOWN_SCALE_SET_LABEL}</MenuItem>
      )}
    </Select>
  </Box>
);

export default ScaleSetScope;
