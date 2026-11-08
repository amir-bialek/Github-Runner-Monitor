import { app } from './app.ts';
import { loadState, saveState, startPeriodicSave, stopPeriodicSave } from './services/statePersistence.ts';
import { loadAlertState, saveAlertState, startAlertLoop, stopAlertLoop } from './services/alerts.ts';
import { gatherAlertInput } from './services/alertInput.ts';
import { debugItConfig } from './services/debugItConfig.ts';
import { getIsolationGate } from './services/debugIt/isolation.ts';
import { getRunLifecycle } from './services/debugIt/lifecycle.ts';
import { getDemoRunLifecycle } from './services/debugIt/demoLifecycle.ts';
import { openResultsListener } from './routes/debugItResults.ts';
import { getTelemetryAdapter } from './adapters/telemetry.ts';

const PORT = process.env.PORT || 3001;

const SHUTDOWN_DRAIN_MS = parseFloat(process.env.SHUTDOWN_DRAIN_SECONDS || '5') * 1000;

const SHUTDOWN_DEADLINE_MS = parseFloat(process.env.SHUTDOWN_DEADLINE_SECONDS || '15') * 1000;

const server = app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
});

// Story 3.10: the run lifecycle, only when Debug it is enabled and not in mock
// mode (demo mode has its own flow, story 3.14).
const lifecycle =
  debugItConfig.enabled && process.env.USE_MOCK_DATA !== 'true' ? getRunLifecycle() : null;

// Story 3.14: in mock mode a demo lifecycle moves each run to a fixed invented
// result, with no Job, no Anthropic call and no GitHub call.
const demoLifecycle =
  debugItConfig.enabled && process.env.USE_MOCK_DATA === 'true' ? getDemoRunLifecycle() : null;

// Story 3.9: the results port, only when Debug it is enabled. A broken result
// schema throws here, so the backend does not start.
const resultsServer = openResultsListener(
  debugItConfig,
  lifecycle ? { onAccepted: lifecycle.onResultAccepted, onFailed: lifecycle.onRunFailed } : {}
);
// Without the results port every Debug Job result would be lost: stop, so the
// pod restarts. openResultsListener has already logged the [ERROR] line.
resultsServer?.on('error', () => process.exit(1));

void Promise.all([loadState().then(() => startPeriodicSave()), loadAlertState()]).then(() =>
  startAlertLoop(gatherAlertInput)
);

// Story 3.6: Debug it stays off until the startup isolation check passes.
// run() never rejects; the result shows on the Debug it settings page.
if (debugItConfig.enabled) {
  void getIsolationGate().run();
}

// Story 3.10: recover runs from S3, then queue, monitor, sweep and retention.
// Nothing leaves waiting until the isolation gate is on.
lifecycle?.start();
demoLifecycle?.start();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[AUDIT] ${signal} received — draining for ${SHUTDOWN_DRAIN_MS}ms before shutting down`);

  const deadline = setTimeout(() => {
    console.error('[ERROR] Shutdown took too long — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref?.();

  await new Promise(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_MS));

  stopPeriodicSave();
  stopAlertLoop();
  lifecycle?.stop();
  // Story 6.1: the cost telemetry adapter exists only with the real lifecycle.
  // One last send (5 s timeout, never rejects), so a run recorded just before
  // shutdown, or whose last send failed, still reaches the collector.
  if (lifecycle) {
    const telemetry = getTelemetryAdapter();
    await telemetry.flush();
    telemetry.stop();
  }
  demoLifecycle?.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (resultsServer) await new Promise<void>(resolve => resultsServer.close(() => resolve()));
  await saveState(true);
  await saveAlertState();

  console.log('[AUDIT] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
