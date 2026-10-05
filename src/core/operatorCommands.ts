/**
 * The operator's `/` commands that need data the UI may not read itself — the last tick, the
 * journal, the policy, the trader. Registered from `daemon.ts`; the UI-only ones (`/help`,
 * `/quit`, `/clear`, ...) live in `ui/ui.ts`.
 *
 * Every command here only READS, except `/pause`, `/resume` and `/cycle`, which steer the
 * trader loop and never place or cancel an order. Nothing goes through a model.
 */
import { ui } from '../ui/ui';
import type { Trader } from '../agents/trader';
import { getLastTick } from '../features/lastTick';
import { getOpenProposals } from './proposals';
import { automationSummary } from './automation';
import { readLessons } from '../journal/lessons';
import { scorecard } from '../review/metrics';
import { readPolicyText } from '../policy/load';
import { renderPolicy } from '../policy/render';
import { getMarketStatusSnapshot } from '../tools/traderTools';
import { config } from './config';

const DEFAULT_LESSONS = 5;

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(n: number | null | undefined, digits = 2): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function num(n: number | null | undefined, digits = 2): string {
  return n == null ? '—' : n.toFixed(digits);
}

function holdFor(ms: number | null): string {
  if (ms == null) return '?';
  const h = ms / 3_600_000;
  return h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}

/** A positive whole number from the args, `fallback` when empty, `null` when it is junk. */
function parseCount(args: string, fallback: number | undefined): number | undefined | null {
  if (!args) return fallback;
  const n = Number(args);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerOperatorCommands(trader: Trader): void {
  ui.registerCommand({
    name: 'status',
    aliases: ['s'],
    help: 'Account, market hours, trader state and open proposals.',
    run: async () => {
      const tick = getLastTick();
      const t = trader.status;
      const lines = [
        `Venue      ${config.venue} (${config.broker}), model ${config.ai.model}`,
        `Trader     ${t.paused ? 'PAUSED — /resume to continue' : 'running'}, ${t.cycles} cycle${t.cycles === 1 ? '' : 's'} this run`,
        `Automation ${automationSummary()}`,
      ];
      if (tick) {
        const a = tick.account;
        lines.push(
          `Equity     ${money(a.equity)}  (today ${pct(a.dayPnLPct)})`,
          `Cash       ${money(a.cash)}   invested ${money(a.invested)}   buying power ${money(a.buyingPower)}`,
          `Positions  ${Object.keys(tick.positions).length}   session ${tick.session}   policy v${tick.policyVersion}`,
          `Last tick  ${tick.tickAt}`,
        );
      } else {
        lines.push('Account    no tick yet — wait a minute after start-up.');
      }
      try {
        const m = await getMarketStatusSnapshot();
        lines.push(`Market     ${m.isOpen ? 'OPEN' : 'closed'} (per the broker)`);
      } catch (err: any) {
        lines.push(`Market     unknown — broker clock check failed: ${err.message}`);
      }
      const open = getOpenProposals();
      lines.push(`Proposals  ${open.length} waiting${open.length ? ' — /proposals to list them' : ''}`);
      ui.reply(lines.join('\n'));
    },
  });

  ui.registerCommand({
    name: 'positions',
    aliases: ['pos'],
    help: 'Every open position with stop, target and P&L.',
    run: () => {
      const tick = getLastTick();
      if (!tick || tick.positionsStale) return ui.reply('Holdings are unavailable; the account cannot be reported as flat.');
      const rows = Object.values(tick.positions).sort((a, b) => a.symbol.localeCompare(b.symbol));
      if (rows.length === 0) return ui.reply('No open positions.');
      const header = ['SYMBOL', 'QTY', 'ENTRY', 'PRICE', 'P&L', 'STOP', 'TO STOP', 'TARGET', 'HELD'];
      const body = rows.map((p) => [
        p.symbol,
        String(p.qty),
        num(p.entryPrice),
        `${num(p.price)}${p.stale ? '*' : ''}`,
        pct(p.pnlPct),
        num(p.stopLevel),
        pct(p.distanceToStopPct),
        num(p.takeProfitLevel),
        holdFor(p.heldForMs),
      ]);
      const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
      const fmt = (r: string[]): string =>
        r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
      const lines = [fmt(header), ...body.map(fmt)];
      if (rows.some((p) => p.stale)) lines.push('', '* price is stale');
      ui.replyChart(lines);
    },
  });

  ui.registerCommand({
    name: 'pause',
    help: 'Pause queued trading actions and new trader cycles. Existing broker orders stay active.',
    run: () => {
      if (trader.status.paused) return ui.reply('The trader is already paused.');
      trader.pause();
      ui.reply('Trading paused and saved. Queued actions are blocked. Orders already accepted by the broker remain active; protection checks continue. Type /resume to continue.');
    },
  });

  ui.registerCommand({
    name: 'resume',
    help: 'Start trader cycles again after /pause.',
    run: () => {
      if (!trader.status.paused) return ui.reply('The trader is not paused.');
      trader.resume();
      ui.reply('Trader resumed — the next cycle starts now.');
    },
  });

  ui.registerCommand({
    name: 'cycle',
    aliases: ['wake'],
    help: 'Run a trader cycle now instead of waiting for the next one.',
    run: () => {
      if (trader.status.paused) return ui.reply('The trader is paused — /resume first.');
      trader.wake();
    },
  });

  ui.registerCommand({
    name: 'proposals',
    help: 'Trades waiting for your approve/reject.',
    run: () => {
      const open = getOpenProposals();
      if (open.length === 0) return ui.reply('No proposals waiting.');
      const now = Date.now();
      ui.reply(open.map((p) => {
        const mins = Math.max(0, Math.round((p.expiresAt - now) / 60_000));
        return `${p.id}  ${p.kind} ${p.symbol} (${p.venue}) — ${p.reason}  [expires in ${mins} min]`;
      }).join('\n'));
    },
  });

  ui.registerCommand({
    name: 'lessons',
    args: '[n]',
    help: `The last n lessons from LESSONS.md (default ${DEFAULT_LESSONS}).`,
    run: (args) => {
      const n = parseCount(args, DEFAULT_LESSONS);
      if (n == null) return ui.reply('Usage: /lessons [n] — n must be a whole number above 0.');
      const all = readLessons();
      if (all.length === 0) return ui.reply('No lessons recorded yet.');
      const shown = all.slice(-n);
      ui.reply(`Showing ${shown.length} of ${all.length} lessons, newest last:\n\n${shown.join('\n\n')}`);
    },
  });

  ui.registerCommand({
    name: 'scorecard',
    aliases: ['score'],
    args: '[days]',
    help: 'Results of closed trades, all time or over the last N days.',
    run: (args) => {
      const days = parseCount(args, undefined);
      if (days === null) return ui.reply('Usage: /scorecard [days] — days must be a whole number above 0.');
      const s = scorecard(days ? { days } : {});
      const span = days ? `last ${days} days` : 'all time';
      if (s.trades === 0) return ui.reply(`No closed trades (${span}).`);
      const lines = [
        `Scorecard — ${span}, ${s.trades} closed trade${s.trades === 1 ? '' : 's'}`,
        '',
        `Wins / losses / flat  ${s.wins} / ${s.losses} / ${s.scratches}   win rate ${s.winRate == null ? '—' : `${s.winRate.toFixed(0)}%`}`,
        `Gross P&L             ${money(s.grossPnL)}${s.netPnL != null ? `   net ${money(s.netPnL)}` : '   (fees not fully reported)'}`,
        `Avg win / avg loss    ${money(s.avgWin)} / ${money(s.avgLoss)}   profit factor ${num(s.profitFactor)}`,
        `Per trade             ${money(s.expectancy)}  (${pct(s.expectancyPct)}, ${s.expectancyR == null ? '—' : `${s.expectancyR.toFixed(2)}R`})`,
        `Max drawdown          ${money(s.maxDrawdown)}   longest losing streak ${s.maxConsecutiveLosses}`,
        `Hold time             avg ${num(s.avgHoldHours, 1)}h, median ${num(s.medianHoldHours, 1)}h`,
        `Stops                 ${s.stopDiscipline.breached} of ${s.stopDiscipline.measurable} exits went past the stop`,
      ];
      if (s.best) lines.push(`Best                  ${s.best.symbol} ${money(s.best.grossPnL)} (${pct(s.best.returnPct)})`);
      if (s.worst) lines.push(`Worst                 ${s.worst.symbol} ${money(s.worst.grossPnL)} (${pct(s.worst.returnPct)})`);
      if (s.caveats.length) lines.push('', 'Caveats:', ...s.caveats.map((c) => `- ${c}`));
      ui.reply(lines.join('\n'));
    },
  });

  ui.registerCommand({
    name: 'policy',
    help: 'The live policy settings file (policy.yaml).',
    run: () => ui.reply(readPolicyText().trimEnd()),
  });

  ui.registerCommand({
    name: 'playbook',
    help: 'The trading rules (PLAYBOOK.md) with live policy values filled in.',
    run: () => ui.reply(renderPolicy().trimEnd()),
  });
}
