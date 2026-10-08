import { readPositions, readOrders } from '../core/accountRead';
import { getLastTick } from '../features/lastTick';
import { getPolicy } from '../policy/load';
import { getPositionSnapshot } from '../state/state';
import { thesisForPosition, latestPositionReview, evaluatePremises, type Facts } from '../journal/thesis';
import { recordEvidence, type Evidence } from '../journal/evidence';
import { listRecords } from '../core/storage';
import { forwardGeometry } from '../collect/decisionContext';
import { getCachedFundamentals } from '../collect/fundamentals';
import { getCachedRegime } from '../macro/regime';
import { cachedEconomicCalendar } from '../collect/economicCalendar';
import { sameSymbol } from '../core/symbols';

/** Reuse the measured tick and broker read scope; no extra network calls in the standing brief. */
export async function buildDecisionBrief(): Promise<string> {
  const [positionsResult, ordersResult] = await Promise.allSettled([readPositions(), readOrders()]);
  const positions = positionsResult.status === 'fulfilled' ? positionsResult.value : null;
  const orders = ordersResult.status === 'fulfilled' ? ordersResult.value : null;
  const tick = getLastTick(), freshTick = tick && Date.now() - Date.parse(tick.tickAt) <= getPolicy().triggers.tickIntervalMs * 3 && tick.policyVersion === getPolicy().version ? tick : null;
  const fundamentals = getCachedFundamentals((positions ?? []).map(p => p.symbol));
  const rows = (positions ?? []).map(p => {
    const f = freshTick?.positions[p.symbol], snap = getPositionSnapshot(p.symbol), entry = thesisForPosition(p.symbol), previous = latestPositionReview(p.symbol);
    const price = f && !f.stale ? f.price : null;
    const stop = orders?.find(o => o.id === snap?.stopOrderId && sameSymbol(o.symbol, p.symbol) && o.side === 'sell' && o.type === 'stop');
    const target = orders?.find(o => o.id === snap?.takeProfitOrderId && sameSymbol(o.symbol, p.symbol) && o.side === 'sell' && o.type === 'limit');
    const cal = fundamentals[p.symbol];
    const facts: Facts = { lastClose: { value: f?.lastClose ?? null, asOf: f?.barsAsOf ?? null, source: f?.barsSource ?? 'unavailable' },
      rsi: { value: f?.rsi ?? null, asOf: f?.barsAsOf ?? null, source: f?.barsSource ?? 'unavailable' },
      emaSpreadPct: { value: f?.emaFast != null && f.emaSlow ? (f.emaFast / f.emaSlow - 1) * 100 : null, asOf: f?.barsAsOf ?? null, source: f?.barsSource ?? 'unavailable' },
      trendComposite: { value: f?.trendComposite ?? null, asOf: f?.barsAsOf ?? null, source: f?.barsSource ?? 'unavailable' },
      earningsDaysUntil: { value: cal?.calendar.daysUntil ?? null, asOf: cal?.fetchedAt ?? null, source: 'yahoo' } };
    return { symbol: p.symbol, qty: p.qty, quoteAsOf: f?.quoteAsOf ?? null,
      forward: forwardGeometry(price, stop?.stopPrice ?? null, target?.limitPrice ?? null, f?.atr ?? null),
      protectionKnown: orders !== null, fullyStopped: orders ? !!stop && stop.qty - stop.filled >= p.qty : null,
      thesis: evaluatePremises(entry.thesis, facts), originalHorizonDays: entry.thesis?.horizonDays ?? null,
      calendarAvailability: cal ? 'available' : 'unknown', earningsDate: cal?.calendar.nextEarningsAt ?? null,
      previousReview: previous ? { id: previous.id, at: previous.at, decision: previous.decision, changedEvidence: previous.changedEvidence, unknowns: previous.unknowns, nextReviewAt: previous.nextReviewAt, due: Date.now() >= Date.parse(previous.nextReviewAt) } : null,
      sharedDrivers: entry.thesis?.sharedDrivers ?? [] };
  });
  const regime = getCachedRegime(), calendar = cachedEconomicCalendar();
  const market = listRecords<Evidence>('evidence', { where: e => e.tool === 'get_market_context', desc: true, limit: 1 })[0]?.value;
  const brief = { source: 'derived', asOf: freshTick?.tickAt ?? null, positionReadAvailable: positions !== null, rows,
    marketContext: market ? { evidenceId: market.id, observedAt: market.recordedAt, lastKnown: Date.now() - Date.parse(market.recordedAt) > 15 * 60000, breadth: market.data.breadth, benchmarks: market.data.benchmarks } : { availability: 'unknown', tool: 'get_market_context' },
    macroBackdrop: regime ? { regime: regime.regime, confidence: regime.confidence, fetchedAt: regime.fetchedAt, observations: regime.observations, caveats: regime.caveats } : { availability: 'unknown', tool: 'get_macro_regime' },
    economicCalendar: calendar ? { fetchedAt: calendar.fetchedAt, events: calendar.events.filter(e => e.date >= new Date().toISOString().slice(0, 10)).slice(0, 10), sources: calendar.sources } : { availability: 'unknown', tool: 'get_economic_calendar' },
    caveats: ['Current-price geometry uses actual owned broker orders and fresh tick quotes. Unknown prices or missing stops remain null.',
      'Qualitative premises and relative/fundamental premises not measured by this tick require get_position_review and source research.',
      'Shared drivers are evidence-linked thesis hypotheses authored at entry, not verified business classifications.'] };
  const evidence = recordEvidence('cycle_decision_brief', brief);
  return ['=== DECISION REVIEW ===', `Observation ${evidence.id}; get_evidence retrieves the full snapshot.`, JSON.stringify(brief),
    'For a material hold/reduce/exit: get_position_review, examine contradictions and current-price alternatives, then record_position_review. Send any selected order separately.',
    'For a candidate: compare relative strength and costs, check calendars across the intended horizon, and preserve material wait/skip decisions. Missing context calls for research.', '=== END DECISION REVIEW ==='].join('\n');
}
