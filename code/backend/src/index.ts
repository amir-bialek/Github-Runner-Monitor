import { app } from './app.ts';
import { loadState, saveState, startPeriodicSave, stopPeriodicSave } from './services/statePersistence.ts';

const PORT = process.env.PORT || 3001;

const SHUTDOWN_DRAIN_MS = parseFloat(process.env.SHUTDOWN_DRAIN_SECONDS || '5') * 1000;

const SHUTDOWN_DEADLINE_MS = parseFloat(process.env.SHUTDOWN_DEADLINE_SECONDS || '15') * 1000;

const server = app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
});

void loadState().then(() => startPeriodicSave());

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
  await new Promise<void>(resolve => server.close(() => resolve()));
  await saveState(true);

  console.log('[AUDIT] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
