import { ui } from './ui/ui';
import { attachUI } from './core/logger';
import { Trader } from './agents/trader';
import { ConciergeAgent } from './agents/concierge';
import { logger } from './core/logger';
import { FeatureScheduler } from './features/scheduler';
import { createLiveRouter } from './features/router';

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
//
// To roll back to observation only, swap `createLiveRouter(...)` for `observeOnlyRouter`.
const scheduler = new FeatureScheduler({
  route: createLiveRouter({
    wakeTrader: () => trader.wake(),
    alertUser: (msg) => concierge.pushAlert(msg),
  }),
});
scheduler.start();

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
