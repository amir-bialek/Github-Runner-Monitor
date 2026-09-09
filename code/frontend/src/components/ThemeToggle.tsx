import React from 'react';
import { Box, ButtonBase, SvgIcon, Tooltip, Typography, alpha } from '@mui/material';
import { ThemeMode } from '../theme';

interface ThemeToggleProps {
  mode: ThemeMode;
  onToggle: () => void;
}

const SunIcon: React.FC = () => (
  <SvgIcon viewBox="0 0 24 24" sx={{ fontSize: 15 }}>
    <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-13a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0V3a1 1 0 0 1 1-1zm0 17a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1zM3 11h2a1 1 0 0 1 0 2H3a1 1 0 0 1 0-2zm16 0h2a1 1 0 0 1 0 2h-2a1 1 0 0 1 0-2zM5.0 3.6l1.4 1.4a1 1 0 0 1-1.4 1.4L3.6 5.0A1 1 0 0 1 5.0 3.6zm12.6 12.6 1.4 1.4a1 1 0 0 1-1.4 1.4l-1.4-1.4a1 1 0 0 1 1.4-1.4zM19 3.6A1 1 0 0 1 20.4 5l-1.4 1.4a1 1 0 0 1-1.4-1.4zM6.4 16.2a1 1 0 0 1 1.4 1.4L6.4 19A1 1 0 0 1 5 17.6z" />
  </SvgIcon>
);

const MoonIcon: React.FC = () => (
  <SvgIcon viewBox="0 0 24 24" sx={{ fontSize: 15 }}>
    <path d="M21.5 14.1A8.5 8.5 0 0 1 9.9 2.5a1 1 0 0 0-1.3-1.2 10.5 10.5 0 1 0 14.1 14.1 1 1 0 0 0-1.2-1.3zM12 20.5a8.5 8.5 0 0 1-4.6-15.6A10.5 10.5 0 0 0 19.1 16.6 8.5 8.5 0 0 1 12 20.5z" />
  </SvgIcon>
);

const ThemeToggle: React.FC<ThemeToggleProps> = ({ mode, onToggle }) => {
  const isDark = mode === 'dark';
  const label = isDark ? 'Switch to the light theme' : 'Switch to the dark theme';

  return (
    <Box
      sx={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.25,
      }}
    >
      <Typography
        component="span"
        aria-hidden
        sx={{
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
          color: 'text.secondary',
        }}
      >
        Theme
      </Typography>

      <Tooltip title={label}>
        <ButtonBase
          onClick={onToggle}
          aria-label={label}
          sx={(theme) => ({
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.25,
            py: 0.375,
            borderRadius: 999,
            border: '1px solid',
            borderColor: alpha(theme.palette.text.primary, 0.35),
            color: 'text.primary',
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.3,
            letterSpacing: 0.1,
            transition: theme.transitions.create(['background-color', 'border-color']),
            '&:hover': {
              backgroundColor: theme.palette.action.hover,
              borderColor: alpha(theme.palette.text.primary, 0.6),
            },
            '&.Mui-focusVisible, &:focus-visible': {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2,
            },
          })}
        >
          <Box component="span">{isDark ? 'Dark' : 'Light'}</Box>
          {isDark ? <MoonIcon /> : <SunIcon />}
        </ButtonBase>
      </Tooltip>
    </Box>
  );
};

export default ThemeToggle;
