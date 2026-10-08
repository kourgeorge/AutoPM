import type { OperatorUI, SlashCommand } from '../ui/surface';
import type { HeadlessSnapshot, FeedEntry } from '../ui/headless';

type RemoteCommand = Omit<SlashCommand, 'run'>;
type TerminalView = OperatorUI & { echoOperator(text: string): void };
interface Projection {
  instanceId: string;
  snapshot: HeadlessSnapshot;
  entries: FeedEntry[];
  health: { ready: boolean; paused: boolean; issues: string[] };
}

/** Read-only polling plus explicit command requests; no storage or broker imports. */
export class TerminalClient {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private cursor: number | undefined;
  private instanceId?: string;
  private connected = false;
  private stopped = false;
  private healthSummary = '';

  constructor(private readonly engine: URL, private readonly view: TerminalView) {}

  start(): void { void this.poll(); }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.controller.abort(); }

  private async request<T>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL('/api/' + route, this.engine), {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(body === undefined ? 5000 : 60_000)]),
    });
    const value = await response.json() as any;
    if (!response.ok) throw new Error(value.error ?? `Engine returned ${response.status}`);
    return value as T;
  }

  /** Mutations are never retried, including after an uncertain network outcome. */
  async send(line: string): Promise<void> {
    const input = line.trim();
    if (!input) return;
    if (!this.connected) throw new Error('Engine disconnected. Reconnect before submitting commands.');
    if (input.length > 4000) throw new Error('Input must be at most 4000 characters');
    const decision = /^\/?(approve|reject)\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(input);
    if (decision) {
      await this.request(`actions/${encodeURIComponent(decision[2])}/${decision[1].toLowerCase()}`, { reason: decision[3] });
      return;
    }
    const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input);
    if (!command) { await this.request('messages', { text: input }); return; }
    const name = command[1].toLowerCase(), args = command[2] ?? '';
    if (name === 'adopt') {
      const [symbol, stopText, targetText, ...extra] = args.trim().split(/\s+/);
      const stop = Number(stopText), target = targetText === undefined ? undefined : Number(targetText);
      if (!symbol || !stopText || extra.length || !Number.isFinite(stop) || stop <= 0 || (target !== undefined && (!Number.isFinite(target) || target <= 0))) throw new Error('Usage: /adopt <symbol> <stop> [target]');
      await this.request(`positions/${encodeURIComponent(symbol)}/adopt`, { stop, target });
      this.view.log('INFO', `${symbol}: adoption request accepted by the engine.`);
    } else if (name === 'rearm') {
      if (!args.trim() || /\s/.test(args.trim())) throw new Error('Usage: /rearm <symbol>');
      await this.request(`positions/${encodeURIComponent(args.trim())}/rearm`, {});
      this.view.log('INFO', `${args.trim()}: protection recovery request accepted by the engine.`);
    } else {
      const result = await this.request<{ ok: boolean; error?: string }>('commands/' + encodeURIComponent(name), { args });
      if (!result.ok) throw new Error(result.error ?? 'Command failed');
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    let delay = 1000;
    try {
      const projection = await this.request<Projection>('terminal' + (this.cursor === undefined ? '' : `?after=${this.cursor}`));
      if (this.stopped) return;
      const restarted = this.instanceId !== undefined && projection.instanceId !== this.instanceId;
      if (!this.connected || restarted) {
        const { commands } = await this.request<{ commands: RemoteCommand[] }>('commands');
        for (const command of commands) {
          // Keep help and display/lifecycle commands local to this terminal.
          if (['help', 'quit', 'clear', 'inbox', 'panel', 'approve', 'reject', 'adopt', 'rearm'].includes(command.name)) continue;
          this.view.registerCommand({ ...command, run: args => this.send(`/${command.name}${args ? ' ' + args : ''}`) });
        }
        this.view.log('INFO', `Connected to engine ${this.engine.origin}. ${process.env.AUTOTRADE_PAIRED === '1' ? '/quit stops this paired session and its engine.' : '/quit disconnects this terminal only.'}`);
      }
      this.connected = true;
      this.instanceId = projection.instanceId;
      const { snapshot: s, health } = projection;
      this.view.setEnvironment(s.env);
      this.view.setVenueOpen(s.venueOpen);
      if (s.tick) this.view.setTick(s.tick);
      this.view.setEvents(s.events, s.activity);
      this.view.setActions(s.actions);
      this.view.setCycle(s.cycle);
      this.view.setTraderActivity(health.paused
        ? { state: 'awaiting', detail: 'Trading paused. ' + (s.traderLane.detail ?? '') }
        : s.traderLane);
      this.view.setConciergeActivity(s.conciergeLane);
      const summary = health.issues.join('; ');
      if (summary !== this.healthSummary) {
        this.view.log(summary ? 'WARN' : 'INFO', summary ? 'Engine health: ' + summary : 'Engine health recovered.');
        this.healthSummary = summary;
      }
      if (restarted) { this.cursor = undefined; delay = 0; }
      else {
        for (const entry of projection.entries) {
          if (this.cursor !== undefined && entry.seq <= this.cursor) continue;
          if (entry.kind === 'operator') this.view.echoOperator(entry.text);
          else if (entry.kind === 'reply') this.view.reply(entry.text);
          else if (entry.kind === 'chart') {
            if (entry.chart) this.view.showChart(entry.chart);
            else this.view.replyChart(entry.text.split('\n'));
          }
          else if (entry.kind === 'alert') this.view.alert(entry.text);
          else this.view.log(entry.level ?? 'INFO', entry.text);
          this.cursor = entry.seq;
        }
        this.cursor ??= 0;
        if (projection.entries.length === 200) delay = 0;
      }
    } catch (error: any) {
      if (this.stopped) return;
      if (this.connected || this.instanceId === undefined) this.view.log('WARN', `Engine unavailable: ${error.message}. Reconnecting; no commands will be replayed.`);
      this.connected = false;
      this.instanceId ??= '';
      this.view.setTraderActivity({ state: 'error', detail: 'Engine disconnected — displayed account data may be stale' });
      this.view.setConciergeActivity({ state: 'error', detail: 'Engine disconnected' });
      this.view.setVenueOpen(null);
      delay = 2000;
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), delay);
  }
}
