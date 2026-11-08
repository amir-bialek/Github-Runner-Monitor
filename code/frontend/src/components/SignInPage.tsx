import React, { useEffect } from 'react';
import { Container, Paper, Typography } from '@mui/material';
import { APP_TAB_TITLE } from '../appConfig';
import { SignInLink } from './SessionControl';

// Login scope whole-dashboard, signed out: the only thing the page shows.
const SignInPage: React.FC = () => {
  useEffect(() => {
    document.title = APP_TAB_TITLE;
  }, []);

  return (
    <Container component="main" maxWidth="sm" sx={{ mt: 8, mb: 6 }}>
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h5" component="h2" sx={{ fontWeight: 700, mb: 1.5 }}>
          Sign in to see the dashboard
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          This monitor shows its runners and jobs only to signed in members of its GitHub organization.
        </Typography>
        <SignInLink />
      </Paper>
    </Container>
  );
};

export default SignInPage;
