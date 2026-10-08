import { subscribeActivity } from './core/storage';
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
import { isTradeAction, describeDecision, type DecisionRecord } from './journal/types';
import { reconcileOnStartup } from './review/reconcile';
import { DATA_DIR } from './core/paths';
import { config } from './core/config';
import { automationLevel, automationSummary } from './core/automation';
import { getOpenActions } from './core/actions';
import type { EventRow } from './ui/dashboard';
import { getMarketStatusSnapshot } from './tools/traderTools';
import { registerOperatorCommands } from './core/operatorCommands';
import { HeadlessUI } from './ui/headless';
import { startApiServer } from './server/api';
import { initializeAccount, stopRuntime } from './core/runtime';
import { closeStorage } from './core/storage';
import { NotificationDelivery } from './core/notifications';
import { ExecutionLoop } from './strategy/executionLoop';
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
// action by typing `approve <id>`/`reject <id>` straight into the UI, which reads and writes
// the action store (`core/actions.ts`) directly.
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
  return { id: r.id, kind: r.kind, severity: 'info', symbol: r.symbol,
    headline: describeDecision(r), firedAt: r.at, suggestedAction: null,
    ackedAt: null, ackDisposition: null, wakeCount: 1 };

}

// Concierge replies go to the chat; trader results (core/requests.ts) go to the log pane.
if (!(ui instanceof HeadlessUI)) subscribeActivity(entry => {
  if (entry.kind === 'reply') ui.reply(entry.text);
  else if (entry.kind === 'log' && entry.text.startsWith('[Trader] ')) ui.log(entry.level ?? 'INFO', entry.text);
});

const trader = new Trader();
const concierge = new ConciergeAgent(msg => trader.wake(msg));

// All user input goes to the concierge — except `/` commands, which the UI handles itself
ui.onMessage((msg) => concierge.handleMessage(msg));
registerOperatorCommands(trader);

// Both independent clients use this engine API. Register commands before accepting requests;
// the separate web process owns browser assets and the TUI owns its terminal lifecycle.
const api = ui instanceof HeadlessUI ? startApiServer({ ui, trader, serveWeb: false, messageService: (text, actor) => concierge.handleMessage(text, actor) }) : null;

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
    ui.setActions(getOpenActions());
    pushEnvironment(); // policy may have been reloaded since the last tick
  },
});

const execution = new ExecutionLoop();
const notifications = new NotificationDelivery();

// Independent of the scheduler's tick cadence on purpose — `marketSession()` (the tick's
// clock-only session guess) deliberately never calls the broker, so this is the one place
// that does, at a slow cadence that can't add load to the detector loop. Corrects the
// dashboard badge only; never touches TickData or anything the replay harness pins.
const VENUE_CLOCK_POLL_MS = 3 * 60_000;

async function pollVenueClock(): Promise<void> {
  try {
    const status = await getMarketStatusSnapshot();
    ui.setVenueOpen(status.isOpen);
  } catch (err: any) {
    logger.warn(`[Boot] venue clock check failed: ${err.message}`);
    ui.setVenueOpen(null);
  }
}

let venueClockTimer: ReturnType<typeof setInterval> | undefined;

async function boot(): Promise<void> {
  await initializeAccount();
  await reconcileOnStartup();
  void pollVenueClock();
  venueClockTimer = setInterval(() => void pollVenueClock(), VENUE_CLOCK_POLL_MS);
  notifications.start();
  concierge.resumeQueue();
  scheduler.start();
  execution.start();
  await trader.start();
}
export async function run(): Promise<void> {
  try { await boot(); }
  catch (err) {
    try { logger.error('Startup failed: ' + (err instanceof Error ? err.message : String(err))); }
    catch { /* The entry point also writes the cause directly to stderr. */ }
    // Preserve the startup cause even if cleaning up a partial boot also fails.
    try { await stop('startup failure'); }
    finally { throw err; }
  }
}

let stopping: Promise<void> | undefined;
function stop(signal: string): Promise<void> {
  return stopping ??= stopResources(signal);
}

async function stopResources(signal: string): Promise<void> {
  logger.info('Shutting down: ' + signal);
  scheduler.stop();
  clearInterval(venueClockTimer);
  const agentsStopped = Promise.all([trader.stop(), concierge.stop()]);
  // Stop intake, drain the sole mutation executor, then close the durable store.
  const deadline = setTimeout(() => process.exit(1), 25_000);
  deadline.unref();
  await api?.close();
  await agentsStopped;
  await execution.stop();
  await notifications.stop();
  stopRuntime();
  closeStorage();
  clearTimeout(deadline);
}

async function shutdown(signal: string): Promise<void> {
  await stop(signal);
  ui.close();
  process.exit(0);
}

ui.onQuit(() => { void shutdown('operator quit'); });
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
