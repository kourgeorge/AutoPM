/**
 * Shared detector arithmetic.
 *
 * Two functions, both here for the same reason: getting either one wrong is how a
 * comparison ends up with one side in the wrong units, and a unit error in a threshold
 * is silent — it produces a plausible number that fires at the wrong price.
 */

import type { Policy } from '../../policy/types';

/**
 * Re-arm distance for a level measured in its OWN units — dollars, RSI points, EMA points.
 *
 * `policy.triggers.hysteresisPct` is a percentage OF A REFERENCE MAGNITUDE, so a $142.50
 * stop with a 0.5% band re-arms at $143.21 — not 0.5 dollars above, and not 0.5 percentage
 * points above. Detectors whose level is ALREADY a percentage point (drawdown, pnl, day
 * P&L) must use `hysteresisPct` directly and must not call this.
 *
 * `reference` is usually the threshold itself, but not always: a threshold of zero (the EMA
 * spread) has no magnitude of its own, so that detector passes the slow EMA instead.
 */
export function bandOf(reference: number, p: Policy): number {
  return Math.abs(reference) * (p.triggers.hysteresisPct / 100);
}

/**
 * Percentage points -> headline text.
 *
 * Null renders as `n/a` rather than `0.00%`: zero is a legitimate P&L and a dead input
 * must never be able to look like a flat one.
 */
export function pctText(v: number | null): string {
  return v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
