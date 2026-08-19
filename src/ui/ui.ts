/**
 * Terminal UI — blessed-based split layout:
 *   ┌─ AutoTrade ──────────────────────────────┐
 *   │  scrollable log + orchestrator replies   │
 *   ├──────────────────────────────────────────┤
 *   │  > operator input                        │
 *   └──────────────────────────────────────────┘
 *
 * Replaces raw process.stdout/stdin in daemon.ts.
 * Everything else (logger, orchestrator reply tool) writes
 * through the exported `ui` singleton.
 */

import * as blessed from 'blessed';
import { InputEditor } from './inputEditor';
import {
  POS_ROW_COLS,
  renderSidebar,
  renderStatus,
  renderStrip,
  type Cycle,
  type DashboardModel,
  type Environment,
  type Lane,
  type TickSnapshot,
} from './dashboard';
import { escapeTags, wrapPlain } from './format';
import { makeGlyphs, type Glyphs } from './glyphs';

// ── Palette ──────────────────────────────────────────────────────────────────

const COLORS = {
  info:  '{gray-fg}',
  warn:  '{yellow-fg}',
  error: '{red-fg}',
  trade: '{green-fg}',
  tool:  '{magenta-fg}',
  reply: '{cyan-fg}',
  // The five above are log LEVELS, so the operator's own voice gets the one hue none of them
  // claims — a green line in a trading log reads as a fill, a yellow one as a warning. Cool
  // family with the cyan reply, so an exchange still reads as one thread with two speakers.
  //
  // `light-blue`, NOT `lightblue`: a tag's dashes become spaces and the result is matched
  // against a switch of literal names in program.js (`case 'light blue fg'`), so `lightblue`
  // falls through to `attr == null` and blessed prints the braces on screen. colors.js does
  // list `lightblue: 12`, but that map serves `style` objects, not tags.
  user:  '{bold}{light-blue-fg}',
  reset: '{/}',
};

const LEVEL_LABEL: Record<string, string> = {
  INFO:  `${COLORS.info}INFO {/}`,
  WARN:  `${COLORS.warn}WARN {/}`,
  ERROR: `${COLORS.error}ERR  {/}`,
  TRADE: `${COLORS.trade}TRADE{/}`,
  TOOL:  `${COLORS.tool}TOOL {/}`,
};

/**
 * The two halves of one conversation. Kept together because they are formatted together: the
 * operator's line and the reply that answers it must start in the same column, or the exchange
 * reads as two unrelated events in a machine log.
 */
const CHAT_LABELS = {
  operator: 'OPERATOR',
  orchestrator: 'ORCHESTRATOR',
} as const;

/** Columns the widest `[LABEL] ` costs — derived, so adding a label cannot misalign the rest. */
const CHAT_GUTTER = Math.max(...Object.values(CHAT_LABELS).map((l) => l.length)) + 3;

/**
 * The column blessed keeps for the scrollbar. It is reserved in the WRAP width unconditionally
 * (`if (this.scrollbar) margin++`, element.js:616) whether or not the bar is currently drawn, so
 * a chat block must wrap one column short of the box interior or blessed re-breaks the row it
 * just aligned — putting the overflow back at column 0, which is the whole bug.
 */
const LOG_SCROLLBAR_COLS = 1;

/**
 * Text columns a chat block needs before the hanging indent stops paying for itself. Below this
 * the block DEMOTES — label on its own row, a two-column indent — the same bargain `layout()`
 * strikes for the panel: at 30 columns a 15-column gutter is most of the window, and alignment
 * bought by shredding the message one word per row is not alignment worth having.
 */
const CHAT_MIN_TEXT_COLS = 24;

// ── Layout ───────────────────────────────────────────────────────────────────

/**
 * Three ways to show the same model, chosen by how much room the terminal actually has.
 * `off` is not a failure state — on an 80x24 window the log IS the instrument, and stealing
 * a third of it for a panel would make the tool worse.
 */
type PanelMode = 'sidebar' | 'strip' | 'off';

/** Rows the prompt owns, border included. */
const INPUT_ROWS = 3;

/** Rows the status bar and prompt own at the bottom when the window can afford both. */
const CHROME_ROWS = INPUT_ROWS + 1;

/** The log is the primary instrument; a sidebar that would starve it below this demotes. */
const MIN_LOG_COLS = 44;

const SIDEBAR_MIN_COLS = 34;

/**
 * Widest the panel is ever allowed to grow: exactly one complete position row plus its borders.
 *
 * Read from the grid rather than written down, because the two must agree. `packRow` drops
 * columns right-to-left when the panel is narrower than a full row — correct on a small terminal,
 * but a ceiling below the row width applies that truncation on a 200-column terminal too, where
 * there is nothing to truncate for. Adding a column to `POS_GRID` therefore widens this on its
 * own; it does not quietly cost the rightmost one instead.
 */
const SIDEBAR_MAX_COLS = POS_ROW_COLS + 2;

/** 3 rendered lines + 2 border rows. `renderStrip` is contractually exactly 3 lines. */
const STRIP_ROWS = 5;

/**
 * Log stamp: LOCAL wall-clock HH:MM:SS.mmm. Deliberately not `toISOString()`, which is always
 * UTC — the operator reads a log line against the clock on their own wall. Built from the
 * local getters rather than `toLocaleTimeString`, which carries no milliseconds and would let
 * a small-ICU Node build pick its own separators. Market time is a separate question: session
 * gating and the dashboard clock stay pinned to ET regardless of where the operator sits.
 */
function stamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ── UI singleton ─────────────────────────────────────────────────────────────

/**
 * What the approval gate hands over, structurally.
 *
 * A copy of `ApprovalRequest` from `core/approvals.ts` rather than an import, for the reason
 * documented on `setTick`: that module imports `core/config`, which THROWS at import when
 * `AI_API_KEY` is absent, and this file is reached by probe scripts. Structural typing keeps
 * the compile-time check without adding the edge — `daemon.ts` assigns `askApproval` into the
 * `ApprovalChannel` slot, so a drift in the real shape fails there.
 */
export interface ApprovalPrompt {
  action: 'entry' | 'exit';
  symbol: string;
  venue: 'paper' | 'live';
  qty: number;
  price: number | null;
  notional: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  pnl: number | null;
  reason: string;
  /** Absolute epoch ms. The same number the gate is timing against. */
  deadline: number;
}

/** Exact, case-insensitive, trimmed. A near-miss must reach the concierge, not the venue. */
const APPROVE_WORDS = /^(y|yes|approve|ok|go)$/i;
const DENY_WORDS = /^(n|no|deny|reject|cancel|stop)$/i;

class TerminalUI {
  private screen: blessed.Widgets.Screen;
  private logBox: blessed.Widgets.Log;
  private input: InputEditor;
  private statusBar: blessed.Widgets.BoxElement;
  private sidebar: blessed.Widgets.BoxElement;
  private strip: blessed.Widgets.BoxElement;
  private onSubmit?: (line: string) => void;

  // ── Dashboard state ──
  // Everything the panel draws is PUSHED here by whoever already knows it, and nothing in this
  // class ever reads a broker, a config or a clock other than `Date.now()`. That is what keeps
  // `src/ui/` importable by probe scripts and what keeps the panel free of new API calls.
  private glyphs: Glyphs;
  private mode: PanelMode = 'off';
  private panelEnabled = true;
  private tick: TickSnapshot | null = null;
  private env: Environment = { broker: '', venue: '', provider: '', model: '' };
  private traderLane: Lane = { state: 'starting' };
  /**
   * The one approval on screen, if any. `prevLane` is captured on entry and restored on
   * settle: this is the only code that knows the trader is stopped at the gate, so it is also
   * the only code that can put the lane back to whatever it was saying before.
   */
  private approval: {
    req: ApprovalPrompt;
    resolve: (answer: 'approve' | 'deny') => void;
    prevLane: Lane;
  } | null = null;
  private conciergeLane: Lane = { state: 'idle' };
  private cycleInfo: Cycle = { n: 0 };
  /** Advances once a second. Drives the spinner and the session blink — nothing else. */
  private frame = 0;
  private paintFailed = false;
  private ticker: NodeJS.Timeout;
  /**
   * Whether the last line written to the log was blank. Starts true so the first chat block
   * does not open with a wasted row at the top of an empty box.
   */
  private lastBlank = true;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'AutoTrade',
      fullUnicode: true,
      // Mouse disabled so the terminal retains native text selection / copy-paste
    });

    // Which characters this terminal may be shown. Blessed has already resolved unicode
    // support from terminfo (`tput.unicode || tput.numbers.U8 === 1`) and maps anything it
    // cannot draw to '?', so its verdict is the honest one — far better than guessing from
    // `process.platform`, which is right about neither Windows Terminal nor `TERM=linux`.
    this.glyphs = makeGlyphs(Boolean((this.screen as any)._unicode));

    // ── Log area ─────────────────────────────────────────────────────────────
    this.logBox = blessed.log({
      parent: this.screen,
      top: 0,
      left: 0,
      right: 0,
      bottom: 4,
      border: { type: 'line' },
      style: {
        border: { fg: 'blue' },
      },
      label: ' {bold}{blue-fg}AutoTrade{/} {gray-fg}— Trader Log{/} ',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '│',
        style: { fg: 'blue' },
      },
      keys: true,
      vi: true,
      padding: { left: 1, right: 1 },
    });

    // ── Status bar ────────────────────────────────────────────────────────────
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 3,
      left: 0,
      right: 0,
      height: 1,
      style: { bg: 'blue', fg: 'white' },
      tags: true,
      // One row high: a wrap here would not spill, it would silently CUT the line short.
      wrap: false,
      content: ' {bold}AutoTrade{/}  |  Enter send  |  ←/→ ⌥←/→ edit  |  ↑/↓ history  |  Esc clear  |  PgUp/PgDn scroll  |  Ctrl+C quit',
      padding: { left: 1 },
    });

    // ── Input area ────────────────────────────────────────────────────────────
    this.input = new InputEditor({
      parent: this.screen,
      bottom: 0,
      left: 0,
      right: 0,
      height: 3,
      border: { type: 'line' },
      style: {
        border: { fg: 'blue' },
        focus: { border: { fg: 'cyan' } },
        label: { fg: 'cyan' },
      },
      label: ' Operator ',
      padding: { left: 1 },
    });

    // ── Live panel ───────────────────────────────────────────────────────
    // Built once, geometry and visibility owned entirely by `layout()`. Both are created
    // hidden: `layout()` runs before the first render and decides what this terminal can hold.
    this.sidebar = blessed.box({
      parent: this.screen,
      top: 0,
      right: 0,
      width: SIDEBAR_MIN_COLS,
      bottom: CHROME_ROWS,
      border: { type: 'line' },
      style: { border: { fg: 'blue' } },
      label: ' {bold}{blue-fg}Live{/} ',
      tags: true,
      // Blessed decides whether to wrap from the RAW string length, escape codes included
      // (element.js:641), so a row whose VISIBLE width is exactly the content width still gets
      // word-wrapped when colour tags trail after its last character — which is what pushed
      // `stop` and `rsi` onto lines of their own. These renderers measure their own widths, so
      // reflow can only ever be wrong here: clip instead.
      wrap: false,
      hidden: true,
    });

    this.strip = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      right: 0,
      height: STRIP_ROWS,
      border: { type: 'line' },
      style: { border: { fg: 'blue' } },
      label: ' {bold}{blue-fg}Live{/} ',
      tags: true,
      // Same reason as the sidebar: `renderStrip` is exactly 3 measured lines, never 4 reflowed.
      wrap: false,
      hidden: true,
    });

    // ── Key bindings ─────────────────────────────────────────────────────────
    this.screen.key(['C-c'], () => process.exit(0));

    // Tab returns focus to the prompt from anywhere (e.g. after log scrolling)
    this.screen.key('tab', () => this.input.focus());

    // F2 is safe next to the editor: blessed only sets `ch` for single-character keys
    // (keys.js:313), so a function key cannot be typed into the prompt as a stray glyph.
    this.screen.key('f2', () => {
      this.panelEnabled = !this.panelEnabled;
      this.layout();
      this.paint();
    });

    // Blessed renders once with the old geometry before emitting this, so the relayout costs
    // at most one stale frame — and never a wrong-sized panel that persists.
    this.screen.on('resize', () => {
      this.layout();
      this.paint();
    });

    this.input.onSubmit((line) => {
      this.appendUserMessage(line);
      // The approval answer is matched HERE, before anything reaches the concierge: the
      // decision to send an order to a live venue must not pass through a language model, and
      // the concierge has no approval tool precisely so it cannot answer on the operator's
      // behalf. Anything that is not an exact yes or no falls through to the conversation as
      // it always did, with a reminder that the gate is still holding.
      if (this.approval) {
        const answer = line.trim();
        if (APPROVE_WORDS.test(answer)) return this.settleApproval('approve');
        if (DENY_WORDS.test(answer)) return this.settleApproval('deny');
        this.log('WARN', `Still waiting on y/n for ${this.approval.req.action} ${this.approval.req.symbol} — that message goes to the concierge, not to the gate.`);
      }
      this.onSubmit?.(line);
    });

    // Scroll log with Page Up/Down even when input is focused
    this.input.el.key('pageup',   () => { this.logBox.scroll(-this.logBox.height as number); this.screen.render(); });
    this.input.el.key('pagedown', () => { this.logBox.scroll(this.logBox.height as number);  this.screen.render(); });

    this.input.focus();
    this.layout();
    this.paint();

    // The only timer in the UI. It repaints the panel and the status line — never the log,
    // which is appended to — so the clock, the sleep countdown, the spinner and the "tick 4s
    // ago" age all advance with no polling of anything. `unref()` so a probe script that
    // imports this module is not held open by one more handle.
    this.ticker = setInterval(() => {
      this.frame++;
      this.expireApproval();
      this.paint();
    }, 1000);
    this.ticker.unref();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  onMessage(handler: (line: string) => void): void {
    this.onSubmit = handler;
  }

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'TOOL', msg: string): void {
    const ts    = stamp();
    const label = LEVEL_LABEL[level] ?? level;
    const line  = level === 'TRADE'
      ? `{gray-fg}${ts}{/}  ${label}  {bold}{green-fg}${this.escape(msg)}{/}`
      : `{gray-fg}${ts}{/}  ${label}  ${this.escape(msg)}`;
    this.emit(line);
    this.screen.render();
  }

  reply(msg: string): void {
    this.chatBlock(CHAT_LABELS.orchestrator, COLORS.reply, msg);
  }

  /**
   * Timestamped like every other line, but in the alert's own colour rather than the
   * log's gray — an alert that is dated the same way as a TOOL line reads as one.
   *
   * Multi-line by necessity: `router.ts` packs a whole tick's events into one call, so
   * continuation lines are padded into the same column as the first.
   */
  alert(msg: string): void {
    const ts = stamp();
    const marker = '⚠ ALERT';
    const gutter = ' '.repeat(ts.length + 2 + marker.length + 2);

    this.emit('');
    msg.split('\n').forEach((line, i) => {
      const prefix = i === 0
        ? `{bold}${COLORS.warn}${ts}{/}  {bold}${COLORS.warn}${marker}{/}  `
        : gutter;
      this.emit(`${prefix}${this.escape(line)}`);
    });
    this.emit('');
    this.screen.render();
  }


  /**
   * Put an order in front of the operator and wait for `y` or `n`.
   *
   * Registered as the gate's channel by `daemon.ts` — nothing here decides WHETHER to ask;
   * `core/approvals.ts` owns that, and this is only how a human is reached.
   *
   * The promise may be ABANDONED: the gate races it against its own deadline timer, so a
   * lapse settles over there and this one is simply never awaited again. That is why
   * `expireApproval` clears the slot without resolving — see the note on it.
   */
  askApproval(req: ApprovalPrompt): Promise<'approve' | 'deny'> {
    // Defensive, and a refusal rather than a queue: the gate already serialises requests, so
    // reaching here means two prompts would share one screen and one `y`.
    if (this.approval) {
      this.log('WARN', `Second approval for ${req.action} ${req.symbol} refused — ${this.approval.req.symbol} still on screen.`);
      return Promise.resolve('deny');
    }

    const f = (n: number | null, prefix = '$') => (n == null ? '—' : `${prefix}${n.toFixed(2)}`);
    const verb = req.action === 'entry' ? 'BUY' : 'SELL';
    const mins = Math.max(1, Math.round((req.deadline - Date.now()) / 60_000));

    const lines = [
      `${verb} ${req.qty} ${req.symbol} on the ${req.venue.toUpperCase()} account`,
      `  price ${f(req.price)}   notional ${f(req.notional)}`,
      req.action === 'entry'
        ? `  stop ${f(req.stopLoss)}   target ${f(req.takeProfit)}`
        : `  unrealized ${req.pnl == null ? '—' : `${req.pnl >= 0 ? '+' : '-'}$${Math.abs(req.pnl).toFixed(2)}`}`,
      `  reason: ${req.reason}`,
      `Type y to approve, n to deny. No answer within ~${mins} min and it is refused.`,
    ];
    this.prompt(lines.join('\n'), req.venue === 'live');

    // The bell is the point of the whole feature on a live account: the operator may not be
    // looking at this window, and the alternative to a noise is a silent ten-minute timeout.
    process.stdout.write('\x07');

    return new Promise((resolve) => {
      this.approval = { req, resolve, prevLane: this.traderLane };
      this.traderLane = {
        state: 'awaiting',
        until: req.deadline,
        detail: `${req.action} ${req.symbol}`,
      };
      this.paint();
    });
  }

  // ── Dashboard inputs ─────────────────────────────────────────────────────

  /**
   * The 60s scheduler tick, handed over on its way past.
   *
   * Typed structurally against `TickSnapshot` rather than importing `TickData`: that import
   * would drag `features/compute` → `collect/*` → `core/config`, which THROWS at import when
   * `AI_API_KEY` is absent, and this module is imported by probe scripts. Structural typing
   * gives the same compile-time guarantee with no edge in the graph.
   */
  setTick(tick: TickSnapshot): void {
    this.tick = tick;
    this.paint();
  }

  /** Pushed from `daemon.ts`, the one place allowed to read config. */
  setEnvironment(env: Environment): void {
    this.env = env;
    this.paint();
  }

  setTraderActivity(lane: Lane): void {
    this.traderLane = lane;
    this.paint();
  }

  setConciergeActivity(lane: Lane): void {
    this.conciergeLane = lane;
    this.paint();
  }

  setCycle(cycle: Cycle): void {
    this.cycleInfo = cycle;
    this.paint();
  }

  /**
   * Back-compat shim for callers that still push a bare string.
   *
   * It lands on the TRADER lane, which is where every historical caller meant it to go — and
   * why it is a shim rather than the API: the concierge writing 'ready' used to erase
   * 'sleeping — next cycle in 7 min', because one line held two agents' states.
   */
  setStatus(text: string): void {
    this.traderLane = { state: 'idle', detail: text };
    this.paint();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * The approval block. `alert`'s shape — blank row, dated first line, continuations padded
   * into the same column — with its own marker so it cannot be skimmed as one more warning,
   * and red on a live venue because that is the only detail that changes what it costs to
   * get this wrong.
   */
  private prompt(msg: string, live: boolean): void {
    const ts = stamp();
    const marker = '▶ APPROVE?';
    const color = live ? COLORS.error : COLORS.warn;
    const gutter = ' '.repeat(ts.length + 2 + marker.length + 2);

    this.emit('');
    msg.split('\n').forEach((line, i) => {
      const prefix = i === 0
        ? `{bold}${color}${ts}{/}  {bold}${color}${marker}{/}  `
        : gutter;
      this.emit(`${prefix}{bold}${color}${this.escape(line)}{/}`);
    });
    this.emit('');
    this.screen.render();
  }

  /** Hand the answer back and put the screen back the way it was. */
  private settleApproval(answer: 'approve' | 'deny'): void {
    const pending = this.approval;
    if (!pending) return;
    // Cleared BEFORE resolving, so a handler that immediately asks for another approval finds
    // an empty slot rather than a busy one.
    this.approval = null;
    this.traderLane = pending.prevLane;
    this.log(answer === 'approve' ? 'TRADE' : 'WARN',
      `Operator ${answer === 'approve' ? 'approved' : 'denied'} ${pending.req.action} ${pending.req.symbol}.`);
    pending.resolve(answer);
    this.paint();
  }

  /**
   * Drop a prompt whose window has closed. Called from the 1s repaint, which is already
   * counting the same `deadline` down on screen.
   *
   * Deliberately does NOT resolve the promise. The gate settles a lapse on its own timer, by
   * `policy.approval.onTimeout` — and with `onTimeout: allow` a `deny` from here landing a
   * moment first would silently overturn the operator's configured choice. Clearing the slot
   * is this side's whole job: it stops a `y` typed at the dead prompt from being read as an
   * answer to it.
   */
  private expireApproval(): void {
    const pending = this.approval;
    if (!pending || Date.now() < pending.req.deadline) return;
    this.approval = null;
    this.traderLane = pending.prevLane;
    this.log('WARN', `Approval window closed for ${pending.req.action} ${pending.req.symbol} — settled by policy, not by you.`);
  }

  /**
   * The operator's message, echoed in the log so the transcript holds both halves of the
   * exchange. Rendered exactly like the reply that answers it — same framing, same gutter —
   * because it IS the other half: an un-labelled `user:` line with no timestamp read as
   * neither a log entry nor a chat turn.
   */
  private appendUserMessage(msg: string): void {
    this.chatBlock(CHAT_LABELS.operator, COLORS.user, msg);
  }

  /**
   * One turn of the operator↔orchestrator conversation, set off from the machine log by a blank
   * row on each side rather than by a timestamp — a dated line reads as part of the log
   * (see `alert`), and this is the one thing in the box that is not.
   *
   * Wrapped here rather than by blessed, and every row padded into the text column, so no part
   * of a long reply can masquerade as a new speaker. Rows are measured against the width the box
   * has RIGHT NOW; a later resize leaves them at the breaks they were written with, exactly as
   * for any other line already in the scrollback.
   */
  private chatBlock(label: string, color: string, msg: string): void {
    // What is left of the box interior once the scrollbar and the indent are paid for.
    const room = this.innerWidth(this.logBox) - LOG_SCROLLBAR_COLS;
    const narrow = room - CHAT_GUTTER < CHAT_MIN_TEXT_COLS;
    const indent = narrow ? 2 : CHAT_GUTTER;
    // A window too narrow even for this hands `wrapPlain` a non-positive width, which returns
    // the line whole and lets blessed wrap it as it always did — degraded, never lost.
    const textCols = room - indent;

    this.emit('');
    if (narrow) this.emit(`${color}[${label}]{/}`);

    let first = true;
    for (const source of msg.split('\n')) {
      for (const row of wrapPlain(source, textCols)) {
        const prefix = !narrow && first ? `[${label}]`.padEnd(CHAT_GUTTER) : ' '.repeat(indent);
        first = false;
        // A paragraph break stays a genuinely empty row: a row of indent spaces looks identical
        // on screen but arrives as whitespace in the operator's clipboard.
        this.emit(row === '' && !prefix.trim() ? '' : `${color}${prefix}${this.escape(row)}{/}`);
      }
    }
    this.emit('');
    this.screen.render();
  }

  /**
   * The single door to the log box, so that the blank rows framing a chat block can never
   * double up — the operator's trailing blank and the reply's leading one are the same row, and
   * the concierge emits one `reply()` per content block.
   */
  private emit(line: string): void {
    if (line === '') {
      if (this.lastBlank) return;
      this.lastBlank = true;
    } else {
      this.lastBlank = false;
    }
    this.logBox.log(line);
  }

  /**
   * Delegates so a log line and a panel row can never disagree about what a brace means.
   * Kept as a method because it is called from `captureStreams`'s closure as `self.escape`.
   */
  private escape(s: string): string {
    return escapeTags(s);
  }

  // ── Layout & paint ───────────────────────────────────────────────────────

  /**
   * Decide the mode from the room available and move the widgets to match.
   *
   * The thresholds are about usefulness, not about crashing: blessed will happily render a
   * 12-column panel, it just would not tell the operator anything. Every dimension is derived
   * by subtraction from the real screen size and clamped, so no arithmetic here can produce a
   * negative width when the window is dragged to one column.
   */
  private layout(): void {
    const w = Math.max(1, Number(this.screen.width) || 80);
    const h = Math.max(1, Number(this.screen.height) || 24);

    // Bottom chrome, in priority order. Blessed derives a widget's height by subtraction, so
    // asking for 4 rows of chrome on a 3-row window hands the log a NEGATIVE height — which is
    // the garbled-resize failure this method exists to prevent, not a cosmetic one. The log must
    // keep at least one row, so on a very short window the status bar goes first (its lanes also
    // read out in the panel) and the prompt second. Both return on the next resize.
    const showInput = h >= INPUT_ROWS + 1;
    const showStatus = h >= INPUT_ROWS + 2;
    const chromeRows = (showInput ? INPUT_ROWS : 0) + (showStatus ? 1 : 0);

    let mode: PanelMode = 'off';
    if (this.panelEnabled) {
      if (w >= 100 && h >= 18) mode = 'sidebar';
      else if (w >= 60 && h >= 15) mode = 'strip';
    }

    let sidebarCols = 0;
    if (mode === 'sidebar') {
      // 0.40, not the 0.34 this started at: at 0.34 a 100-column terminal — the exact width that
      // qualifies for sidebar mode at all — got 34 columns, which is one column short of a
      // position row's `stop`. The list is SORTED by distance to stop, so that was the one column
      // whose absence made the row order look arbitrary. The `SIDEBAR_MAX_COLS` cap and the
      // `MIN_LOG_COLS` floor below both still apply, so a wide window cannot run away with this.
      sidebarCols = Math.min(SIDEBAR_MAX_COLS, Math.max(SIDEBAR_MIN_COLS, Math.floor(w * 0.4)));
      sidebarCols = Math.min(sidebarCols, w - MIN_LOG_COLS);
      // Demote rather than shrink: a panel too narrow for a position row is worse than the
      // strip, which says less but says it legibly.
      if (sidebarCols < SIDEBAR_MIN_COLS) mode = 'strip';
    }
    // The strip needs its own rows AND a log worth reading underneath it.
    if (mode === 'strip' && h < STRIP_ROWS + CHROME_ROWS + 3) mode = 'off';

    this.mode = mode;

    // The prompt sits at the bottom; the status bar rides directly above it, or takes the bottom
    // row itself once the prompt has been dropped.
    if (showInput) this.input.el.show();
    else this.input.el.hide();
    if (showStatus) {
      this.statusBar.bottom = showInput ? INPUT_ROWS : 0;
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }

    if (mode === 'sidebar') {
      this.sidebar.width = sidebarCols;
      this.sidebar.top = 0;
      this.sidebar.bottom = chromeRows;
      this.sidebar.show();
      this.strip.hide();
      this.logBox.top = 0;
      this.logBox.right = sidebarCols;
      this.logBox.bottom = chromeRows;
    } else if (mode === 'strip') {
      this.strip.top = 0;
      this.strip.height = STRIP_ROWS;
      this.strip.show();
      this.sidebar.hide();
      this.logBox.top = STRIP_ROWS;
      this.logBox.right = 0;
      this.logBox.bottom = chromeRows;
    } else {
      this.sidebar.hide();
      this.strip.hide();
      this.logBox.top = 0;
      this.logBox.right = 0;
      this.logBox.bottom = chromeRows;
    }

    // Reallocate rather than trusting a diff render: the widget that just shrank leaves its old
    // characters in the screen buffer, and a stale border column is exactly the "garbled on
    // resize" symptom this layout exists to avoid.
    this.screen.realloc();
  }

  /**
   * Repaint the panel and the status line from the current model.
   *
   * Wrapped whole: a formatting bug here would otherwise run once a second, and once a second
   * inside the trading daemon's own process. It degrades to one red line and one log entry.
   */
  private paint(): void {
    try {
      const m = this.model();

      if (this.mode === 'sidebar') {
        const width = this.innerWidth(this.sidebar);
        const height = this.innerHeight(this.sidebar);
        this.sidebar.setContent(renderSidebar(m, width, height).join('\n'));
      } else if (this.mode === 'strip') {
        this.strip.setContent(renderStrip(m, this.innerWidth(this.strip)).join('\n'));
      }

      this.statusBar.setContent(renderStatus(m, this.innerWidth(this.statusBar), this.panelHint()));
      this.screen.render();
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.sidebar.setContent(`{red-fg}panel render failed{/}`);
      this.strip.setContent(`{red-fg}panel render failed{/}`);
      // Once only: this runs on a 1s timer, and a per-second error log would bury the trading
      // record it shares a file with.
      if (!this.paintFailed) {
        this.paintFailed = true;
        this.emit(`{red-fg}UI panel render failed (panel disabled visually): ${escapeTags(msg)}{/}`);
      }
      try {
        this.screen.render();
      } catch {
        /* a render that cannot render is nothing this process can fix */
      }
    }
  }

  private model(): DashboardModel {
    return {
      env: this.env,
      tick: this.tick,
      trader: this.traderLane,
      concierge: this.conciergeLane,
      cycle: this.cycleInfo,
      now: Date.now(),
      frame: this.frame,
      glyphs: this.glyphs,
    };
  }

  private panelHint(): string {
    if (!this.panelEnabled) return 'F2 panel on';
    return this.mode === 'off' ? 'F2 panel (needs a bigger window)' : 'F2 panel off';
  }

  /** Columns inside the borders and padding. `iwidth` is what the frame costs. */
  private innerWidth(el: blessed.Widgets.BoxElement): number {
    return Math.max(1, (Number(el.width) || 0) - (Number((el as any).iwidth) || 0));
  }

  private innerHeight(el: blessed.Widgets.BoxElement): number {
    return Math.max(1, (Number(el.height) || 0) - (Number((el as any).iheight) || 0));
  }

  /**
   * Redirect raw process.stdout / process.stderr writes into the log box.
   * Blessed itself writes ANSI escape sequences (\x1b…) to paint the screen —
   * those are passed straight through to the real fd so the layout isn't broken.
   * Everything else (console.log, third-party warnings, etc.) is captured.
   */
  captureStreams(): void {
    const self = this;
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);

    const makeCapture = (orig: (...a: any[]) => boolean) =>
      (chunk: any, enc?: any, cb?: any): boolean => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        // Pass through blessed's own terminal-control sequences untouched
        if (str.startsWith('\x1b') || str === '\n' || str === '\r\n') {
          return orig(chunk, enc, cb);
        }
        const text = str.replace(/\r?\n$/, '');
        if (text.trim()) {
          for (const line of text.split(/\r?\n/)) {
            if (line.trim()) self.emit(`{gray-fg}${self.escape(line)}{/}`);
          }
          self.screen.render();
        }
        if (typeof enc === 'function') enc();
        else cb?.();
        return true;
      };

    (process.stdout as any).write = makeCapture(origOut);
    (process.stderr as any).write = makeCapture(origErr);
  }
}

export const ui = new TerminalUI();
