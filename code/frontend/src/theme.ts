import { createTheme, useTheme } from '@mui/material/styles';

export type ThemeMode = 'light' | 'dark';

interface StatusColors {
  available: string;
  offline: string;
  barAvailable: string;
  barBusy: string;
  barOffline: string;
  barTrack: string;
  nextUp: string;
  nextUpChipBg: string;
  nextUpChipFg: string;
}

const lightStatusColors: StatusColors = {
  available: '#1e4620',
  offline: '#7a4100',

  barAvailable: '#2e7d32',
  barBusy: '#1976d2',
  barOffline: '#bdbdbd',
  barTrack: '#eeeeee',

  nextUp: '#b26500',
  nextUpChipBg: '#fff8e1',
  nextUpChipFg: '#7a4100',
};

// The same meanings, lifted until they read against a dark background.
const darkStatusColors: StatusColors = {
  available: '#81c784',
  offline: '#ffb74d',

  barAvailable: '#66bb6a',
  barBusy: '#64b5f6',
  barOffline: '#616161',
  barTrack: '#2f2f2f',

  nextUp: '#ffb74d',
  nextUpChipBg: 'rgba(255, 183, 77, 0.18)',
  nextUpChipFg: '#ffcc80',
};

export function statusColorsFor(mode: ThemeMode): StatusColors {
  return mode === 'dark' ? darkStatusColors : lightStatusColors;
}

/** The status colours of whichever theme is on. */
export function useStatusColors(): StatusColors {
  return statusColorsFor(useTheme().palette.mode === 'dark' ? 'dark' : 'light');
}

const FOCUS_RING: Record<ThemeMode, string> = {
  light: '#0b5cab',
  dark: '#90caf9',
};

export function createAppTheme(mode: ThemeMode) {
  const focusRing = FOCUS_RING[mode];

  return createTheme({
    palette: {
      mode,
      primary: {
        main: mode === 'dark' ? '#90caf9' : '#0b5cab',
      },
      secondary: {
        main: mode === 'dark' ? '#f48fb1' : '#dc004e',
      },
      background:
        mode === 'dark'
          ? { default: '#121212', paper: '#1e1e1e' }
          : { default: '#f5f5f5', paper: '#ffffff' },
    },
    typography: {
      fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
      h1: {
        fontSize: '2.5rem',
        fontWeight: 600,
      },
      h2: {
        fontSize: '2rem',
        fontWeight: 500,
      },
    },
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            '&.Mui-focusVisible, &:focus-visible': {
              outline: `2px solid ${focusRing}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderWidth: 2,
            },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            '&.Mui-focusVisible, &:focus-visible': {
              outline: `2px solid ${focusRing}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiTableSortLabel: {
        styleOverrides: {
          root: {
            '&.Mui-focusVisible, &:focus-visible': {
              outline: `2px solid ${focusRing}`,
              outlineOffset: 2,
            },
            '&.Mui-active': {
              color: 'inherit',
            },
          },
        },
      },
    },
  });
}

const theme = createAppTheme('light');

export default theme;
