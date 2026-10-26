/**
 * Realized, unrealized and total profit, overall and per stock, in one answer.
 *
 * Realized is matched from the fills ledger on AVERAGE COST, so a partial sell counts the
 * moment it fills — unlike `scorecard()`, which only measures round trips that have returned
 * to flat. Unrealized is the broker's own figure for what is still held. The two are kept
 * apart and added only once, here, so nobody has to sum two tools by hand.
 *
 * A sell larger than the shares the ledger knows about (a holding bought before the ledger
 * began, or adopted from outside) has no known cost. That quantity is counted as `unmatchedQty`
 * and left out of realized rather than guessed at.
 */
import type { Fill, Position } from '../broker/IBroker';
import { canonicalSymbol } from '../core/symbols';

export interface SymbolPnL {
  symbol: string;
  realizedPnL: number;
  /** Null when the stock is not held, or the broker reported no figure. */
  unrealizedPnL: number | null;
  totalPnL: number;
  sharesBought: number;
  sharesSold: number;
  /** Shares the ledger says are still held. Can differ from the broker's count; see caveats. */
  ledgerQty: number;
  heldQty: number | null;
  /**
   * Realized from partial sells since the current position opened (the last time shares on
   * record reached zero). 0 when not held. This is the part get_scorecard cannot see yet.
   */
  realizedThisPosition: number;
  /** Sold shares with no recorded buy behind them. Their profit is unknown and excluded. */
  unmatchedQty: number;
  /** Known fees only. Null when no fill on this stock reported one. */
  fees: number | null;
  firstFillAt: string | null;
  lastFillAt: string | null;
}

export interface PnLReport {
  window: { since: string | null; fills: number };
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  /** Sum of `realizedThisPosition`: partial sells on positions still open. Invisible to get_scorecard. */
  realizedOnOpenPositions: number;
  bySymbol: SymbolPnL[];
  caveats: string[];
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** PURE. `fills` in arrival order; `positions` as the broker reports them now. */
export function pnlReport(fills: Fill[], positions: Position[], opts: { symbol?: string; since?: Date } = {}): PnLReport {
  const want = opts.symbol ? canonicalSymbol(opts.symbol) : null;
  const sinceMs = opts.since?.getTime() ?? null;
  const rows = new Map<string, SymbolPnL & { costQty: number; cost: number; feeSeen: boolean }>();
  const row = (symbol: string) => {
    const key = canonicalSymbol(symbol);
    let r = rows.get(key);
    if (!r) rows.set(key, r = { symbol, realizedPnL: 0, unrealizedPnL: null, totalPnL: 0, sharesBought: 0, sharesSold: 0, ledgerQty: 0,
      heldQty: null, realizedThisPosition: 0, unmatchedQty: 0, fees: null, firstFillAt: null, lastFillAt: null, costQty: 0, cost: 0, feeSeen: false });
    return r;
  };

  let counted = 0;
  const sorted = [...fills].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const f of sorted) {
    if (!(f.qty > 0) || !Number.isFinite(f.price)) continue;
    if (want && canonicalSymbol(f.symbol) !== want) continue;
    const r = row(f.symbol);
    // Cost basis is built from ALL history; only realized amounts are windowed by `since`.
    const inWindow = sinceMs == null || Date.parse(f.at) >= sinceMs;
    if (f.fee != null) { r.feeSeen = true; if (inWindow) r.fees = (r.fees ?? 0) + f.fee; }
    if (f.side === 'buy') {
      r.cost += f.qty * f.price; r.costQty += f.qty;
      if (inWindow) r.sharesBought += f.qty;
    } else {
      const matched = Math.min(f.qty, r.costQty);
      const avg = r.costQty > 0 ? r.cost / r.costQty : 0;
      const gain = matched * (f.price - avg);
      if (inWindow) { r.realizedPnL += gain; r.sharesSold += f.qty; r.unmatchedQty += f.qty - matched; }
      r.cost -= matched * avg; r.costQty -= matched;
      // Back to flat closes this position; whatever comes next is a new one.
      if (r.costQty <= 1e-9) { r.cost = 0; r.costQty = 0; r.realizedThisPosition = 0; } else if (inWindow) r.realizedThisPosition += gain;
    }
    if (inWindow) {
      counted++;
      r.firstFillAt ??= f.at; r.lastFillAt = f.at;
    }
  }

  for (const p of positions) {
    if (!(p.qty > 0) || (want && canonicalSymbol(p.symbol) !== want)) continue;
    const r = row(p.symbol);
    r.heldQty = p.qty;
    r.unrealizedPnL = p.unrealizedPnL ?? null;
  }

  const caveats: string[] = [];
  const bySymbol: SymbolPnL[] = [];
  let realized = 0, unrealized = 0, onOpen = 0, missingUnrealized = 0, mismatched = 0, unmatched = 0;
  for (const r of rows.values()) {
    const ledgerQty = cents(r.costQty);
    const fees = r.fees == null ? null : cents(r.fees);
    const out: SymbolPnL = { symbol: r.symbol, realizedPnL: cents(r.realizedPnL), unrealizedPnL: r.unrealizedPnL == null ? null : cents(r.unrealizedPnL),
      totalPnL: cents(r.realizedPnL + (r.unrealizedPnL ?? 0)), sharesBought: r.sharesBought, sharesSold: r.sharesSold, ledgerQty,
      heldQty: r.heldQty, realizedThisPosition: r.heldQty == null ? 0 : cents(r.realizedThisPosition), unmatchedQty: r.unmatchedQty, fees, firstFillAt: r.firstFillAt, lastFillAt: r.lastFillAt };
    // A stock with no fill in the window and nothing held has nothing to say.
    if (!out.sharesBought && !out.sharesSold && out.heldQty == null) continue;
    realized += r.realizedPnL; unrealized += r.unrealizedPnL ?? 0;
    if (r.heldQty != null) {
      onOpen += r.realizedThisPosition;
      if (r.unrealizedPnL == null) missingUnrealized++;
      if (sinceMs == null && Math.abs(ledgerQty - r.heldQty) > 1e-6) mismatched++;
    }
    if (r.unmatchedQty > 0) unmatched++;
    bySymbol.push(out);
  }
  bySymbol.sort((a, b) => Math.abs(b.totalPnL) - Math.abs(a.totalPnL));

  caveats.push('Realized profit is matched on average cost from broker fills, so a partial sell counts as soon as it fills. get_scorecard counts only round trips that are fully closed, so the two can differ.');
  caveats.push('Fees are left out of every profit figure. Alpaca reports regulatory fees separately, so a fill\'s fee is usually unknown; `fees` sums only the ones reported.');
  if (opts.since) caveats.push(`Realized covers sells from ${opts.since.toISOString().slice(0, 10)} on; their cost basis uses all earlier buys. Unrealized is always as of now.`);
  if (missingUnrealized) caveats.push(`${missingUnrealized} held stock(s) had no unrealized figure from the broker; they count as 0 in the totals.`);
  if (unmatched) caveats.push(`${unmatched} stock(s) had sells with no recorded buy (bought before the ledger began, or outside this app). Those shares are in unmatchedQty and their profit is not counted.`);
  if (mismatched) caveats.push(`${mismatched} held stock(s) have a ledger share count that differs from the broker's (holdings taken over or bought outside this app). Their unrealized figure is the broker's and is still right.`);

  return {
    window: { since: opts.since?.toISOString() ?? null, fills: counted },
    realizedPnL: cents(realized), unrealizedPnL: cents(unrealized), totalPnL: cents(realized + unrealized),
    realizedOnOpenPositions: cents(onOpen), bySymbol, caveats,
  };
}
