import { ui } from './ui/ui';
import { attachUI } from './core/logger';
import { Trader } from './agents/trader';
import { ConciergeAgent } from './agents/concierge';
import { logger } from './core/logger';
import { FeatureScheduler } from './features/scheduler';
import { createLiveRouter } from './features/router';
import { reconcileOnStartup } from './review/reconcile';
import { DATA_DIR } from './core/paths';
import { config } from './core/config';
import { approvalRequired, approvalSummary, setApprovalChannel } from './core/approvals';
// Wire logger → UI and capture all raw stdout/stderr before anything else runs
attachUI(ui);
ui.captureStreams();

// Announced because it is now configurable, and because every durable record the operator
// might go looking for is under it. Logged AFTER `attachUI` so it lands in the UI log box —
// the blessed screen clears the terminal, so anything printed earlier is gone.
logger.info(`[Boot] data dir: ${DATA_DIR}`);

// The operator approval gate's one wire to a human.
//
// Registered here because this is the only module that owns both halves: `core/approvals.ts`
// must stay free of `src/ui/`, which builds a blessed screen AT IMPORT. Any process that does
// NOT run this line — a script, the replay harness, a probe — has no operator to ask, and an
// armed gate there refuses rather than assuming consent.
setApprovalChannel((req) => ui.askApproval(req));

// Announced, not left to be discovered by an order that stops dead. `config.venue` is derived
// from the endpoint (see resolveVenue), so this line and the gate read the same truth.
logger.info(`[Boot] approvals: ${approvalSummary()}`);

/**
 * The dashboard cannot read config itself (`src/ui/` must stay importable without an API key),
 * so identity is pushed in from here — the one place that already knows all of it.
 *
 * The venue is derived, not configured, and it is the reason this is worth doing at all: an
 * operator glancing at the panel must never mistake a live account for a paper one.
 *
 * Re-pushed on every tick rather than set once, because the gate is read from the policy and
 * the policy is hot-reloaded: a badge fixed at boot would keep claiming the gate was armed for
 * up to a whole session after someone disarmed it in the file. Cheap — it is a repaint of
 * strings the panel already renders every second.
 */
function pushEnvironment(): void {
  const armed = (['entry', 'exit'] as const).filter((a) => approvalRequired(a));
  ui.setEnvironment({
    broker: config.broker,
    venue: config.venue,
    provider: config.ai.provider,
    model: config.ai.model,
    // Empty when disarmed — `joinChunks` drops an empty chunk, so the badge costs no columns
    // until there is something to say.
    gate: armed.length > 0 ? `gate ${armed.join('+')}` : '',
  });
}

pushEnvironment();

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
  onTick: (data) => {
    ui.setTick(data);
    pushEnvironment(); // policy may have been reloaded since the last tick
  },
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
