/**
 * Round trips: the unit a review can actually measure.
 *
 * Neither of this system's two records is a trade. The journal holds decisions — an entry
 * here, an exit there, never joined, with prices that are what the model EXPECTED (entry) or
 * the mark BEFORE the sell (exit). The fills ledger holds executions, one per partial fill,
 * with no notion of which buy a sell closed. Everything a self-improvement loop wants to
 * know — did it make money, how long was it held, what was the rationale, was the stop
 * respected — lives in the join, which is what this file computes.
 *
 * The division of trust is strict and worth stating: FILLS ARE TRUTH FOR NUMBERS, THE
 * JOURNAL IS TRUTH FOR REASONS. Prices, quantities, fees and timestamps come only from the
 * venue; rationale, intended stop, trigger event and policy version come only from the
 * journal. Neither is asked for what it does not know.
 */

import { canonicalSymbol } from '../core/symbols';
import { logger } from '../core/logger';
import { readDecisions } from '../journal/journal';
import type { DecisionRecord } from '../journal/types';
import type { Fill } from '../broker/IBroker';
import { readFills } from './fillsLedger';

export interface TradeOutcome {
  symbol: string;
  /** Shares that went round. Entry and exit quantities are equal by construction. */
  qty: number;

  entryAt: string;
  exitAt: string;
  holdingMs: number;

  /** Quantity-weighted average across the fills consumed, not a decision-time estimate. */
  entryPrice: number;
  exitPrice: number;

  /** Before fees. Always known, because it needs nothing but fills. */
  grossPnL: number;
  returnPct: number;

  /** Sum of the fees that were reported; null when none were. */
  fees: number | null;
  /**
   * Whether every consumed fill stated its fee. False on Alpaca, which bills regulatory
   * fees as separate activities — so `netPnL` is null there and `grossPnL` is the honest
   * number to compare.
   */
  feesComplete: boolean;
  netPnL: number | null;

  /** All orders whose fills made up each leg. More than one only after a partial fill. */
  entryOrderIds: string[];
  exitOrderIds: string[];

  // ── From the journal, null when no decision record matches the orders ──────
  entryDecisionId: string | null;
  exitDecisionId: string | null;
  entryRationale: string | null;
  exitRationale: string | null;
  intendedStop: number | null;
  intendedTarget: number | null;
  atrAtEntry: number | null;
  triggerEventId: string | null;
  policyVersion: number | null;

  /**
   * True when the fills for this round trip do not add up — a sell larger than the position
   * on record, which means a buy is missing from the ledger (see `reconcileOnStartup`'s
   * irreducible hole). The numbers are the best available reading, not a reconciliation, and
   * a review must say so rather than average over it.
   */
  unexplained: boolean;
}

interface Leg {
  qty: number;
  notional: number;
  fees: number;
  feesComplete: boolean;
  /** First fill in the leg. */
  firstAt: string;
  /** Last fill in the leg. */
  lastAt: string;
  orderIds: Set<string>;
}

function emptyLeg(): Leg {
  return {
    qty: 0, notional: 0, fees: 0, feesComplete: true,
    firstAt: '', lastAt: '', orderIds: new Set(),
  };
}

function absorb(leg: Leg, fill: Fill, qty: number): void {
  leg.qty += qty;
  leg.notional += qty * fill.price;
  // Pro-rated, because one fill can be split across two round trips by a scale-out.
  if (fill.fee == null) leg.feesComplete = false;
  else leg.fees += fill.fee * (qty / fill.qty);
  // BOTH ends, because the two legs want opposite ones: a position was entered at its FIRST
  // buy and exited at its LAST sell. A single `at` overwritten per fill gave the entry the
  // timestamp of the last scale-in, which shortened `holdingMs` by the whole accumulation.
  if (leg.firstAt === '') leg.firstAt = fill.at;
  leg.lastAt = fill.at;
  leg.orderIds.add(fill.orderId);
}

/**
 * Every completed round trip, oldest-first.
 *
 * Matched FLAT TO FLAT rather than lot by lot: a round trip opens when the position leaves
 * zero and closes when it returns. With the guard's `already_holding` rule that is exactly
 * one entry and one exit, so it agrees with FIFO lot matching in the case that actually
 * occurs — and where they differ (a scale-out, or an add if that rule is ever relaxed) it
 * gives the one figure the reviewer wants, a weighted average per position held, instead of
 * a fragment per lot that no decision corresponds to.
 *
 * A position still open contributes nothing. Half a trade has no outcome, and imputing one
 * from the current mark is how an unrealised loss gets counted as a strategy that works.
 */
export function computeOutcomes(opts: { symbol?: string; since?: Date } = {}): TradeOutcome[] {
  const fills = readFills({ symbol: opts.symbol });

  // Grouped canonically: a buy recorded as `BTC/USD` and the sell that closed it recorded as
  // `BTCUSD` are one round trip, and grouping on the raw string put them in two buckets where
  // neither ever returned to flat — so the trade simply never appeared in a review. The
  // first spelling seen is kept for display; the canonical form is only ever the key.
  const bySymbol = new Map<string, { display: string; fills: Fill[] }>();
  for (const f of fills) {
    if (!(f.qty > 0) || !Number.isFinite(f.price)) continue;
    const key = canonicalSymbol(f.symbol);
    const bucket = bySymbol.get(key);
    if (bucket) bucket.fills.push(f);
    else bySymbol.set(key, { display: f.symbol, fills: [f] });
  }

  const journal = indexJournal(readDecisions());
  const outcomes: TradeOutcome[] = [];

  for (const [, { display: symbol, fills: symbolFills }] of bySymbol) {
    let position = 0;
    let entry = emptyLeg();
    let exit = emptyLeg();
    let unexplained = false;
    let orphanedQty = 0;

    for (const fill of symbolFills) {
      if (fill.side === 'buy') {
        absorb(entry, fill, fill.qty);
        position += fill.qty;
        continue;
      }

      // A sell bigger than the position on record cannot be matched to a buy that is not
      // there. The excess is dropped rather than carried as a short — the system is
      // long-only, so this is a gap in the ledger, not a position.
      const matched = Math.min(fill.qty, position);

      // A sell against a FLAT position closes nothing, so it belongs to no round trip.
      // `unexplained` used to be set here and then survive into the next trip, which
      // stamped the following clean round trip as unreconciled. Counted per symbol instead,
      // where it is a statement about the ledger rather than about a trade.
      if (matched <= 0) {
        orphanedQty += fill.qty;
        continue;
      }
      // Partially matched: this sell DID close the position, and did so short a buy. That
      // is a fact about this round trip.
      if (matched < fill.qty) unexplained = true;

      absorb(exit, fill, matched);
      position -= matched;

      if (position > 0) continue; // scale-out: the round trip is not over

      outcomes.push(assemble(symbol, entry, exit, unexplained, journal));
      entry = emptyLeg();
      exit = emptyLeg();
      unexplained = false;
    }

    if (orphanedQty > 0) {
      logger.warn(
        `[Ledger] ${symbol}: ${orphanedQty} unit(s) sold with no position on record — a buy is ` +
          `missing from the fills ledger. Those sells are in no round trip.`,
      );
    }
  }

  outcomes.sort((a, b) => a.exitAt.localeCompare(b.exitAt));

  if (opts.since) {
    const cutoff = opts.since.toISOString();
    return outcomes.filter(o => o.exitAt >= cutoff);
  }
  return outcomes;
}

/**
 * `orderId` -> the decision that placed it.
 *
 * Only executed entries and exits are indexed. Vetoes and rejections never reached a venue
 * and so have no fills to join to; they are read straight from the journal, which is the
 * only place they exist at all.
 *
 * IBKR's `orderId` is documented as not unique to an account and is reused across client
 * sessions, so the LAST decision to claim an id wins — the recent session is the one whose
 * fills are being matched.
 */
function indexJournal(records: DecisionRecord[]): Map<string, DecisionRecord> {
  const index = new Map<string, DecisionRecord>();
  for (const r of records) {
    if (r.orderId && r.executed && (r.kind === 'entry' || r.kind === 'exit')) {
      index.set(`${r.kind}:${r.orderId}`, r);
    }
  }
  return index;
}

function assemble(
  symbol: string,
  entry: Leg,
  exit: Leg,
  unexplained: boolean,
  journal: Map<string, DecisionRecord>,
): TradeOutcome {
  const qty = exit.qty;
  // The entry leg may hold more than went out on a scale-out, so the entry price is the
  // average of what was BOUGHT, applied to what was sold.
  const entryPrice = entry.notional / entry.qty;
  const exitPrice = exit.notional / exit.qty;
  const grossPnL = (exitPrice - entryPrice) * qty;

  const entryOrderIds = [...entry.orderIds];
  const exitOrderIds = [...exit.orderIds];
  const entryDecision = firstMatch(journal, 'entry', entryOrderIds);
  const exitDecision = firstMatch(journal, 'exit', exitOrderIds);

  const feesComplete = entry.feesComplete && exit.feesComplete;
  const feesReported = entry.fees + exit.fees;
  const fees = feesComplete || feesReported > 0 ? feesReported : null;

  return {
    symbol,
    qty,
    entryAt: entry.firstAt,
    exitAt: exit.lastAt,
    holdingMs: Date.parse(exit.lastAt) - Date.parse(entry.firstAt),
    entryPrice,
    exitPrice,
    grossPnL,
    returnPct: (grossPnL / (entryPrice * qty)) * 100,
    fees,
    feesComplete,
    netPnL: feesComplete ? grossPnL - feesReported : null,
    entryOrderIds,
    exitOrderIds,
    entryDecisionId:  entryDecision?.id ?? null,
    exitDecisionId:   exitDecision?.id ?? null,
    entryRationale:   entryDecision?.rationale ?? null,
    exitRationale:    exitDecision?.rationale ?? null,
    intendedStop:     entryDecision?.intendedStop ?? null,
    intendedTarget:   entryDecision?.intendedTarget ?? null,
    atrAtEntry:       entryDecision?.atrAtEntry ?? null,
    triggerEventId:   entryDecision?.triggerEventId ?? null,
    policyVersion:    entryDecision?.policyVersion ?? null,
    unexplained,
  };
}

function firstMatch(
  journal: Map<string, DecisionRecord>,
  kind: 'entry' | 'exit',
  orderIds: string[],
): DecisionRecord | undefined {
  for (const id of orderIds) {
    const hit = journal.get(`${kind}:${id}`);
    if (hit) return hit;
  }
  return undefined;
}
