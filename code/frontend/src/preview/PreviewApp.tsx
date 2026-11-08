import React, { useMemo } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { Box, Container, Paper, Typography } from '@mui/material';
import { ThemeMode, createAppTheme } from '../theme';
import { useNow } from '../hooks/useNow';
import { useSession } from '../hooks/useSession';
import QueueSection from '../components/QueueSection';
import RunningSection from '../components/RunningSection';
import HistorySection from '../components/HistorySection';
import { DebugRunProgress } from '../components/DebugRunDialog';
import DebugItSettingsPage from '../components/DebugItSettingsPage';
import SecurityPage from '../components/SecurityPage';
import type { DebugItSession } from '../types/api';
import { previewHistory, previewQueue, previewRunning } from './fixtures';
import { PREVIEW_ANALYZING_RUN_ID, PREVIEW_FINISHED_RUN_ID } from './fixtureApi';

const QUEUE_NOTE =
  'Estimated order — oldest waiting job first. GitHub does not publish a real queue position.';

const REFRESH_SECONDS = 15;

const UPDATED_AT = Date.now() - 4000;

const noRetry = () => {};

type ShownSession = Extract<DebugItSession, { state: 'signed-out' | 'signed-in' }>;

interface PreviewPanelProps {
  mode: ThemeMode;
  now: number;
  debugItSession: ShownSession | null;
}

const DebugSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Box component="section" aria-label={title} sx={{ mt: 6, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
    <Typography variant="h5" component="h3" sx={{ fontWeight: 700, mb: 2 }}>
      {title}
    </Typography>
    {children}
  </Box>
);

const PreviewPanel: React.FC<PreviewPanelProps> = ({ mode, now, debugItSession }) => {
  const theme = useMemo(() => createAppTheme(mode), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <Box
        component="section"
        aria-label={`${mode} theme`}
        sx={{ bgcolor: 'background.default', color: 'text.primary', py: 4 }}
      >
        <Container maxWidth="xl">
          <Typography variant="h4" component="h2" sx={{ fontWeight: 700, mb: 1 }}>
            {mode === 'dark' ? 'Dark theme' : 'Light theme'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
            Fake data — nothing here comes from a backend. Debug it answers come from the preview fixture API.
          </Typography>

          <QueueSection
            filterKey={`preview-${mode}`}
            items={previewQueue}
            total={previewQueue.length}
            note={QUEUE_NOTE}
            incomplete={false}
            isLoading={false}
            isFetching={false}
            error={null}
            onRetry={noRetry}
            now={now}
            updatedAt={UPDATED_AT}
            refreshSeconds={REFRESH_SECONDS}
            showScaleSetColumn
          />

          <RunningSection
            filterKey={`preview-${mode}`}
            items={previewRunning}
            total={previewRunning.length}
            incomplete={false}
            isLoading={false}
            isFetching={false}
            error={null}
            onRetry={noRetry}
            now={now}
            updatedAt={UPDATED_AT}
            refreshSeconds={REFRESH_SECONDS}
            showScaleSetColumn
          />

          <Box sx={{ mt: 6, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
            <HistorySection
              filterKey={`preview-${mode}`}
              items={previewHistory}
              isLoading={false}
              isFetching={false}
              error={null}
              onRetry={noRetry}
              now={now}
              updatedAt={UPDATED_AT}
              refreshSeconds={REFRESH_SECONDS}
              showScaleSetColumn
              debugItSession={debugItSession}
            />
          </Box>

          <DebugSection title="Debug run in progress">
            <Paper variant="outlined" sx={{ p: 3, maxWidth: 900 }}>
              <DebugRunProgress runId={PREVIEW_ANALYZING_RUN_ID} />
            </Paper>
          </DebugSection>

          <DebugSection title="Debug run result">
            <Paper variant="outlined" sx={{ p: 3, maxWidth: 900 }}>
              <DebugRunProgress runId={PREVIEW_FINISHED_RUN_ID} />
            </Paper>
          </DebugSection>

          <DebugSection title="Debug it settings page">
            <Paper variant="outlined" sx={{ pb: 1 }}>
              <DebugItSettingsPage onBack={noRetry} />
            </Paper>
          </DebugSection>

          <DebugSection title="Security page">
            <Paper variant="outlined" sx={{ pb: 1 }}>
              <SecurityPage onBack={noRetry} />
            </Paper>
          </DebugSection>
        </Container>
      </Box>
    </ThemeProvider>
  );
};

const PreviewApp: React.FC = () => {
  const now = useNow(1000);
  const session = useSession().data;
  const debugItSession: ShownSession | null =
    session && (session.state === 'signed-in' || session.state === 'signed-out') ? session : null;

  return (
    <>
      <PreviewPanel mode="light" now={now} debugItSession={debugItSession} />
      <PreviewPanel mode="dark" now={now} debugItSession={debugItSession} />
    </>
  );
};

export default PreviewApp;
