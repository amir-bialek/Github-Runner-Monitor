import React, { useMemo } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { Box, Container, Typography } from '@mui/material';
import { ThemeMode, createAppTheme } from '../theme';
import { useNow } from '../hooks/useNow';
import QueueSection from '../components/QueueSection';
import RunningSection from '../components/RunningSection';
import HistorySection from '../components/HistorySection';
import { previewHistory, previewQueue, previewRunning } from './fixtures';

const QUEUE_NOTE =
  'Estimated order — oldest waiting job first. GitHub does not publish a real queue position.';

const REFRESH_SECONDS = 15;

const UPDATED_AT = Date.now() - 4000;

const noRetry = () => {};

interface PreviewPanelProps {
  mode: ThemeMode;
  now: number;
}

const PreviewPanel: React.FC<PreviewPanelProps> = ({ mode, now }) => {
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
            Fake data — nothing here comes from a backend.
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
            />
          </Box>
        </Container>
      </Box>
    </ThemeProvider>
  );
};

const PreviewApp: React.FC = () => {
  const now = useNow(1000);

  return (
    <>
      <PreviewPanel mode="light" now={now} />
      <PreviewPanel mode="dark" now={now} />
    </>
  );
};

export default PreviewApp;
