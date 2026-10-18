/**
 * How often the trader may buy: a daily entry cap and a cooldown after a losing trade.
 *
 * Every other entry guard asks whether THIS trade is acceptable. None asks how many trades came
 * before it, and overtrading is the failure the public record keeps finding — Alpha Arena's
 * losers churned and oversized, and Senpi's own 22-agent test had every agent above 400 trades
 * deeply negative and every one below 120 positive. The cooldown targets the worst form of it:
 * buying straight back into a name that just stopped out.
 *
 * Pure, so the guard and its tests share one definition of "an entry today" and "a recent loss".
 */

import type { Order } from '../state/state';
import type { TradeOutcome } from '../review/ledger';
import { etDate } from '../core/time';
import { canonicalSymbol } from '../core/symbols';

/**
 * Statuses that mean the order reached, or may have reached, the broker. `unknown` counts: an
 * entry that might have filled must not free up a slot. A `failed` order counts only if part of
 * it filled — an extended-hours limit cancelled unfilled bought nothing.
 */
const REACHED_BROKER = new Set(['executing', 'submitted', 'partial', 'unknown', 'executed']);

/** Entries sent to the broker on the ET trading day of `now`. */
export function entriesToday(orders: Order[], now: Date = new Date()): number {
  const today = etDate(now);
  return orders.filter(o => o.kind === 'entry'
    && (REACHED_BROKER.has(o.status) || (o.status === 'failed' && (o.result?.filledQty ?? 0) > 0))
    && etDate(new Date(o.createdAt)) === today).length;
}

/** Why the daily cap refuses another entry, or null. A null cap is off. */
export function entryCapVeto(cap: number | null | undefined, orders: Order[], now: Date = new Date()): string | null {
  if (cap == null) return null;
  const count = entriesToday(orders, now);
  if (count < cap) return null;
  return `${count} new ${count === 1 ? 'entry has' : 'entries have'} already been sent today, the limit set by `
    + `risk.maxEntriesPerDay (${cap}). No more entries until the next trading day; exits are unaffected.`;
}

/**
 * Why a recent loss in this symbol refuses buying it again, or null.
 *
 * Read from the fills ledger, so a loss counts once its fills are reconciled — up to five minutes
 * after a stop fills. A loss is a round trip with negative gross P&L; fees are not reported on
 * every venue, and a scratch trade is not what this rule is for.
 */
export function lossCooldownVeto(
  hours: number | null | undefined,
  symbol: string,
  outcomes: TradeOutcome[],
  now: Date = new Date(),
): string | null {
  if (hours == null || hours <= 0) return null;
  const cutoff = now.getTime() - hours * 3_600_000;
  const key = canonicalSymbol(symbol);
  const loss = outcomes
    .filter(o => canonicalSymbol(o.symbol) === key && o.grossPnL < 0 && Date.parse(o.exitAt) > cutoff)
    .sort((a, b) => b.exitAt.localeCompare(a.exitAt))[0];
  if (!loss) return null;
  const until = new Date(Date.parse(loss.exitAt) + hours * 3_600_000);
  return `${symbol} closed at a loss (${loss.returnPct.toFixed(2)}%) at ${loss.exitAt}. risk.lossCooldownHours `
    + `(${hours}) blocks buying it again until ${until.toISOString()}.`;
}
