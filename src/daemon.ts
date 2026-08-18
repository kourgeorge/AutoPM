import { ui } from './ui/ui';
import { attachUI } from './core/logger';
import { Trader } from './agents/trader';
import { ConciergeAgent } from './agents/concierge';
import { logger } from './core/logger';
import { FeatureScheduler } from './features/scheduler';
import { createLiveRouter } from './features/router';
import { reconcileOnStartup } from './review/reconcile';
import { repairSessionExtremes } from './state/repair';
// Wire logger → UI and capture all raw stdout/stderr before anything else runs
attachUI(ui);
ui.captureStreams();

const trader = new Trader();
const concierge = new ConciergeAgent(msg => trader.wake(msg));

// All user input goes to the concierge
ui.onMessage((msg) => concierge.handleMessage(msg));

// L2 — the deterministic tick loop, and the ONLY path that wakes anyone. Machine wakes
// carry no message: `pendingMessages` renders under `=== OPERATOR INSTRUCTIONS ===`, and a
// machine event is not an operator instruction. The events themselves travel via the
// registry, read at cycle start.
const scheduler = new FeatureScheduler({
  route: createLiveRouter({
    wakeTrader: () => trader.wake(),
    alertUser: (msg) => concierge.pushAlert(msg),
  }),
});

// Sequenced BEFORE the first tick, unlike `reconcileOnStartup` below, and for the opposite
// reason: this writes the same `sessionHigh`/`sessionLow` fields a tick reads, so overlapping
// them lets a tick read a poisoned figure and write it straight back. The bar fetches run in
// parallel and a failure still starts the scheduler — an unverified extreme must not stop
// trading, it must only stop being silent.
void repairSessionExtremes()
  .catch((err) => logger.error('[Repair] Session extreme repair failed', err.message ?? err))
  .then(() => scheduler.start());

// Not awaited, and deliberately not blocking the scheduler: this reaches back a month to
// catch fills that landed while the daemon was down, and a slow or unreachable broker at
// boot must delay reviewing yesterday, not trading today.
void reconcileOnStartup();

trader.start().catch((err) => {
  logger.error('Trader fatal error', err.message ?? err);
  process.exit(1);
});

function shutdown(signal: string): void {
  logger.info(`Shutting down (${signal})...`);
  scheduler.stop();
  trader.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
