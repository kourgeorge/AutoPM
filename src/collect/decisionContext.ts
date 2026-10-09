import { readPositions, readOrders } from '../core/accountRead';
import { collectPrices } from './priceSource';
import { isUsable } from './types';
import { dailyHistory, relativeContext } from './marketContext';
import { getFundamentals } from './fundamentals';
import { getPositionSnapshot } from '../state/state';
import { getPolicy, getPolicyHash } from '../policy/load';
import { sameSymbol } from '../core/symbols';
import { atr, ema, rsi } from '../strategy/indicators';
import { computeSignals, signalTally } from '../strategy/signals';
import { thesisForPosition, evaluatePremises, latestPositionReview, type Facts } from '../journal/thesis';
import { readEvidence } from '../journal/evidence';
import { alpacaData, alpacaTimeToMs } from '../core/alpacaHttp';

const message = (r: PromiseSettledResult<unknown>) => r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : null;

export async function executionLiquidity(symbol: string) {
  const res = await alpacaData.get('/v2/stocks/quotes/latest', { params: { symbols: symbol } });
  const q = res.data?.quotes?.[symbol], time = q ? alpacaTimeToMs(String(q.t)) : NaN;
  const age = Date.now() - time;
  if (!q || !Number.isFinite(time) || age < -30000 || age > getPolicy().triggers.maxQuoteAgeMs || !Number.isFinite(q.bp) || !Number.isFinite(q.ap) || !(q.bp > 0) || !(q.ap >= q.bp)) {
    return { source: 'alpaca', asOf: Number.isFinite(time) ? new Date(time).toISOString() : null, bid: null, ask: null, spreadBps: null, error: 'Fresh valid bid/ask unavailable' };
  }
  return { source: 'alpaca', feed: 'subscription default', asOf: new Date(time).toISOString(), bid: q.bp, ask: q.ap,
    bidSize: q.bs ?? null, askSize: q.as ?? null, spreadBps: (q.ap - q.bp) / ((q.ap + q.bp) / 2) * 10000,
    caveats: ['Top-of-book size is not guaranteed executable depth. Spread estimates exclude fees, slippage and impact.'] };
}

export function forwardGeometry(price: number | null, stop: number | null, target: number | null, atrValue: number | null) {
  const downside = price != null && stop != null ? price - stop : null;
  const upside = price != null && target != null ? target - price : null;
  return { price, stop, target, downsidePerShare: downside, upsidePerShare: upside,
    downsidePct: price && downside != null ? downside / price * 100 : null,
    upsidePct: price && upside != null ? upside / price * 100 : null,
    stopDistanceAtr: atrValue && downside != null ? downside / atrValue : null,
    targetDistanceAtr: atrValue && upside != null ? upside / atrValue : null,
    remainingRewardRisk: downside != null && downside > 0 && upside != null ? upside / downside : null };
}

/** One dossier serves entry research, thesis checks, and forward-looking holding review. */
export async function positionReviewContext(symbol: string) {
  const policy = getPolicy(), policyHash = getPolicyHash(), snapshot = getPositionSnapshot(symbol), recorded = thesisForPosition(symbol), previous = latestPositionReview(symbol);
  const jobs = await Promise.allSettled([readPositions(), readOrders(), collectPrices([symbol], policy.triggers.maxQuoteAgeMs),
    dailyHistory(symbol), getFundamentals(symbol), relativeContext(symbol, snapshot?.openedAt), executionLiquidity(symbol)]);
  if (getPolicyHash() !== policyHash) throw new Error('Strategy changed during review; request a fresh dossier');
  const positions = jobs[0].status === 'fulfilled' ? jobs[0].value : null;
  const orders = jobs[1].status === 'fulfilled' ? jobs[1].value : null;
  const prices = jobs[2].status === 'fulfilled' ? jobs[2].value : null;
  const bars = jobs[3].status === 'fulfilled' ? jobs[3].value : null;
  const fundamentals = jobs[4].status === 'fulfilled' ? jobs[4].value : null;
  const relative = jobs[5].status === 'fulfilled' ? jobs[5].value : null;
  const liquidity = jobs[6].status === 'fulfilled' ? jobs[6].value : null;
  const holding = positions?.find(p => sameSymbol(p.symbol, symbol)) ?? null;
  const isCandidate = positions !== null && !holding;
  const quote = prices?.get(symbol), price = quote && isUsable(quote) ? quote.value : null;
  const ownStop = orders?.find(o => o.id === snapshot?.stopOrderId && sameSymbol(o.symbol, symbol) && o.side === 'sell' && o.type === 'stop');
  const ownTarget = orders?.find(o => o.id === snapshot?.takeProfitOrderId && sameSymbol(o.symbol, symbol) && o.side === 'sell' && o.type === 'limit');
  const closes = bars?.value.map(b => b.c) ?? [];
  const fast = ema(closes, policy.strategy.emaFast).at(-1), slow = ema(closes, policy.strategy.emaSlow).at(-1);
  const sufficient = closes.length >= policy.strategy.minBars;
  const fact = (value: number | null | undefined, source: string, asOf: string | null) => ({ value: value ?? null, source, asOf });
  const facts: Facts = {
    lastClose: fact(sufficient ? closes.at(-1) : null, bars?.source ?? 'unavailable', bars?.asOf ?? null),
    rsi: fact(sufficient ? rsi(closes, policy.strategy.rsiPeriod).at(-1) : null, bars?.source ?? 'unavailable', bars?.asOf ?? null),
    emaSpreadPct: fact(sufficient && fast != null && slow ? (fast / slow - 1) * 100 : null, bars?.source ?? 'unavailable', bars?.asOf ?? null),
    trendComposite: fact(sufficient && bars ? signalTally(computeSignals(bars.value, policy)).composite : null, bars?.source ?? 'unavailable', bars?.asOf ?? null),
    relativeMarket20dPct: fact(relative?.market20d?.excessPct, 'derived', relative?.asOf ?? null),
    relativeSector20dPct: fact(relative?.sector20d?.excessPct, 'derived', relative?.asOf ?? null),
    earningsDaysUntil: fact(fundamentals?.calendar.daysUntil, 'yahoo', fundamentals?.fetchedAt ?? null),
    epsRevisionsUp30d: fact(fundamentals?.revisions.currentQuarter?.upLast30days, 'yahoo', fundamentals?.fetchedAt ?? null),
    epsRevisionsDown30d: fact(fundamentals?.revisions.currentQuarter?.downLast30days, 'yahoo', fundamentals?.fetchedAt ?? null),
    freeCashflow: fact(fundamentals?.balanceSheet.freeCashflow, 'yahoo', fundamentals?.fetchedAt ?? null),
    revenueGrowthPct: fact(fundamentals?.balanceSheet.revenueGrowthPct, 'yahoo', fundamentals?.fetchedAt ?? null),
  };
  const atrValue = sufficient && bars ? atr(bars.value, policy.strategy.atrPeriod).at(-1) ?? null : null;
  const baselineId = isCandidate ? undefined : previous?.snapshotId ?? recorded.thesis?.premises.flatMap(p => p.evidenceIds).find(id => readEvidence(id)?.data.fundamentals);
  const baseline = baselineId ? readEvidence(baselineId)?.data : null;
  const fieldPaths = ['calendar.nextEarningsAt', 'revisions.currentQuarter.upLast30days', 'revisions.currentQuarter.downLast30days', 'balanceSheet.freeCashflow', 'balanceSheet.revenueGrowthPct'];
  const atPath = (obj: any, path: string) => path.split('.').reduce((v, k) => v?.[k], obj) ?? null;
  const fundamentalChanges = fieldPaths.map(field => ({ field, previous: atPath(baseline?.fundamentals, field), current: atPath(fundamentals, field) }))
    .filter(r => r.previous != null && r.previous !== r.current);
  const heldDays = snapshot?.openedAt && Number.isFinite(Date.parse(snapshot.openedAt)) ? (Date.now() - Date.parse(snapshot.openedAt)) / 86400000 : null;
  return { symbol, policyHash, asOf: quote && isUsable(quote) ? quote.asOf : null, source: quote?.source ?? 'unavailable', holding,
    reviewPurpose: positions === null ? 'unknown' : holding ? 'holding' : 'new_entry',
    positionKnown: positions !== null, managed: !isCandidate && snapshot != null, entryDecisionId: isCandidate ? null : recorded.entryDecisionId,
    originalThesis: isCandidate ? null : recorded.thesis, originalRationale: isCandidate ? null : recorded.rationale, previousReview: isCandidate ? null : previous,
    heldDays: isCandidate ? null : heldDays, intendedHorizonDays: isCandidate ? null : recorded.thesis?.horizonDays ?? null,
    horizonExceeded: !isCandidate && heldDays != null && recorded.thesis ? heldDays > recorded.thesis.horizonDays : null,
    brokerProtection: { known: orders !== null, stopLevel: ownStop?.stopPrice ?? null, stopCoveredQty: ownStop ? Math.max(0, ownStop.qty - ownStop.filled) : null,
      fullyCovered: orders && holding ? !!ownStop && ownStop.qty - ownStop.filled >= holding.qty : null,
      targetLevel: ownTarget?.limitPrice ?? null, recordedStop: snapshot?.stopLevel ?? null, recordedTarget: snapshot?.takeProfitLevel ?? null },
    forward: forwardGeometry(price, ownStop?.stopPrice ?? null, ownTarget?.limitPrice ?? null, atrValue),
    intendedForward: forwardGeometry(price, snapshot?.stopLevel ?? null, snapshot?.takeProfitLevel ?? null, atrValue),
    atr: atrValue, metrics: facts, thesisStatus: isCandidate
      ? { status: 'not_applicable', premises: [], caveats: ['No position is held. Research and assess a proposed entry thesis rather than checking an original holding thesis.'] }
      : evaluatePremises(recorded.thesis, facts), relative, liquidity, fundamentals, fundamentalChanges,
    caveats: ['Actual broker protection and intended levels are separate measurements.', 'Fundamental asOf values identify fetch times; reporting periods may be older.',
      ...(!holding && positions !== null ? ['This is a new-entry candidate. An original position thesis and resting broker protection are not applicable. Research a proposed buy case and derive supported levels; null historical thesis/geometry is not a reason to reject the opportunity.'] : []),
      'Remaining reward:risk is price geometry and contains no forecast probability.', ...jobs.map(message).filter((s): s is string => s !== null),
      ...(!fundamentals ? ['Calendar and fundamentals unavailable; upcoming catalysts are unknown.'] : [])] };
}
