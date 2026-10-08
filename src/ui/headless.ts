import { subscribeActivity } from '../core/storage';
/**
 * The UI with no screen — for running the bot on a server.
 *
 * Selected by `HEADLESS=1` (see `surface.ts`). It takes the same calls as the blessed
 * `TerminalUI`, but instead of painting it:
 *
 *   - prints every log line to stdout as plain text, so `docker logs` / journald hold it;
 *   - keeps the latest dashboard state (tick, actions, lanes, ...) for the API to read;
 *   - keeps a bounded FEED of everything a terminal operator would have seen in the log box —
 *     log lines, replies, charts, alerts, and the operator's own messages — numbered, so a
 *     web client can ask for "everything after #N" or stream it live.
 *
 * Input arrives through `submit()` (a typed line, same grammar as the terminal) or
 * `runCommand()` (one slash command, with its replies handed back to the caller), both called
 * from `server/api.ts`.
 *
 * Holds no timers and no open handles, so a script that imports `ui` under `HEADLESS=1`
 * still exits on its own.
 */
import { notifyAccount } from '../core/notifications';
import { appendActivity, readActivity } from '../core/storage';
import { AsyncLocalStorage } from 'async_hooks';
import { decideAction } from '../core/actions';
import type { Cycle, DailyUsage, Environment, EventRow, Lane, ActionRow, TickSnapshot } from './dashboard';
import { DECIDE_COMMAND, type LogLevel, type OperatorUI, type SlashCommand } from './surface';
import type { ChartData } from './chart';
import type { ToolCallDetails } from '../core/types';
import { agentContext } from '../core/agentContext';

/** Enough for a few hours of a busy session; older entries are dropped from the front. */
const FEED_CAPACITY = 2000;

export type FeedKind = 'log' | 'reply' | 'chart' | 'alert' | 'operator';

export interface FeedEntry {
  /** Strictly increasing, never reused — clients resume with `after=<seq>`. */
  seq: number;
  at: string;
  kind: FeedKind;
  /** Who produced the entry, independent of whether it is prose, a chart, or a log. */
  source?: string;
  /** Set for `kind: 'log'` only. */
  level?: LogLevel;
  text: string;
  chart?: ChartData;
  /** Full tool inputs/outputs for both feed history and live events; never display-truncated. */
  tool?: ToolCallDetails;
}

export interface HeadlessSnapshot {
  env: Environment;
  venueOpen: boolean | null;
  traderLane: Lane;
  assistantLane: Lane;
  cycle: Cycle;
  tick: TickSnapshot | null;
  events: EventRow[];
  activity: EventRow[];
  actions: ActionRow[];
  usage?: DailyUsage;
}

export interface CommandResult {
  ok: boolean;
  /** What the command said — every `reply`/`replyChart`/`log` it made while it ran. */
  output: FeedEntry[];
  error?: string;
}

export class HeadlessUI implements OperatorUI {
  private onSubmit?: (line: string) => void;
  private commands = new Map<string, SlashCommand>();
  private commandOrder: SlashCommand[] = [];

  private feed: FeedEntry[] = [];
  private listeners = new Set<(entry: FeedEntry) => void>();
  private tickListeners = new Set<() => void>();
  /**
   * Which command run (if any) the current async call chain belongs to. A command like
   * `/status` awaits the broker, and other log lines land meanwhile; tagging by async context
   * rather than by "everything between start and end" keeps those out of its result.
   */
  private capture = new AsyncLocalStorage<FeedEntry[]>();

  private state: HeadlessSnapshot = {
    env: { broker: '', venue: '', provider: '', model: '' },
    venueOpen: null,
    traderLane: { state: 'starting' },
    assistantLane: { state: 'idle' },
    cycle: { n: 0 },
    tick: null,
    events: [],
    activity: [],
    actions: [],
  };

  constructor() {
    this.registerCommand({
      name: 'help',
      aliases: ['?', 'commands'],
      help: 'List every command.',
      api: true,
      run: () => this.reply(this.listCommands().filter((c) => c.api)
        .map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${c.help}`)
        .join('\n')),
    });
  }

  // ── OperatorUI ───────────────────────────────────────────────────────────

  onMessage(handler: (line: string) => void): void {
    this.onSubmit = handler;
  }

  /**
   * A no-op: there is no keyboard to quit from, and deliberately no API route that stops the
   * process — a server's lifecycle belongs to its supervisor (SIGTERM), not to a web client.
   */
  onQuit(_handler: () => void): void {}

  registerCommand(cmd: SlashCommand): void {
    for (const key of [cmd.name, ...(cmd.aliases ?? [])]) {
      const prev = this.commands.get(key);
      if (prev) this.commandOrder = this.commandOrder.filter((c) => c !== prev);
      this.commands.set(key, cmd);
    }
    this.commandOrder.push(cmd);
  }

  log(level: LogLevel, msg: string, tool?: ToolCallDetails): void {
    const entry = this.push('log', msg, level, undefined, tool);
    const out = `[${entry.at}] ${level.padEnd(5)} ${msg}\n`;
    (level === 'ERROR' ? process.stderr : process.stdout).write(out);
  }

  reply(msg: string): void {
    this.push('reply', msg);
    process.stdout.write(`[${new Date().toISOString()}] REPLY ${msg}\n`);
  }

  replyChart(lines: string[]): void {
    this.push('chart', lines.join('\n'));
    process.stdout.write(lines.join('\n') + '\n');
  }

  showChart(data: ChartData): void {
    this.push('chart', data.kind === 'price' ? data.label : `${data.a.label} / ${data.b.label} performance`, undefined, data);
  }

  alert(msg: string): void {
    notifyAccount('alert', msg);
    this.push('alert', msg);
    process.stdout.write(`[${new Date().toISOString()}] ALERT ${msg}\n`);
  }

  setTick(tick: TickSnapshot): void {
    this.state.tick = tick;
    for (const l of this.tickListeners) l();
  }

  setEvents(events: EventRow[], eventLog: EventRow[]): void {
    this.state.events = events;
    this.state.activity = eventLog;
  }

  setActions(actions: ActionRow[]): void {
    this.state.actions = actions;
  }

  setEnvironment(env: Environment): void {
    this.state.env = env;
  }

  setVenueOpen(open: boolean | null): void {
    this.state.venueOpen = open;
  }

  setTraderActivity(lane: Lane): void {
    this.state.traderLane = lane;
  }

  setAssistantActivity(lane: Lane): void {
    this.state.assistantLane = lane;
  }

  setCycle(cycle: Cycle): void {
    this.state.cycle = cycle;
  }

  setDailyUsage(usage: DailyUsage): void {
    this.state = { ...this.state, usage };
  }

  setStatus(text: string): void {
    this.state.traderLane = { state: 'idle', detail: text };
  }

  /** Nothing to protect: with no screen, stray stdout writes are just more log output. */
  captureStreams(): void {}
  close(): void {}

  // ── For the API ──────────────────────────────────────────────────────────

  snapshot(): HeadlessSnapshot {
    return this.state;
  }

  listCommands(): SlashCommand[] {
    return [...this.commandOrder];
  }

  /** Entries with `seq > after`, oldest first, at most `limit` of them. */
  feedAfter(after: number, limit: number): FeedEntry[] {
    return limit > 0 ? readActivity<FeedEntry>(after, limit) : [];
  }

  /** Called for every new feed entry. Returns an unsubscribe function. */
  subscribe(listener: (entry: FeedEntry) => void): () => void {
    return subscribeActivity(listener);
  }

  /** Called after every scheduler tick. Returns an unsubscribe function. */
  subscribeTicks(listener: () => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /** Record what the operator typed in the browser, so the conversation shows both sides. */
  echoOperator(line: string): void {
    const trimmed = line.trim();
    if (trimmed) this.push('operator', trimmed);
  }

  /**
   * One typed line, exactly as the terminal would take it: `/command`, `approve <id>`,
   * `reject <id> [reason]`, or else a chat message for the assistant.
   */
  submit(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.push('operator', trimmed);
    if (trimmed.startsWith('/')) {
      const [head, ...rest] = trimmed.slice(1).split(/\s+/);
      void this.runCommand(head, rest.join(' '));
      return;
    }
    const match = DECIDE_COMMAND.exec(trimmed);
    if (match) {
      try {
        this.decide(match[1].toLowerCase() as 'approve' | 'reject', match[2], match[3]);
      } catch {
        // Already logged by `decide`; a chat line has no caller to hand the error to.
      }
      return;
    }
    this.onSubmit?.(trimmed);
  }

  /** Run one slash command and hand back what it said. Unknown names never reach the assistant. */
  async runCommand(name: string, args: string): Promise<CommandResult> {
    const output: FeedEntry[] = [];
    const cmd = this.commands.get(name.toLowerCase());
    if (!cmd) {
      return { ok: false, output, error: `Unknown command /${name} — GET /api/commands for the list.` };
    }
    return this.capture.run(output, async () => {
      try {
        await cmd.run(args.trim());
        return { ok: true, output };
      } catch (err: any) {
        const error = `/${cmd.name} failed: ${err?.message ?? String(err)}`;
        this.log('WARN', error);
        return { ok: false, output, error };
      }
    });
  }

  /**
   * Same as the terminal's `approve`/`reject`: a synchronous state change on the action store.
   * `strategy/actionExecutor.ts` picks an approved action up on its own next tick.
   * Throws on an unknown id or an illegal transition so the API can answer with an error.
   */
  decide(decision: 'approve' | 'reject', id: string, reason?: string, actorId = 'operator'): void {
    try {
      const p = decideAction(id, decision, 'human', reason?.trim() || undefined, actorId);
      this.log('TRADE', `Operator ${decision === 'approve' ? 'approved' : 'rejected'} ${p.id} (${p.kind} ${p.symbol}).`);
    } catch (err: any) {
      this.log('WARN', `Could not ${decision} ${id}: ${err?.message ?? String(err)}`);
      throw err;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private push(kind: FeedKind, text: string, level?: LogLevel, chart?: ChartData, tool?: ToolCallDetails): FeedEntry {
    const source = kind === 'operator' ? 'operator' : tool?.agent ?? agentContext.getStore()?.role ?? 'system';
    const payload = { at: new Date().toISOString(), kind, source, text, ...(level ? { level } : {}), ...(chart ? { chart } : {}), ...(tool ? { tool } : {}) };
    const entry: FeedEntry = { ...payload, seq: appendActivity(payload) };
    if (level) entry.level = level;
    this.feed.push(entry);
    if (this.feed.length > FEED_CAPACITY) this.feed.splice(0, this.feed.length - FEED_CAPACITY);
    this.capture.getStore()?.push(entry);
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        // A broken stream client must never break logging.
      }
    }
    return entry;
  }
}
