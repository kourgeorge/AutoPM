import type { Bar } from '../core/types';

/** Match return INTERVALS, not array tails: missing sessions cannot masquerade as correlation. */
export function datedReturns(bars: Bar[], asOf: string, lookback = 60): Map<string, number> {
  const closes = new Map<string, number>();
  for (const bar of bars) {
    // Both equity feeds stamp daily bars on their session's UTC date.
    const day = bar.t.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(bar.t))) throw new Error('Invalid daily bar date');
    if (day > asOf) continue; // Never include a partially completed session.
    if (!Number.isFinite(bar.c) || bar.c <= 0 || closes.has(day)) throw new Error('Invalid or duplicate daily close');
    closes.set(day, bar.c);
  }
  const days = [...closes.keys()].sort().slice(-(lookback + 1));
  if (days.at(-1) !== asOf) throw new Error(`Daily history does not reach ${asOf}`);
  const returns = new Map<string, number>();
  for (let i = 1; i < days.length; i++) {
    const value = closes.get(days[i])! / closes.get(days[i - 1])! - 1;
    if (!Number.isFinite(value)) throw new Error('Daily return is not finite');
    returns.set(`${days[i - 1]}/${days[i]}`, value);
  }
  return returns;
}
