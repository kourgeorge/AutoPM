import { listRecords } from '../core/storage';
import { getRequest, isOperatorRequest } from '../core/requests';
import { agentContext } from '../core/agentContext';
import { sameSymbol } from '../core/symbols';
import { decision, readDecisions, recordDecision } from './journal';
import { getLastTick } from '../features/lastTick';
import { getPolicy } from '../policy/load';
import { describeGap, investmentGap } from '../strategy/investment';
import { etDate, etNow } from '../core/time';
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
interface ScanRow { symbol?: string; price?: number | null; priceStale?: boolean; composite?: number | null; riskAdjustedScore?: number | null; atr?: number | null; tally?: { composite?: number | null }; riskFit?: { maxQty?: number } | null }
const REVIEWS = ['record_candidate_review', 'record_position_review'];
const ACTED = ['entry', 'exit', 'veto', 'rejected'];

function parse<T>(json: string | undefined): T | null { try { return JSON.parse(json ?? '') as T; } catch { return null; } }

/** The trader's tool calls in one request, oldest first. */
function tradersCalls(requestId: string, names: string[]) {
  return listRecords<ToolCallRow>('tool-calls', { requestId, where: r => r.role === 'trader' && names.includes(r.name) });
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

/**
 * A re-run plan moves its levels by cents as the quote ticks: on 2026-10-16 MA's stop went
 * 595.26 → 595.31 and reward:risk 2 → 2.0002 between two identical "wait"s, and each wrote a row.
 * Levels within 0.5% and reward:risk within 0.1 are the same decision.
 */
const near = (a: number | null | undefined, b: number | null | undefined, tol: (x: number) => number) =>
  a == null || b == null ? (a ?? null) === (b ?? null) : Math.abs(a - b) <= tol(Math.abs(a));
const sameNumbers = (a: DecisionRecord, b: Partial<DecisionInput>) =>
  near(a.intendedStop, b.intendedStop, x => x * 0.005) && near(a.intendedTarget, b.intendedTarget, x => x * 0.005)
  && (a.entryPlan?.allowed ?? null) === (b.entryPlan?.allowed ?? null) && near(a.entryPlan?.rewardRisk, b.entryPlan?.rewardRisk, () => 0.1);

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

/** The strongest fitting candidates in these scan calls, best first. */
function topCandidates(calls: Array<{ value: ToolCallRow }>): ScanRow[] {
  const rows = new Map<string, ScanRow>();
  for (const c of calls)
    for (const row of parse<{ rows?: ScanRow[] }>(c.value.result)?.rows ?? [])
      if (row.symbol && row.riskAdjustedScore != null && !row.priceStale) rows.set(row.symbol.toUpperCase(), row);
  return [...rows.values()].sort((a, b) => b.riskAdjustedScore! - a.riskAdjustedScore!).slice(0, SCAN_CANDIDATES_TO_DECIDE);
}
/** The strongest fitting candidates the trader's scans showed in this request, best first. */
function scanCandidates(requestId: string): ScanRow[] { return topCandidates(tradersCalls(requestId, ['get_watchlist_scan'])); }

/*
 * A decision on a scan candidate stands until something changes. Before 2026-11-17 every cycle
 * below the target owed a fresh decision on the same top 3, so MA/LLY/V were re-reviewed every
 * 15 minutes on the same price and the same score. Now an earlier request's skip, wait, veto or
 * research request covers the name while all of these hold:
 */
/** How long a decision stands at most. It never stands into the next ET trading day either. */
export const DECISION_STANDS_MS = 4 * 60 * 60_000;
/** A price move this many daily ATRs from the price at the decision reopens it ... */
export const REDECIDE_ATR_MOVE = 1;
/** ... or this many percent, whichever is smaller (the percent alone when ATR is unknown). */
export const REDECIDE_PRICE_PCT = 2;
/** A change this large in composite or riskAdjustedScore reopens it (both are roughly -1..1). */
export const REDECIDE_SCORE_CHANGE = 0.1;
/** A journal row the cycle end wrote in the system's words is not the trader's decision. */
const PLACEHOLDER = 'Cycle ended with no reason recorded';
const STANDING_KINDS = ['skip', 'veto', 'rejected'];

export interface EarlierDecision { at: string; decision: string; id: string; price: number | null; requestId?: string }
export interface StandingCheck {
  earlier: EarlierDecision;
  /** Empty: the decision still stands. Otherwise what changed, in plain words. */
  changed: string[];
  /** "price +2.4% since your skip at 10:15 ET" — empty when nothing changed. */
  summary: string;
}
interface Basis { symbol: string; price?: number | null; atr?: number | null; composite?: number | null; riskAdjustedScore?: number | null }
interface History {
  now: Date;
  journal: DecisionRecord[];
  calls: Array<{ id: string; at: string; value: ToolCallRow }>;
  requestId: string;
}
const HISTORY_TOOLS = ['get_watchlist_scan', 'request_research', 'record_candidate_review', 'record_position_review', 'get_news', 'get_calendar'];
const callAt = (c: { at: string; value: ToolCallRow }) => c.value.startedAt ?? c.at;
const composite = (r: ScanRow) => r.composite ?? r.tally?.composite ?? null;
const clock = (iso: string, now: Date) => {
  const at = new Date(iso), t = etNow(at).timeStr;
  return etDate(at) === etDate(now) ? `${t} ET` : `${etDate(at)} ${t} ET`;
};

/** Everything the standing-decision check reads, loaded once (today's tool calls, recent journal). */
export function decisionHistory(requestId: string, now: Date = new Date()): History {
  const since = new Date(now.getTime() - 4 * 24 * 60 * 60_000).toISOString();
  return { now, requestId,
    journal: readDecisions({ filter: r => r.symbol != null && r.at >= since && r.requestId !== requestId }),
    calls: listRecords<ToolCallRow>('tool-calls', { days: 1, where: r => HISTORY_TOOLS.includes(r.name) }) };
}

const symbolOf = (c: { value: ToolCallRow }) => c.value.input?.symbol ?? parse<{ symbol?: string; review?: { symbol?: string } }>(c.value.result)?.symbol
  ?? parse<{ review?: { symbol?: string } }>(c.value.result)?.review?.symbol ?? '';

/** The trader's latest decision on `symbol` from an earlier request (newest first), or null. */
function earlierDecision(h: History, symbol: string): EarlierDecision | null {
  const found: EarlierDecision[] = [];
  for (const r of h.journal)
    if (sameSymbol(r.symbol!, symbol) && STANDING_KINDS.includes(r.kind) && !r.rationale.startsWith(PLACEHOLDER))
      found.push({ at: r.at, decision: r.reviewDecision ?? r.kind, id: r.id, price: r.intendedPrice ?? null, requestId: r.requestId });
  for (const c of h.calls) {
    if (c.value.role !== 'trader' || c.value.requestId === h.requestId || !sameSymbol(symbolOf(c), symbol)) continue;
    if (c.value.name === 'request_research' && parse<{ ok?: boolean }>(c.value.result)?.ok)
      found.push({ at: callAt(c), decision: 'research request', id: c.id, price: null, requestId: c.value.requestId });
    if (c.value.name === 'record_candidate_review') {
      const r = parse<{ ok?: boolean; reviewId?: string; review?: { decision?: string } }>(c.value.result);
      if (r?.ok && r.review?.decision && ['wait', 'skip'].includes(r.review.decision))
        found.push({ at: callAt(c), decision: r.review.decision, id: r.reviewId ?? c.id, price: null, requestId: c.value.requestId });
    }
  }
  const nowIso = h.now.toISOString();
  return found.filter(d => d.at <= nowIso).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

/** The scan row the trader saw for `symbol` at or before `at`, outside this request. */
function scanAt(h: History, symbol: string, at: string): ScanRow | null {
  let best: { at: string; row: ScanRow } | null = null;
  for (const c of h.calls) {
    if (c.value.name !== 'get_watchlist_scan' || c.value.role !== 'trader' || c.value.requestId === h.requestId || callAt(c) > at) continue;
    const row = parse<{ rows?: ScanRow[] }>(c.value.result)?.rows?.find(r => r.symbol && sameSymbol(r.symbol, symbol));
    if (row && (!best || callAt(c) >= best.at)) best = { at: callAt(c), row };
  }
  return best?.row ?? null;
}

/** News articles about `symbol` published after `at`, in any get_news result read since. */
function newsSince(h: History, symbol: string, at: string): number {
  const seen = new Set<string>();
  for (const c of h.calls) {
    if (c.value.name !== 'get_news' || callAt(c) <= at) continue;
    const r = parse<{ news?: Array<{ id?: unknown; headline?: string; created_at?: string; symbols?: string[] }>; yahoo?: Record<string, { news?: Array<{ title?: string; publishedAt?: string }> }> }>(c.value.result);
    for (const n of r?.news ?? [])
      if (n.created_at && n.created_at > at && (n.symbols ?? []).some(s => sameSymbol(s, symbol))) seen.add(String(n.id ?? n.headline));
    for (const [s, entry] of Object.entries(r?.yahoo ?? {}))
      if (sameSymbol(s, symbol)) for (const n of entry.news ?? []) if (n.publishedAt && n.publishedAt > at) seen.add(String(n.title ?? n.publishedAt));
  }
  return seen.size;
}

/** The earnings date get_calendar reported for `symbol`, latest read before / after `at`. */
function earningsAround(h: History, symbol: string, at: string): { before?: string | null; after?: string | null } {
  const out: { before?: string | null; after?: string | null } = {};
  for (const c of [...h.calls].sort((a, b) => callAt(a).localeCompare(callAt(b)))) {
    if (c.value.name !== 'get_calendar' || !sameSymbol(symbolOf(c), symbol)) continue;
    const r = parse<{ nextEarningsAt?: string | null }>(c.value.result);
    if (!r || !('nextEarningsAt' in r)) continue;
    if (callAt(c) <= at) out.before = r.nextEarningsAt ?? null; else out.after = r.nextEarningsAt ?? null;
  }
  return out;
}

/**
 * Whether the trader's earlier decision on this scan candidate still stands, measured against
 * `current` (its row in the scan read now). Null when there is no earlier decision at all.
 */
export function standingDecision(h: History, current: Basis): StandingCheck | null {
  const earlier = earlierDecision(h, current.symbol);
  if (!earlier) return null;
  const changed: string[] = [];
  const age = h.now.getTime() - Date.parse(earlier.at);
  if (etDate(new Date(earlier.at)) !== etDate(h.now)) changed.push('a new trading day');
  else if (age > DECISION_STANDS_MS) changed.push(`more than ${DECISION_STANDS_MS / 3_600_000} hours`);
  else {
    const base = scanAt(h, current.symbol, earlier.at);
    const was = base?.price ?? earlier.price, price = current.price;
    if (was == null || price == null) changed.push('no price to compare with');
    else {
      const limit = Math.min(...[was * REDECIDE_PRICE_PCT / 100, ...(current.atr != null && current.atr > 0 ? [current.atr * REDECIDE_ATR_MOVE] : [])]);
      if (Math.abs(price - was) >= limit) { const pct = (price - was) / was * 100; changed.push(`price ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`); }
    }
    const score = (name: string, a: number | null | undefined, b: number | null | undefined) => {
      if (a != null && b != null && Math.abs(b - a) >= REDECIDE_SCORE_CHANGE) changed.push(`${name} ${a} → ${b}`);
    };
    if (base) { score('composite', composite(base), current.composite); score('riskAdjustedScore', base.riskAdjustedScore, current.riskAdjustedScore); }
    const news = newsSince(h, current.symbol, earlier.at);
    if (news) changed.push(`${news} new news ${news === 1 ? 'story' : 'stories'}`);
    const verdict = h.calls.filter(c => c.value.role === 'researcher' && REVIEWS.includes(c.value.name) && callAt(c) > earlier.at
      && sameSymbol(symbolOf(c), current.symbol) && parse<{ ok?: boolean }>(c.value.result)?.ok).pop();
    if (verdict) changed.push(`a research verdict (${parse<{ review?: { decision?: string } }>(verdict.value.result)?.review?.decision ?? 'saved'}, ${verdict.id})`);
    const earnings = earningsAround(h, current.symbol, earlier.at);
    if (earnings.before !== undefined && earnings.after !== undefined && earnings.before !== earnings.after)
      changed.push(`earnings date ${earnings.before ?? 'none'} → ${earnings.after ?? 'none'}`);
  }
  return { earlier, changed, summary: changed.length ? `${changed.join('; ')} since your ${earlier.decision} at ${clock(earlier.at, h.now)} (${earlier.id})` : '' };
}

/** What a scan row says about an earlier decision: `decided` when it stands, `changedSinceDecision` when not. */
export function decisionMark(check: StandingCheck | null): Record<string, unknown> {
  if (!check) return {};
  const ref = { at: check.earlier.at, decision: check.earlier.decision, id: check.earlier.id };
  return check.changed.length ? { changedSinceDecision: { ...ref, changed: check.summary } } : { decided: ref };
}

/**
 * The under-invested rule's other way out: a trader scan earlier in the window whose best fitting
 * candidates all still hold their decision on the last tick's prices (the tick has no scores, so
 * only price, news, research and earnings are checked for them).
 */
function earlierScanStands(h: History): boolean {
  const start = new Date(h.now.getTime() - DECISION_STANDS_MS).toISOString(), today = etDate(h.now);
  const scans = h.calls.filter(c => c.value.name === 'get_watchlist_scan' && c.value.role === 'trader' && c.value.requestId !== h.requestId
    && callAt(c) >= start && etDate(new Date(callAt(c))) === today);
  if (!scans.length) return false;
  const lastRequest = scans.sort((a, b) => callAt(a).localeCompare(callAt(b))).at(-1)!.value.requestId;
  const top = topCandidates(scans.filter(c => c.value.requestId === lastRequest));
  const watch = getLastTick()?.watchlist ?? {};
  return top.length > 0 && top.every(row => {
    const live = Object.values(watch).find(w => sameSymbol(w.symbol, row.symbol!));
    const check = live && !live.stale ? standingDecision(h, { symbol: row.symbol!, price: live.price, atr: live.atr ?? row.atr }) : null;
    return check != null && !check.changed.length;
  });
}

/**
 * What the trader looked at or decided in this request and has not closed: a plan or exit
 * comparison with no decision recorded, or a buy/reduce/exit review with no order behind it.
 */
export function unresolvedDecisions(requestId: string, now: Date = new Date()): Unresolved[] {
  const calls = tradersCalls(requestId, [...PREVIEWS, ...REVIEWS]);
  const journal = readDecisions({ filter: r => r.requestId === requestId && r.symbol != null });
  const symbols = new Map<string, string>();
  for (const c of calls) {
    const symbol = c.value.input?.symbol ?? parse<{ symbol?: string }>(c.value.result)?.symbol;
    if (symbol && ![...symbols.keys()].some(s => sameSymbol(s, symbol))) symbols.set(symbol.toUpperCase(), c.value.name);
  }
  const out: Unresolved[] = [];
  // Sending a name to the research worker is this cycle's decision on it: the verdict comes back
  // as request_finished, and the entry decision is made in that later cycle.
  const researched = tradersCalls(requestId, ['request_research']).filter(c => parse<{ ok?: boolean }>(c.value.result)?.ok)
    .map(c => c.value.input?.symbol ?? '');
  // Only while the market is open and the book is short of its target: then a fitting candidate
  // left undecided is cash the profile asked to put to work.
  const tick = getLastTick(), gap = investmentGap(getPolicy(), tick?.portfolio?.grossDeployedPct);
  const scanned = new Map<string, ScanRow>();
  let history: History | undefined;
  const past = () => (history ??= decisionHistory(requestId, now));
  if (tick?.session === 'open' && gap?.belowTarget) {
    for (const row of scanCandidates(requestId)) {
      scanned.set(row.symbol!.toUpperCase(), row);
      if (![...symbols.keys()].some(s => sameSymbol(s, row.symbol!))) symbols.set(row.symbol!.toUpperCase(), 'get_watchlist_scan');
    }
    // An operator's request is answered on its own terms; the scheduled review owns the scan.
    if (gap.belowFloor && !isOperatorRequest(getRequest(requestId)) && !tradersCalls(requestId, ['get_watchlist_scan']).length && !earlierScanStands(past()))
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
    } else if (!lastReview && !rows.length && !researched.some(s => sameSymbol(s, symbol))) {
      const scan = scanned.get(symbol), planned = mine.some(c => c.value.name === 'get_entry_plan');
      // A scan-only candidate is covered by an earlier request's decision while nothing changed.
      const check = !position && !planned && scan ? standingDecision(past(), { symbol, price: scan.price, atr: scan.atr, composite: composite(scan), riskAdjustedScore: scan.riskAdjustedScore }) : null;
      if (check && !check.changed.length) continue;
      const problem = position ? 'you compared exit options but recorded no decision'
        : planned ? 'you ran an entry plan but recorded no decision'
        : `the scan shows it fitting the risk budget (composite ${scan?.composite ?? '?'}, up to ${scan?.riskFit?.maxQty ?? '?'} shares) while the account is below its investment target, and ${check ? `your earlier decision no longer covers it: ${check.summary}` : 'you recorded no decision'}`;
      out.push({ symbol, kind, problem, fields: kind === 'skip' ? { ...(scan?.price != null ? { intendedPrice: scan.price } : {}), ...planFields(requestId, symbol) } : {} });
    }
  }
  return out;
}

/** The sleep that ended the request: its `answer` (the reply to the operator) and its `reason`. */
export function endingSleep(requestId: string): { answer?: string; reason?: string } {
  const ended = tradersCalls(requestId, ['sleep']).filter(c => parse<{ ok?: boolean }>(c.value.result)?.ok === true).pop();
  const input = (ended?.value as { input?: { answer?: unknown; reason?: unknown } } | undefined)?.input;
  const text = (v: unknown) => String(v ?? '').trim() || undefined;
  return { answer: text(input?.answer), reason: text(input?.reason) };
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
