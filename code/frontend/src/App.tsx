import { useCallback, useEffect, useMemo, useState } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { Box, Container, CssBaseline } from '@mui/material';
import { ThemeMode, createAppTheme } from './theme';
import { useScaleSets } from './hooks/useScaleSets';
import { useQueue } from './hooks/useQueue';
import { useRunningJobs } from './hooks/useRunningJobs';
import { useJobHistory } from './hooks/useJobHistory';
import { useSettings } from './hooks/useSettings';
import { useAlerts } from './hooks/useAlerts';
import { REFRESH_INTERVAL_MS } from './queryClient';
import { QUEUE_MAX_ITEMS } from './appConfig';
import { useNow } from './hooks/useNow';
import ScaleSetScope from './components/ScaleSetScope';
import ThemeToggle from './components/ThemeToggle';
import AppLayout, { AlertsPlacement, LayoutItem, LayoutProps } from './components/AppLayout';
import DebugItSettingsPage from './components/DebugItSettingsPage';
import SecurityPage from './components/SecurityPage';
import SignInPage from './components/SignInPage';
import PersonalKeyDialog from './components/PersonalKeyDialog';
import { personalKeyMode } from './components/DebugItAction';
import { useSession, useSignOut } from './hooks/useSession';
import AvailabilityPanel from './components/AvailabilityPanel';
import QueueSection from './components/QueueSection';
import RunningSection from './components/RunningSection';
import HistorySection from './components/HistorySection';
import AlertsPopover from './components/AlertsPopover';
import AlertSettingsDialog from './components/AlertSettingsDialog';
import { APP_HEADING, APP_TAB_TITLE } from './appConfig';
import ErrorState from './components/ErrorState';
import { explanationFromBackend } from './services/apiError';
import { readStoredThemeMode, storeThemeMode } from './utils/themeMode';
import type { DebugItSession } from './types/api';
import {
  ALL_SCALE_SETS,
  GITHUB_HOSTED_POOL,
  UNKNOWN_SCALE_SET,
  UNKNOWN_SCALE_SET_LABEL,
} from './utils/scaleSets';
import './App.css';

// The 1.x dashboard: every 1.x hook lives here, so the whole-dashboard sign
// in page mounts none of them.
function Dashboard({
  layout,
  debugItSession,
}: {
  layout: LayoutProps;
  debugItSession: Extract<DebugItSession, { state: 'signed-out' | 'signed-in' }> | null;
}) {
  const [selectedScaleSet, setSelectedScaleSet] = useState<string>(ALL_SCALE_SETS);
  const now = useNow(1000);

  const isUnknownFilter = selectedScaleSet === UNKNOWN_SCALE_SET;
  const scaleSetParam =
    selectedScaleSet === ALL_SCALE_SETS || isUnknownFilter ? undefined : selectedScaleSet;
  const showScaleSetColumn = selectedScaleSet === ALL_SCALE_SETS;

  const scaleSetsQuery = useScaleSets();
  const queueQuery = useQueue();
  const runningQuery = useRunningJobs(scaleSetParam);
  const historyQuery = useJobHistory(scaleSetParam);
  const settingsQuery = useSettings();
  const alertsQuery = useAlerts();
  const [alertSettingsOpen, setAlertSettingsOpen] = useState(false);
  const [alertsAnchor, setAlertsAnchor] = useState<HTMLElement | null>(null);
  const [alertsPlacement, setAlertsPlacement] = useState<AlertsPlacement>('side');
  const activeAlerts = useMemo(() => alertsQuery.data?.alerts ?? [], [alertsQuery.data]);

  const allScaleSets = useMemo(() => scaleSetsQuery.data ?? [], [scaleSetsQuery.data]);
  const visibleScaleSets = useMemo(
    () => (scaleSetParam ? allScaleSets.filter((s) => s.id === scaleSetParam) : allScaleSets),
    [allScaleSets, scaleSetParam],
  );

  const rawQueueItems = useMemo(() => queueQuery.data?.items ?? [], [queueQuery.data]);
  const runningItems = useMemo(() => runningQuery.data?.items ?? [], [runningQuery.data]);
  const historyItems = useMemo(() => historyQuery.data ?? [], [historyQuery.data]);

  const hasUnknownScaleSetJobs = rawQueueItems.some((item) => item.scaleSet === null);
  const hasGitHubHostedJobs = useMemo(
    () =>
      [...rawQueueItems, ...runningItems, ...historyItems].some(
        (item) => item.scaleSet === GITHUB_HOSTED_POOL,
      ),
    [rawQueueItems, runningItems, historyItems],
  );

  const matchingQueueItems = useMemo(() => {
    if (isUnknownFilter) return rawQueueItems.filter((item) => item.scaleSet === null);
    if (scaleSetParam) return rawQueueItems.filter((item) => item.scaleSet === scaleSetParam);
    return rawQueueItems;
  }, [rawQueueItems, isUnknownFilter, scaleSetParam]);
  const queueItems = useMemo(
    () => matchingQueueItems.slice(0, QUEUE_MAX_ITEMS),
    [matchingQueueItems],
  );
  const visibleRunningItems = isUnknownFilter ? [] : runningItems;
  const visibleHistoryItems = isUnknownFilter ? [] : historyItems;

  const errors = [scaleSetsQuery.error, queueQuery.error, runningQuery.error, historyQuery.error];
  const failedCount = errors.filter(Boolean).length;
  const everythingFailed = failedCount === 4;

  const backendExplanation = useMemo(
    () => errors.map(explanationFromBackend).find(Boolean) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scaleSetsQuery.error, queueQuery.error, runningQuery.error, historyQuery.error],
  );

  const handleRefresh = useCallback(async () => {
    await Promise.allSettled([
      scaleSetsQuery.refetch(),
      queueQuery.refetch(),
      runningQuery.refetch(),
      historyQuery.refetch(),
    ]);
  }, [scaleSetsQuery, queueQuery, runningQuery, historyQuery]);

  useEffect(() => {
    const waiting =
      matchingQueueItems.length > 0
        ? `${matchingQueueItems.length} waiting · ${APP_TAB_TITLE}`
        : APP_TAB_TITLE;
    document.title =
      activeAlerts.length > 0
        ? `⚠ ${activeAlerts.length === 1 ? '1 alert' : `${activeAlerts.length} alerts`} · ${waiting}`
        : waiting;
  }, [matchingQueueItems.length, activeAlerts.length]);

  const statusMessage = useMemo(() => {
    if (everythingFailed) return '';
    if (queueQuery.isLoading) return '';

    const scope =
      selectedScaleSet === ALL_SCALE_SETS
        ? 'all scale sets'
        : isUnknownFilter
          ? UNKNOWN_SCALE_SET_LABEL
          : selectedScaleSet;
    const waiting =
      matchingQueueItems.length === 1 ? '1 job waiting' : `${matchingQueueItems.length} jobs waiting`;
    return `Showing ${scope} — ${waiting}, ${visibleRunningItems.length} running.`;
  }, [
    everythingFailed,
    queueQuery.isLoading,
    selectedScaleSet,
    isUnknownFilter,
    matchingQueueItems.length,
    visibleRunningItems.length,
  ]);

  return (
    <>
      <AppLayout
        {...layout}
        alerts={{
          count: activeAlerts.length,
          onOpen: (anchor, placement) => {
            setAlertsPlacement(placement);
            setAlertsAnchor(anchor);
          },
        }}
      >
        <Container component="main" maxWidth="xl" sx={{ mt: 3, mb: 6 }}>
          <Box
            role="status"
            aria-live="polite"
            sx={{
              position: 'absolute',
              width: '1px',
              height: '1px',
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
              whiteSpace: 'nowrap',
            }}
          >
            {statusMessage}
          </Box>

          {everythingFailed ? (
            backendExplanation ? (
              <ErrorState
                prominent
                title="The backend can't get the data from GitHub"
                message={backendExplanation}
                detail="The dashboard reached its backend, so this is between the backend and GitHub — check the token and its permissions, or whether GitHub is having trouble."
                onRetry={handleRefresh}
                retryLabel="Try again"
              />
            ) : (
              <ErrorState
                prominent
                title="The monitor can't reach its backend"
                message="It may be restarting — try again in a moment."
                detail={(queueQuery.error as Error | null)?.message}
                onRetry={handleRefresh}
                retryLabel="Try again"
              />
            )
          ) : (
            <>
              <AvailabilityPanel
                noPoolSelected={isUnknownFilter}
                scaleSets={visibleScaleSets}
                isLoading={scaleSetsQuery.isLoading}
                isFetching={scaleSetsQuery.isFetching}
                error={scaleSetsQuery.error as Error | null}
                onRetry={() => scaleSetsQuery.refetch()}
                action={
                  <ScaleSetScope
                    scaleSets={allScaleSets}
                    offerUnknownScaleSet={hasUnknownScaleSetJobs}
                    offerGitHubHosted={hasGitHubHostedJobs}
                    selected={selectedScaleSet}
                    onChange={setSelectedScaleSet}
                  />
                }
                updatedAt={scaleSetsQuery.dataUpdatedAt}
                now={now}
                refreshSeconds={settingsQuery.data?.runnersRefreshSeconds ?? null}
              />

              <QueueSection
                filterKey={selectedScaleSet}
                items={queueItems}
                total={matchingQueueItems.length}
                note={queueQuery.data?.note}
                incomplete={queueQuery.data?.incomplete ?? false}
                isLoading={queueQuery.isLoading}
                isFetching={queueQuery.isFetching}
                error={queueQuery.error as Error | null}
                onRetry={() => queueQuery.refetch()}
                now={now}
                updatedAt={queueQuery.dataUpdatedAt}
                refreshSeconds={REFRESH_INTERVAL_MS / 1000}
                showScaleSetColumn={showScaleSetColumn}
              />

              <RunningSection
                filterKey={selectedScaleSet}
                items={visibleRunningItems}
                total={isUnknownFilter ? 0 : runningQuery.data?.total}
                incomplete={!isUnknownFilter && (runningQuery.data?.incomplete ?? false)}
                isLoading={runningQuery.isLoading}
                isFetching={runningQuery.isFetching}
                error={runningQuery.error as Error | null}
                onRetry={() => runningQuery.refetch()}
                now={now}
                updatedAt={runningQuery.dataUpdatedAt}
                refreshSeconds={REFRESH_INTERVAL_MS / 1000}
                showScaleSetColumn={showScaleSetColumn}
              />

              <Box sx={{ mt: 6, pt: 3, borderTop: '1px solid', borderColor: 'divider' }}>
                <HistorySection
                  filterKey={selectedScaleSet}
                  items={visibleHistoryItems}
                  isLoading={historyQuery.isLoading}
                  isFetching={historyQuery.isFetching}
                  error={historyQuery.error as Error | null}
                  onRetry={() => historyQuery.refetch()}
                  now={now}
                  updatedAt={historyQuery.dataUpdatedAt}
                  refreshSeconds={REFRESH_INTERVAL_MS / 1000}
                  showScaleSetColumn={showScaleSetColumn}
                  debugItSession={debugItSession}
                />
              </Box>
            </>
          )}
        </Container>
      </AppLayout>

      <AlertsPopover
        anchorEl={alertsAnchor}
        placement={alertsPlacement}
        onClose={() => setAlertsAnchor(null)}
        onOpenSettings={() => {
          setAlertsAnchor(null);
          setAlertSettingsOpen(true);
        }}
        alerts={activeAlerts}
        now={now}
      />

      <AlertSettingsDialog open={alertSettingsOpen} onClose={() => setAlertSettingsOpen(false)} />
    </>
  );
}

function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readStoredThemeMode);
  const theme = useMemo(() => createAppTheme(themeMode), [themeMode]);

  const handleThemeToggle = useCallback(() => {
    setThemeMode((current) => {
      const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
      storeThemeMode(next);
      return next;
    });
  }, []);

  // Loading, errored with nothing known yet, or Debug it disabled: no
  // account or page items in the panel and the 1.x dashboard exactly as before. After a failed
  // refetch the last known answer stays in use.
  const sessionQuery = useSession();
  const session = sessionQuery.data;
  const shownSession =
    session && (session.state === 'signed-out' || session.state === 'signed-in') ? session : null;
  const signOutMutation = useSignOut(shownSession?.loginScope ?? 'debug-it-only');
  const signInOnly = shownSession?.state === 'signed-out' && shownSession.loginScope === 'whole-dashboard';
  const administrator = shownSession?.state === 'signed-in' && shownSession.administrator;
  // Personal key mode (story 5.2): allowed users save, replace and delete their own key.
  const personalKeys = personalKeyMode(shownSession);
  const [personalKeyOpen, setPersonalKeyOpen] = useState(false);
  useEffect(() => {
    if (!personalKeys) setPersonalKeyOpen(false);
  }, [personalKeys]);

  // No router: the settings page replaces the dashboard body while open and
  // only while the session still says administrator. The security page does
  // the same while Debug it is enabled and the dashboard is shown. Each view
  // closes only when its own condition fails.
  const [view, setView] = useState<'dashboard' | 'settings' | 'security'>('dashboard');
  const settingsOpen = view === 'settings' && administrator;
  const securityAvailable = shownSession !== null && !signInOnly;
  const securityOpen = view === 'security' && securityAvailable;
  useEffect(() => {
    setView((current) =>
      (current === 'settings' && !administrator) || (current === 'security' && !securityAvailable)
        ? 'dashboard'
        : current,
    );
  }, [administrator, securityAvailable]);

  // Each view draws its own panel, so choosing an item mounts a new one: its
  // current item takes the focus back. Back to dashboard does not.
  const [focusCurrentItem, setFocusCurrentItem] = useState(false);
  const openView = (next: typeof view) => {
    setFocusCurrentItem(true);
    setView(next);
  };
  const back = () => {
    setFocusCurrentItem(false);
    setView('dashboard');
  };
  const items: LayoutItem[] = [];
  if (administrator || securityAvailable) {
    items.push({ label: 'Dashboard', current: !settingsOpen && !securityOpen, onSelect: () => openView('dashboard') });
  }
  if (administrator) {
    items.push({ label: 'Debug it settings', current: settingsOpen, onSelect: () => openView('settings') });
  }
  if (securityAvailable) {
    items.push({ label: 'Security', current: securityOpen, onSelect: () => openView('security') });
  }
  const layout: LayoutProps = {
    heading: APP_HEADING,
    items,
    focusCurrentItem,
    account:
      shownSession && !signInOnly
        ? {
            session: shownSession,
            onSignOut: () => signOutMutation.mutate(),
            signingOut: signOutMutation.isPending,
            personalKey: personalKeys ? { onOpen: () => setPersonalKeyOpen(true) } : undefined,
          }
        : null,
    themeToggle: <ThemeToggle mode={themeMode} onToggle={handleThemeToggle} />,
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div className="App">
        {signInOnly ? (
          <AppLayout {...layout}>
            <SignInPage />
          </AppLayout>
        ) : settingsOpen ? (
          <AppLayout {...layout}>
            <DebugItSettingsPage onBack={back} />
          </AppLayout>
        ) : securityOpen ? (
          <AppLayout {...layout}>
            <SecurityPage onBack={back} />
          </AppLayout>
        ) : (
          <Dashboard layout={layout} debugItSession={shownSession} />
        )}
        {personalKeys && <PersonalKeyDialog open={personalKeyOpen} onClose={() => setPersonalKeyOpen(false)} />}
      </div>
    </ThemeProvider>
  );
}

export default App;
