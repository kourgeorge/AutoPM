import { readAccount, readPositions } from '../core/accountRead';
import { collectPrices } from '../collect/priceSource';
import { isPresent } from '../collect/types';
import { getPolicy, getPolicyHash } from '../policy/load';
import { hasRiskProfile, riskProfileName } from '../policy/riskProfiles';
import { getLastTick } from '../features/lastTick';
import { watchlistScan } from '../features/watchlistScan';
import { collectRiskInputs } from './riskData';
import { assessEntryRisk, entryLimitPrice } from './riskBudget';
import { canonicalSymbol } from '../core/symbols';
import { getCachedRegime } from '../macro/regime';

export async function entryPlan(input: { symbol: string; price: number; stopLoss: number; takeProfit: number }) {
  const policy = getPolicy(), policyHash = getPolicyHash();
  const symbol = canonicalSymbol(input.symbol);
  const [account, positions, quotes] = await Promise.all([
    readAccount(), readPositions(), collectPrices([symbol], policy.triggers.maxQuoteAgeMs),
  ]);
  const quote = quotes.get(symbol);
  if (!quote || !isPresent(quote) || quote.stale) return { allowed: false, maxQty: 0, error: 'A fresh quote is required' };
  if (!(input.price > 0) || Math.abs(quote.value / input.price - 1) > 0.01) return { allowed: false, maxQty: 0, error: 'Price moved more than 1%; refresh the setup' };
  const inputs = await collectRiskInputs([...positions.map(p => p.symbol), symbol], policy);
  if (getPolicyHash() !== policyHash) return { allowed: false, maxQty: 0, error: 'Strategy changed; request a fresh plan' };
  return { symbol, policyHash, profile: riskProfileName(policy.risk),
    ...assessEntryRisk({ ...input, symbol, price: entryLimitPrice(input.price, quote.value), equity: account.equity,
      buyingPower: account.buyingPower, positions, policy, inputs }),
    scope: 'Risk budget only. Request no more than maxQty. Execution rechecks all entry rules and may reduce size for the market regime.',
  };
}

/** Keep signal observations intact, then rank feasible candidates by signal per volatility budget used. */
export async function riskAwareWatchlistScan() {
  const policy = getPolicy(), policyHash = getPolicyHash();
  const regime = getCachedRegime(), effectiveCompositeMin = regime ? policy.regime[regime.regime].compositeMin : policy.strategy.compositeMin;
  const scan = watchlistScan(getLastTick(), policy.triggers.tickIntervalMs);
  if (!scan.rows.length || !hasRiskProfile(policy.risk)) return scan;
  try {
    const [account, positions] = await Promise.all([readAccount(), readPositions()]);
    const inputs = await collectRiskInputs([...positions.map(p => p.symbol), ...scan.rows.map(r => r.symbol)], policy);
    if (getPolicyHash() !== policyHash) throw new Error('Strategy changed during scan; refresh');
    const rows = scan.rows.map(row => {
      const riskFit = row.price != null && row.atr != null && row.atr > 0 && !row.notScored
        ? assessEntryRisk({ symbol: row.symbol, price: entryLimitPrice(row.price, row.price),
          stopLoss: Math.round((row.price - row.atr * policy.risk.stopLossAtrMult) * 100) / 100,
          takeProfit: null, equity: account.equity, buyingPower: account.buyingPower, positions, policy, inputs })
        : null;
      const usedVolatility = riskFit?.volatilityAfterPct != null && riskFit.volatilityBeforePct != null
        ? Math.max(0, riskFit.volatilityAfterPct - riskFit.volatilityBeforePct) : 0;
      const riskAdjustedScore = riskFit?.allowed && row.tally.composite != null && row.tally.composite >= effectiveCompositeMin
        ? row.tally.composite / (1 + usedVolatility / (policy.risk.targetVolatilityPct ?? 1)) : null;
      return { ...row, riskFit, riskAdjustedScore };
    });
    rows.sort((a, b) => (b.riskAdjustedScore ?? -Infinity) - (a.riskAdjustedScore ?? -Infinity) || a.symbol.localeCompare(b.symbol));
    return { ...scan, rows, policyHash, effectiveCompositeMin, profile: riskProfileName(policy.risk), caveats: [...scan.caveats,
      'Risk ranking is a shortlist heuristic: composite divided by 1 + incremental volatility / target. It is not expected return.',
      'Each candidate is measured separately against current holdings using an ATR stop. Get an entry plan with the actual supported stop and target before placing an order. Candidates cannot all use the same remaining budget.',
    ] };
  } catch (err) {
    return { ...scan, rows: scan.rows.map(row => ({ ...row, riskFit: null, riskAdjustedScore: null })),
      riskError: err instanceof Error ? err.message : String(err),
      caveats: [...scan.caveats, 'Portfolio risk could not be measured. No candidate has a confirmed risk fit.'] };
  }
}
