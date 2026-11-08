import React from 'react';
import { Button, alpha } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { signInUrl } from '../services/api';

// Same pill as the theme toggle, with the toggle's focus outline.
export const pillSx = (theme: Theme) => ({
  textTransform: 'none' as const,
  borderRadius: 999,
  minWidth: 0,
  px: 1.25,
  py: 0.375,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.3,
  letterSpacing: 0.1,
  color: theme.palette.text.primary,
  borderColor: alpha(theme.palette.text.primary, 0.35),
  '&:hover': {
    backgroundColor: theme.palette.action.hover,
    borderColor: alpha(theme.palette.text.primary, 0.6),
  },
  '&.Mui-focusVisible, &:focus-visible': {
    outline: `2px solid ${theme.palette.primary.main}`,
    outlineOffset: 2,
  },
});

export const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export const SignInLink: React.FC = () => (
  <Button component="a" href={signInUrl} variant="outlined" color="inherit" size="small" sx={pillSx}>
    Sign in
  </Button>
);
