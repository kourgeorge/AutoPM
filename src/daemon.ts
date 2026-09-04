import { ui } from './ui/ui';
import { attachUI } from './core/logger';
import { Trader } from './agents/trader';
import { ConciergeAgent } from './agents/concierge';
import { logger } from './core/logger';
import { FeatureScheduler } from './features/scheduler';
import { createLiveRouter } from './features/router';
import { recordTick } from './features/lastTick';
import { getPendingEvents } from './features/eventBus';
import { readDecisions } from './journal/journal';
import { isTradeAction, type DecisionRecord } from './journal/types';
import { reconcileOnStartup } from './review/reconcile';
import { DATA_DIR } from './core/paths';
import { config } from './core/config';
import { automationLevel, automationSummary } from './core/automation';
import { getOpenProposals } from './core/proposals';
import type { EventRow } from './ui/dashboard';
// Wire logger → UI and capture all raw stdout/stderr before anything else runs
attachUI(ui);
ui.captureStreams();

// Announced because it is now configurable, and because every durable record the operator
// might go looking for is under it. Logged AFTER `attachUI` so it lands in the UI log box —
// the blessed screen clears the terminal, so anything printed earlier is gone.
logger.info(`[Boot] data dir: ${DATA_DIR}`);

// Announced, not left to be discovered by an order that stops dead. `config.venue` is derived
// from the endpoint (see resolveVenue), so this line and the gate read the same truth. Unlike
// the old approval gate, there is no channel to wire up here: a human decides a pending
// proposal by typing `approve <id>`/`reject <id>` straight into the UI, which reads and writes
// the proposal store (`core/proposals.ts`) directly.
logger.info(`[Boot] automation: ${automationSummary()}`);

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
  const armed = (['entry', 'exit', 'stop_adjust', 'target_adjust'] as const).filter(
    (kind) => automationLevel(kind) === 'manual',
  );
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

/**
 * RECENT ACTIVITY wants venue-touching facts (entered, exited, stop/target moved), not
 * `EventRow`s — so this adapts a journaled `DecisionRecord` into the shape the panel already
 * renders. `EventRow` is structural (see `dashboard.ts`), so no renderer change is needed.
 */
function decisionToActivityRow(r: DecisionRecord): EventRow {
  const symbol = r.symbol ?? '?';
  let kind: string;
  let headline: string;
  if (r.kind === 'entry') {
    kind = 'entry';
    const target = r.intendedTarget != null ? `, target $${r.intendedTarget}` : '';
    headline = `Entered ${symbol}: qty=${r.qty} @ $${r.price}, stop $${r.intendedStop}${target} — ${r.rationale}`;
  } else if (r.kind === 'exit') {
    kind = 'exit';
    const pnl = r.pnl != null ? `, P&L $${r.pnl}` : '';
    headline = `Exited ${symbol}: ${r.rationale} — qty=${r.qty} @ $${r.price}${pnl}`;
  } else {
    kind = 'stop/target';
    const target = r.intendedTarget != null ? `, target $${r.intendedTarget}` : '';
    headline = `Stop/target updated for ${symbol}: stop $${r.intendedStop}${target} — ${r.rationale}`;
  }
  return {
    id: r.id,
    kind,
    severity: 'info',
    symbol: r.symbol,
    firedAt: r.at,
    headline,
    suggestedAction: null,
    ackedAt: null,
    ackDisposition: null,
    wakeCount: 1,
  };
}

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
  // The tick's features are already computed for the detectors; the panel and the trader's
  // get_watchlist_scan are the second and third readers of the same snapshot, which is why
  // the live dashboard and a full watchlist pass cost no broker calls at all.
  onTick: (data) => {
    recordTick(data);
    ui.setTick(data);
    const activity = readDecisions({ limit: 20, filter: isTradeAction }).map(decisionToActivityRow);
    ui.setEvents(getPendingEvents(), activity);
    ui.setProposals(getOpenProposals());
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
