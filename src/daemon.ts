import { ui } from './ui/ui';
import { attachUI } from './core/logger';
import { Trader } from './agents/trader';
import { ConciergeAgent } from './agents/concierge';
import { logger } from './core/logger';
import { FeatureScheduler } from './features/scheduler';
import { createLiveRouter } from './features/router';
import { reconcileOnStartup } from './review/reconcile';
import { config } from './core/config';
// Wire logger → UI and capture all raw stdout/stderr before anything else runs
attachUI(ui);
ui.captureStreams();

// The dashboard cannot read config itself (`src/ui/` must stay importable without an API key),
// so identity is pushed in from here — the one place that already knows all of it.
//
// The venue is derived, not configured, and it is the reason this is worth doing at all: an
// operator glancing at the panel must never mistake a live account for a paper one. Alpaca
// announces it in the hostname; IBKR only in the port (7497 TWS / 4002 Gateway are paper).
const venue =
  config.broker === 'alpaca'
    ? /paper/i.test(config.alpaca.baseUrl)
      ? 'paper'
      : 'live'
    : config.ibkr.port === 7497 || config.ibkr.port === 4002
      ? 'paper'
      : 'live';

ui.setEnvironment({
  broker: config.broker,
  venue,
  provider: config.ai.provider,
  model: config.ai.model,
});

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
  // The tick's features are already computed for the detectors; the panel is a second reader of
  // the same snapshot, which is why the live dashboard costs no broker calls at all.
  onTick: (data) => ui.setTick(data),
});

scheduler.start();

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
