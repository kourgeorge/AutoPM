/**
 * L1.5 — the system prompt and forced tool-call schema for the AI decision-maker.
 *
 * One tool, `record_daily_decisions`, and the caller forces it via `toolChoice` so a day's
 * decisions arrive in one parseable shape instead of free-form text. Sparse by construction:
 * a symbol absent from `decisions` is implicitly held unchanged.
 */

import type { ChatMessage, ToolDefinition } from '../core/types';
import type { Policy } from '../policy/types';
import type { DailyDossier } from './aiDossier';
import type { SignalScore } from '../strategy/signals';

export const AI_DECISION_TOOL: ToolDefinition = {
  name: 'record_daily_decisions',
  description:
    "Record today's trading decisions. List only the symbols you want to act on — anything " +
    'not listed is held unchanged (open positions stay open, candidates stay unentered).',
  input_schema: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        description: 'One entry per symbol you want to act on today.',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Ticker symbol.' },
            action: {
              type: 'string',
              enum: ['enter', 'exit', 'hold'],
              description:
                '"enter" opens a new position (must be a listed candidate), "exit" closes an ' +
                'open position, "hold" explicitly keeps a position open (only useful if you ' +
                "want to change its stop/take-profit without exiting).",
            },
            stopLoss: {
              type: 'number',
              description: 'Required for "enter"; optional for "hold" to tighten the stop.',
            },
            takeProfit: {
              type: 'number',
              description: 'Optional target price, for "enter" or "hold".',
            },
            reason: { type: 'string', description: 'One or two sentences: why this decision.' },
          },
          required: ['symbol', 'action', 'reason'],
        },
      },
    },
    required: ['decisions'],
  },
};

export function buildSystemPrompt(policy: Policy): string {
  return [
    'You are the decision-maker in a historical backtest of a trading strategy.',
    '',
    'Every day you are shown the account\'s open positions and a list of candidate symbols ' +
      'that already clear the mechanical entry filters. You decide:',
    '  - which candidates to enter, and at what stop-loss / take-profit levels;',
    '  - which open positions to exit early, on your own judgement;',
    '  - everything else is implicitly held.',
    '',
    'Rules that are enforced mechanically, outside your control, so do not try to work around them:',
    '  - Position size is computed for you — you never choose share quantity.',
    `  - At most ${policy.risk.maxPositions} positions and ${(policy.risk.positionSizePct * 100).toFixed(0)}% ` +
      'of equity per position, plus exposure and daily-loss limits, are all applied after your decision.',
    '  - A safety-net stop under your own stop can only tighten, never loosen.',
    "  - If a position's price falls through its stop on the same day you also flag it to exit, " +
      'the stop fires first — your exit reason is moot for that trade.',
    '',
    'You only see the signals in each dossier: no news, no fundamentals, no macro regime. Decide ' +
      'purely on the price/volume/indicator evidence shown to you, exactly like a systematic ' +
      'trader with no outside information would.',
    '',
    'For "enter": set stopLoss below the current price and, if used, takeProfit above it — both ' +
      'are sanity-checked, and a decision that fails the check is dropped for the day.',
    '',
    'Call record_daily_decisions exactly once, with only the symbols you want to act on.',
  ].join('\n');
}

function fmtNum(n: number | null): string {
  return n == null ? 'n/a' : n.toFixed(2);
}

function signalLines(signals: SignalScore[]): string[] {
  return signals.map(
    s => `      ${s.name.padEnd(20)} ${s.score >= 0 ? '+' : ''}${s.score.toFixed(2)}  ${s.detail}`,
  );
}

export function buildDossierMessage(dossier: DailyDossier): ChatMessage {
  const lines: string[] = [`=== ${dossier.date} ===`];
  lines.push(
    `Equity $${dossier.equity.toFixed(2)}, cash $${dossier.cash.toFixed(2)}, ${dossier.openSlotsRemaining} open slot(s) remaining.`,
  );
  if (dossier.dayLossState !== 'ok') {
    lines.push(`Daily loss state: ${dossier.dayLossState} — new entries will be blocked mechanically regardless of your decision.`);
  }

  lines.push('');
  lines.push('OPEN POSITIONS:');
  if (dossier.positions.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of dossier.positions) {
      lines.push(
        `  ${p.symbol.padEnd(8)} entry $${p.entryPrice.toFixed(2)} now $${p.currentPrice.toFixed(2)} ` +
        `(${p.unrealizedPnLPct >= 0 ? '+' : ''}${p.unrealizedPnLPct.toFixed(1)}%), held ${p.holdingDays}d, ` +
        `stop $${p.currentStop.toFixed(2)}${p.currentTakeProfit != null ? ` TP $${p.currentTakeProfit.toFixed(2)}` : ''} ` +
        `— ${p.signalSummary}`,
      );
      lines.push(...signalLines(p.signals));
    }
  }

  lines.push('');
  lines.push('CANDIDATES (already clear the mechanical entry filter):');
  if (dossier.candidates.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of dossier.candidates) {
      lines.push(`  ${c.symbol.padEnd(8)} $${c.price.toFixed(2)} ATR ${fmtNum(c.atr)} — ${c.signalSummary}`);
      lines.push(...signalLines(c.signals));
    }
  }

  return { role: 'user', content: [{ type: 'text', text: lines.join('\n') }] };
}
