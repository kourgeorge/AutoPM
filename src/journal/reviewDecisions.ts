import { listRecords } from '../core/storage';
import { agentContext } from '../core/agentContext';
import { sameSymbol } from '../core/symbols';
import { decision, readDecisions, recordDecision } from './journal';
import { getLastTick } from '../features/lastTick';
import { getPolicy } from '../policy/load';
import { describeGap, investmentGap } from '../strategy/investment';
import type { DecisionInput, DecisionRecord, EntryPlanSummary } from './types';

/**
 * Every decision the trader saves reaches the journal, on both sides of the book: a candidate
 * it passed on is a `skip`, a holding it kept is a `hold`, and an entry or exit records itself.
 * Before 2026-10-16 only alert answers wrote skips, so a name found in the watchlist scan left
 * no trace however close it came to a buy, and "keep" reviews were in the tool-call log only.
 *
 * A row is written when the decision CHANGES, not every time it is restated: 194 "keep" reviews
 * in a week, one per row, is what got hold rows removed on 2026-10-12.
 */

interface ToolCallRow { name: string; role?: string; requestId?: string; input?: { symbol?: string }; result?: string; startedAt?: string }
interface PlanResult {
  symbol?: string; allowed?: boolean; maxQty?: number; rewardRisk?: number | null; evidenceId?: string;
  proposedLevels?: { referencePrice?: number; stopLoss?: number; takeProfit?: number };
  violations?: Array<{ rule: string }>;
}
type ReviewLabel = 'buy' | 'wait' | 'skip' | 'keep' | 'reduce' | 'exit';
const PREVIEWS = ['get_entry_plan', 'compare_position_actions'];
/**
 * Below the investment target, this many of the best-ranked scan rows that already fit the risk
 * budget need a decision. A scan the trader read and walked away from was the one way left to
 * pass on a buy without a trace: on 2026-10-16 MA, LLY and V all fit, nothing was entered, and
 * the journal stayed empty because no entry plan had been run.
 */
const SCAN_CANDIDATES_TO_DECIDE = 3;
interface ScanRow { symbol?: string; price?: number | null; priceStale?: boolean; composite?: number | null; riskAdjustedScore?: number | null; riskFit?: { maxQty?: number } | null }
const REVIEWS = ['record_candidate_review', 'record_position_review'];
const ACTED = ['entry', 'exit', 'veto', 'rejected'];

function parse<T>(json: string | undefined): T | null { try { return JSON.parse(json ?? '') as T; } catch { return null; } }

/** The trader's tool calls in one request, oldest first. */
function tradersCalls(requestId: string, names: string[]) {
  return listRecords<ToolCallRow>('tool-calls', { where: r => r.role === 'trader' && r.requestId === requestId && names.includes(r.name) });
}

function planSummary(id: string, plan: PlanResult): Pick<DecisionInput, 'intendedPrice' | 'intendedStop' | 'intendedTarget' | 'entryPlan'> {
  const summary: EntryPlanSummary = { evidenceId: plan.evidenceId ?? id, allowed: plan.allowed === true, maxQty: plan.maxQty ?? 0,
    rewardRisk: plan.rewardRisk ?? null, refusals: (plan.violations ?? []).map(v => v.rule) };
  return { intendedPrice: plan.proposedLevels?.referencePrice ?? null, intendedStop: plan.proposedLevels?.stopLoss ?? null,
    intendedTarget: plan.proposedLevels?.takeProfit ?? null, entryPlan: summary };
}

/** The plan the trader ran for `symbol` in this request (`planId` if given, else the latest), as journal fields. */
export function planFields(requestId: string | undefined, symbol: string, planId?: string) {
  if (!requestId) return {};
  const plans = tradersCalls(requestId, ['get_entry_plan']).flatMap(r => {
    const plan = parse<PlanResult>(r.value.result);
    return plan?.symbol && typeof plan.allowed === 'boolean' && sameSymbol(plan.symbol, symbol) ? [{ id: r.id, plan }] : [];
  });
  const chosen = (planId && plans.find(p => p.id === planId || p.plan.evidenceId === planId)) || plans.at(-1);
  return chosen ? planSummary(chosen.id, chosen.plan) : {};
}

const sameNumbers = (a: DecisionRecord, b: Partial<DecisionInput>) =>
  (a.intendedStop ?? null) === (b.intendedStop ?? null) && (a.intendedTarget ?? null) === (b.intendedTarget ?? null)
  && (a.entryPlan?.allowed ?? null) === (b.entryPlan?.allowed ?? null) && (a.entryPlan?.rewardRisk ?? null) === (b.entryPlan?.rewardRisk ?? null);

/**
 * Journal a trader's saved review. buy/reduce/exit write nothing here: the order they lead to
 * records itself, and `unresolvedDecisions` holds the cycle open until it is sent. A researcher's
 * review is advice to the trader, not a decision.
 */
export function journalReview(review: { symbol: string; held: boolean; decision: ReviewLabel; reason: string; reviewId: string; evidenceIds: string[]; planId?: string }): DecisionRecord | null {
  const context = agentContext.getStore();
  if (context?.role !== 'trader') return null;
  // A holding the trader kept (keep, or wait on a position) is a hold; a candidate it passed on is a skip.
  const finalKind = review.held ? (['keep', 'wait'].includes(review.decision) ? 'hold' : null)
    : (['wait', 'skip'].includes(review.decision) ? 'skip' : null);
  if (!finalKind) return null;
  const numbers = finalKind === 'skip' ? planFields(context.requestId, review.symbol, review.planId) : {};
  const last = readDecisions({ symbol: review.symbol, limit: 1 })[0];
  if (last && last.kind === finalKind && last.reviewDecision === review.decision && sameNumbers(last, numbers)) return null;
  return recordDecision(decision(finalKind, 'trader', { symbol: review.symbol, rationale: `${review.decision}: ${review.reason}`,
    reviewDecision: review.decision, reviewId: review.reviewId, observationIds: review.evidenceIds, ...numbers }));
}

export interface Unresolved { symbol: string | null; problem: string; kind: 'hold' | 'skip'; fields: Partial<DecisionInput> }

/** The strongest fitting candidates the trader's scans showed in this request, best first. */
function scanCandidates(requestId: string): ScanRow[] {
  const rows = new Map<string, ScanRow>();
  for (const c of tradersCalls(requestId, ['get_watchlist_scan']))
    for (const row of parse<{ rows?: ScanRow[] }>(c.value.result)?.rows ?? [])
      if (row.symbol && row.riskAdjustedScore != null && !row.priceStale) rows.set(row.symbol.toUpperCase(), row);
  return [...rows.values()].sort((a, b) => b.riskAdjustedScore! - a.riskAdjustedScore!).slice(0, SCAN_CANDIDATES_TO_DECIDE);
}

/**
 * What the trader looked at or decided in this request and has not closed: a plan or exit
 * comparison with no decision recorded, or a buy/reduce/exit review with no order behind it.
 */
export function unresolvedDecisions(requestId: string): Unresolved[] {
  const calls = tradersCalls(requestId, [...PREVIEWS, ...REVIEWS]);
  const journal = readDecisions({ filter: r => r.requestId === requestId && r.symbol != null });
  const symbols = new Map<string, string>();
  for (const c of calls) {
    const symbol = c.value.input?.symbol ?? parse<{ symbol?: string }>(c.value.result)?.symbol;
    if (symbol && ![...symbols.keys()].some(s => sameSymbol(s, symbol))) symbols.set(symbol.toUpperCase(), c.value.name);
  }
  const out: Unresolved[] = [];
  // Only while the market is open and the book is short of its target: then a fitting candidate
  // left undecided is cash the profile asked to put to work.
  const tick = getLastTick(), gap = investmentGap(getPolicy(), tick?.portfolio?.grossDeployedPct);
  const scanned = new Map<string, ScanRow>();
  if (tick?.session === 'open' && gap?.belowTarget) {
    for (const row of scanCandidates(requestId)) {
      scanned.set(row.symbol!.toUpperCase(), row);
      if (![...symbols.keys()].some(s => sameSymbol(s, row.symbol!))) symbols.set(row.symbol!.toUpperCase(), 'get_watchlist_scan');
    }
    if (gap.belowFloor && !tradersCalls(requestId, ['get_watchlist_scan']).length)
      out.push({ symbol: null, kind: 'skip', fields: {},
        problem: `the account is under-invested (${describeGap(gap)}) and you did not scan the watchlist this cycle` });
  }
  for (const symbol of symbols.keys()) {
    const mine = calls.filter(c => sameSymbol(c.value.input?.symbol ?? parse<{ symbol?: string }>(c.value.result)?.symbol ?? '', symbol));
    const rows = journal.filter(r => sameSymbol(r.symbol!, symbol));
    const reviews = mine.filter(c => REVIEWS.includes(c.value.name)).flatMap(c => {
      const r = parse<{ ok?: boolean; review?: { decision: ReviewLabel } }>(c.value.result);
      return r?.ok && r.review ? [{ at: c.value.startedAt ?? c.at, decision: r.review.decision, position: c.value.name === 'record_position_review' }] : [];
    });
    const lastReview = reviews.at(-1);
    const position = lastReview?.position ?? mine.some(c => c.value.name === 'compare_position_actions');
    const kind = position ? 'hold' : 'skip';
    if (lastReview && ['buy', 'reduce', 'exit'].includes(lastReview.decision)) {
      if (!rows.some(r => ACTED.includes(r.kind) && r.at >= lastReview.at))
        out.push({ symbol, kind, problem: `your review says ${lastReview.decision}, but no ${lastReview.decision === 'buy' ? 'entry' : 'exit'} order was sent`,
          fields: { reviewDecision: lastReview.decision, ...(kind === 'skip' ? planFields(requestId, symbol) : {}) } });
    } else if (!lastReview && !rows.length) {
      const scan = scanned.get(symbol), planned = mine.some(c => c.value.name === 'get_entry_plan');
      const problem = position ? 'you compared exit options but recorded no decision'
        : planned ? 'you ran an entry plan but recorded no decision'
        : `the scan shows it fitting the risk budget (composite ${scan?.composite ?? '?'}, up to ${scan?.riskFit?.maxQty ?? '?'} shares) while the account is below its investment target, and you recorded no decision`;
      out.push({ symbol, kind, problem, fields: kind === 'skip' ? { ...(scan?.price != null ? { intendedPrice: scan.price } : {}), ...planFields(requestId, symbol) } : {} });
    }
  }
  return out;
}

/** True when the trader already had one sleep refused in this request. */
export function sleepRefusedBefore(requestId: string): boolean {
  return tradersCalls(requestId, ['sleep']).some(c => parse<{ ok?: boolean }>(c.value.result)?.ok === false);
}

/**
 * The fallback when a cycle ends with decisions still open (a second sleep, a turn limit, an
 * error): the journal says so in the system's words rather than staying silent.
 */
export function journalUnresolved(requestId: string): number {
  const open = unresolvedDecisions(requestId);
  for (const u of open) {
    const plan = u.fields.entryPlan;
    const numbers = plan ? ` Last entry plan: ${plan.allowed ? `allowed, up to ${plan.maxQty} shares` : `refused (${plan.refusals.join(', ') || 'no rule given'})`}${plan.rewardRisk != null ? `, reward:risk ${plan.rewardRisk.toFixed(2)}` : ''}.` : '';
    recordDecision(decision(u.kind, 'trader', { symbol: u.symbol, requestId, rationale: `Cycle ended with no reason recorded: ${u.problem}.${numbers}`, ...u.fields }));
  }
  return open.length;
}
