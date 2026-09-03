/**
 * Portfolio exposure as measured fact — weights, sectors, concentration, held-vs-held
 * correlation.
 *
 * This exists because PLAYBOOK.md instructed the model to "avoid sector concentration" and
 * no tool in the system returned a sector. Naming a vocabulary the prompt cannot populate
 * is the fabrication vector `get_signals` was added to close; this closes the portfolio one.
 *
 * Two entry points, split on purpose:
 *  - `concentration()` is PURE — no broker, no network, no clock. The 60s tick computes the
 *    same numbers through it from a bundle it has already fetched, which is what keeps
 *    `compute.ts`'s "no new math" invariant intact and keeps Yahoo off the tick path.
 *  - `exposure()` is the on-demand read: it fetches, then delegates the arithmetic.
 *
 * Nothing here is ever estimated. A missing sector is `null` plus a caveat naming the
 * symbol; a missing market value is a caveat, not a reconstruction from entry price.
 */

import { getSectors } from '../collect/sectorCache';
import { broker } from '../broker';
import type { Position } from '../broker/IBroker';
// Bars, window, minimum sample and the pairwise arithmetic all come from the entry gate's
// module, so a pair correlated here and a pair correlated there cannot disagree.
import { correlate, returnsMatrix } from './portfolioRisk';

export interface ExposurePosition {
  symbol: string;
  qty: number;
  avgCost: number;
  marketValue: number;
  /** `undefined` when the broker did not report one. Never derived from marketValue/avgCost. */
  unrealizedPnL?: number;
  /** Percentage points of equity. */
  weightPct: number;
  /** `null` = Yahoo reports none (normal for ETFs). Never guessed from the ticker. */
  sector: string | null;
}

export interface HeldCorrelation {
  a: string;
  b: string;
  corr: number;
}

/** The pure half: everything computable from positions + equity + a sector map. */
export interface Concentration {
  equity: number;
  positions: ExposurePosition[];
  /** Σ marketValue / equity × 100, percentage points. */
  grossDeployedPct: number;
  /** 100 − grossDeployedPct. Negative on margin — that is a real reading, not an error. */
  cashPct: number;
  maxWeightPct: number;
  maxWeightSymbol: string | null;
  /**
   * Herfindahl index on weights OF THE BOOK (not of equity), so idle cash cannot dilute
   * the concentration reading. (0,1] for a non-empty book; 1 = a single position.
   */
  hhi: number;
  /** Keyed by sector name. Positions with an unknown sector are absent, not bucketed. */
  bySector: Record<string, { symbols: string[]; weightPct: number }>;
  maxSectorWeightPct: number;
  maxSectorName: string | null;
  /** Facts about the data, never advice. */
  caveats: string[];
}

export interface Exposure extends Concentration {
  at: string;
  cash: number;
  buyingPower: number;
  /** Upper triangle — each held pair exactly once. */
  correlations: HeldCorrelation[];
  maxHeldCorrelation: number;
  maxHeldPair: [string, string] | null;
}

/**
 * Weight / HHI / sector arithmetic over an already-fetched book.
 *
 * Pure and synchronous by contract: callers on the 60s tick depend on it making no network
 * call and reading no clock. Sectors arrive as a map because resolving them is the caller's
 * problem — `getSectors` on demand, `getCachedSectors` on the tick.
 */
export function concentration(
  positions: Position[],
  equity: number,
  sectors: Record<string, string | null>,
): Concentration {
  const caveats: string[] = [];

  if (positions.length === 0) {
    return {
      equity,
      positions: [],
      grossDeployedPct: 0,
      cashPct: equity > 0 ? 100 : 0,
      maxWeightPct: 0,
      maxWeightSymbol: null,
      hhi: 0,
      bySector: {},
      maxSectorWeightPct: 0,
      maxSectorName: null,
      caveats: ['no open positions'],
    };
  }

  const noValue = positions.filter(p => !Number.isFinite(p.marketValue as number));
  if (noValue.length > 0) {
    caveats.push(
      `market value unavailable for ${noValue.length} position(s) (${noValue.map(p => p.symbol).join(', ')}) — weights understate the book`,
    );
  }

  const withValue = positions.map(p => ({
    position: p,
    marketValue: Number.isFinite(p.marketValue as number) ? (p.marketValue as number) : 0,
  }));

  const gross = withValue.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
  const equityOk = Number.isFinite(equity) && equity > 0;
  if (!equityOk) {
    caveats.push('equity is zero or unavailable — weights cannot be computed');
  }

  const exposures: ExposurePosition[] = withValue.map(({ position, marketValue }) => ({
    symbol: position.symbol,
    qty: position.qty,
    avgCost: position.avgCost,
    marketValue,
    unrealizedPnL: position.unrealizedPnL,
    weightPct: equityOk ? (marketValue / equity) * 100 : 0,
    sector: sectors[position.symbol] ?? null,
  }));

  const unknownSectors = exposures.filter(e => e.sector === null);
  if (unknownSectors.length > 0) {
    caveats.push(
      `sector unknown for ${unknownSectors.length} position(s) (${unknownSectors.map(e => e.symbol).join(', ')}) — excluded from sector weights`,
    );
  }

  // HHI over weights of the book. Guarded: an all-zero book would otherwise divide by zero.
  const hhi = gross > 0
    ? withValue.reduce((sum, p) => sum + Math.pow(Math.abs(p.marketValue) / gross, 2), 0)
    : 0;

  const bySector: Record<string, { symbols: string[]; weightPct: number }> = {};
  for (const e of exposures) {
    if (e.sector === null) continue;
    const bucket = bySector[e.sector] ?? (bySector[e.sector] = { symbols: [], weightPct: 0 });
    bucket.symbols.push(e.symbol);
    bucket.weightPct += e.weightPct;
  }

  let maxWeightPct = 0;
  let maxWeightSymbol: string | null = null;
  for (const e of exposures) {
    if (e.weightPct > maxWeightPct) {
      maxWeightPct = e.weightPct;
      maxWeightSymbol = e.symbol;
    }
  }

  let maxSectorWeightPct = 0;
  let maxSectorName: string | null = null;
  for (const [name, bucket] of Object.entries(bySector)) {
    if (bucket.weightPct > maxSectorWeightPct) {
      maxSectorWeightPct = bucket.weightPct;
      maxSectorName = name;
    }
  }

  const grossDeployedPct = equityOk ? (gross / equity) * 100 : 0;

  return {
    equity,
    positions: exposures,
    grossDeployedPct,
    cashPct: 100 - grossDeployedPct,
    maxWeightPct,
    maxWeightSymbol,
    hhi,
    bySector,
    maxSectorWeightPct,
    maxSectorName,
    caveats,
  };
}

/**
 * Read the live book and measure it.
 *
 * Bars are fetched ONCE PER SYMBOL and correlated in memory. The matrix is O(n²) pairs but
 * must stay O(n) fetches — a pair-driven loop would issue 15 requests for a 6-position book
 * where 6 suffice.
 */
export async function exposure(): Promise<Exposure> {
  const [account, positions] = await Promise.all([
    broker.getAccountInfo(),
    broker.getPositions(),
  ]);

  const symbols = positions.map(p => p.symbol);
  const sectors = await getSectors(symbols);
  const base = concentration(positions, account.equity, sectors);

  const { correlations, maxHeldCorrelation, maxHeldPair, caveats } =
    await heldCorrelations(symbols);

  return {
    at: new Date().toISOString(),
    ...base,
    cash: account.cash,
    buyingPower: account.buyingPower,
    correlations,
    maxHeldCorrelation,
    maxHeldPair,
    caveats: [...base.caveats, ...caveats],
  };
}

async function heldCorrelations(symbols: string[]): Promise<{
  correlations: HeldCorrelation[];
  maxHeldCorrelation: number;
  maxHeldPair: [string, string] | null;
  caveats: string[];
}> {
  const empty = { correlations: [], maxHeldCorrelation: 0, maxHeldPair: null as [string, string] | null, caveats: [] as string[] };
  if (symbols.length < 2) return empty;

  const caveats: string[] = [];
  const returns = await returnsMatrix(symbols);

  const skipped = symbols.filter(s => !returns.has(s));
  if (skipped.length > 0) {
    caveats.push(
      `insufficient return history for ${skipped.join(', ')} \u2014 excluded from correlations`,
    );
  }

  const usable = symbols.filter(s => returns.has(s));
  const correlations: HeldCorrelation[] = [];
  let maxHeldCorrelation = 0;
  let maxHeldPair: [string, string] | null = null;

  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];

      const corr = correlate(returns.get(a)!, returns.get(b)!);
      if (corr === null) continue;
      correlations.push({ a, b, corr });

      if (Math.abs(corr) > Math.abs(maxHeldCorrelation)) {
        maxHeldCorrelation = corr;
        maxHeldPair = [a, b];
      }
    }
  }

  return { correlations, maxHeldCorrelation, maxHeldPair, caveats };
}
