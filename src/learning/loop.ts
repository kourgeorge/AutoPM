/**
 * The learning loop: measure every signal, re-weight, test new ideas, promote or retire.
 *
 * Runs once per ET weekday after the close (see `startLearning`). Each run:
 *   1. refreshes ten years of split-adjusted daily bars for the watchlist + a fixed universe;
 *   2. measures every built-in and model-written signal (`evaluate.ts`);
 *   3. moves each weight a small step toward what the last two years support;
 *   4. walks each model-written signal through   testing → shadow → active   (or rejected/retired);
 *   5. about once a week, asks the model for up to three new indicators to test.
 *
 * What it may change: signal weights (0..2, at most 0.2 per run) and which model-written
 * signals count. What it may never change: stops, position limits, the daily loss halt, the
 * entry threshold, or anything else in the trading settings — those stay with the operator.
 *
 * Why the tests look the way they do:
 * - The model sees numbers only from the LEARN period (older than two years). The EXAM period
 *   is held back, so passing it means something.
 * - The more ideas are tried, the more will look good by luck, so the exam bar rises with the
 *   number of ideas ever tested (`requiredT`).
 * - Passing the exam earns a SHADOW trial: scored live every day, counting for nothing, until
 *   enough days after its creation show whether it still works on data nobody had seen.
 */
import crypto from 'crypto';
import { readValue, saveValue, saveRecord, readRecords, isEphemeralStorage } from '../core/storage';
import { agentContext } from '../core/agentContext';
import { createLiveModelProvider } from '../core/modelProvider';
import { logger } from '../core/logger';
import { etDate, etNow } from '../core/time';
import { getPolicy } from '../policy/load';
import type { ToolDefinition } from '../core/types';
import { LEARNING_UNIVERSE, loadUniverse } from './history';
import { buildUniverse, report, requiredT, scoreBuiltIns, scoreSignals, similarity, HORIZON, type SignalReport, type PeriodStats, type Scored, type Universe } from './evaluate';
import { compileSignal, checkCode, WINDOW } from './sandbox';
import { LEARNED_PREFIX, SandboxedSignal } from '../signals/sandboxed';

/** What the live engine reads (see `signals/registry.ts`): promoted signals and when they were set. */
interface LearningLive { at: string; weights: Record<string, number>; active: { id: string; name: string; code: string; idea?: string }[] }

export type CandidateStatus = 'testing' | 'rejected' | 'shadow' | 'active' | 'retired';
export interface Candidate {
  id: string; name: string; idea: string; code: string;
  status: CandidateStatus; createdAt: string; liveSince: string;
  reason: string; history: { at: string; status: CandidateStatus; reason: string }[];
  report?: SignalReport; maxSimilarity?: { to: string; value: number } | null;
}
export interface LearningReport {
  at: string; tradingDay: string; stocks: number; firstDay: string; lastDay: string; examStart: string;
  horizonDays: number; ideasTested: number; examBar: number;
  builtIns: SignalReport[]; learned: Candidate[]; weights: Record<string, number>; changes: string[];
}
export interface LearningSettings { enabled: boolean; proposeIdeas: boolean }

const KIND = 'learning-signals';
const MAX_ACTIVE = 3, MAX_STEP = 0.2, MAX_WEIGHT = 2;
const MIN_T_TO_MOVE = 1.5;   // below this the recent record is too unsure to move a weight
const IC_FULL = 0.03;          // a mean IC of 0.03 on five-day returns is already a strong signal
const SIMILAR = 0.7;           // above this a new idea is a copy of one we have
const SHADOW_DAYS = 40, SHADOW_MAX_DAYS = 120, ACTIVE_REVIEW_DAYS = 60;
const PROPOSE_EVERY_DAYS = 7, IDEAS_PER_ROUND = 3;

export function learningSettings(): LearningSettings {
  const s = readValue<Partial<LearningSettings>>('learningSettings') ?? {};
  return { enabled: s.enabled !== false, proposeIdeas: s.proposeIdeas !== false };
}
export function saveLearningSettings(s: Partial<LearningSettings>): LearningSettings {
  const next = { ...learningSettings(), ...Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'boolean')) };
  saveValue('learningSettings', next);
  return next;
}
export const learningReport = (): LearningReport | null => readValue<LearningReport>('learningReport') ?? null;
export const candidates = (): Candidate[] => readRecords<Candidate>(KIND);

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Where the evidence says a weight belongs: 1 is neutral, 2 is strong, 0 is "does not help". */
function targetWeight(r: SignalReport, older: PeriodStats | null = r.periods.learn): number {
  const e = r.periods.exam;
  if (e.meanIC === null || e.tStat === null || e.days < 30) return 1;
  // Noise moves nothing: the recent record must be reasonably sure, and the older years
  // (when given) must point the same way. Measured 2026-11-08: every built-in had |t| < 1.1
  // and several flipped sign between periods — re-weighting on that would be chasing luck.
  if (Math.abs(e.tStat) < MIN_T_TO_MOVE) return 1;
  if (older && (older.meanIC === null || Math.sign(older.meanIC) !== Math.sign(e.meanIC))) return 1;
  const confidence = Math.min(1, Math.abs(e.tStat) / 3);
  return clamp(1 + clamp(e.meanIC / IC_FULL, -1, 1) * confidence, 0, MAX_WEIGHT);
}
function step(from: number, to: number): number {
  return round2(from + clamp(to - from, -MAX_STEP, MAX_STEP));
}

function setStatus(c: Candidate, status: CandidateStatus, reason: string, at: string): string {
  c.status = status; c.reason = reason; c.history.push({ at, status, reason });
  return `${c.name}: ${status} — ${reason}`;
}

function maxSimilarity(u: Universe, sc: Scored, against: { scored: Scored; k: number; name: string }[]): { to: string; value: number } | null {
  let best: { to: string; value: number } | null = null;
  for (const a of against) {
    const v = similarity(sc, 0, a.scored, a.k);
    if (v !== null && (!best || Math.abs(v) > Math.abs(best.value))) best = { to: a.name, value: v };
  }
  return best;
}

/** One full pass. Safe to call by hand (`npm run learn`). */
export async function runLearning(opts: { propose?: boolean; refresh?: boolean; now?: Date } = {}): Promise<LearningReport> {
  const now = opts.now ?? new Date(), at = now.toISOString(), today = etDate(now);
  const policy = getPolicy();
  const bars = await loadUniverse([...LEARNING_UNIVERSE, ...policy.strategy.watchlist], opts.refresh !== false);
  if (bars.size < 10) throw new Error(`Only ${bars.size} stocks have enough price history; the study needs at least 10`);
  const u = buildUniverse(bars);
  const changes: string[] = [];

  const builtScored = scoreBuiltIns(u, policy);
  const builtIns = builtScored.names.map((_, k) => report(u, builtScored, k, '9999-12-31'));
  const compare = builtScored.names.map((name, k) => ({ scored: builtScored, k, name }));

  const all = candidates();
  const ideasTested = all.length;
  const examBar = requiredT(ideasTested);
  const learnedScored = new Map<string, Scored>();

  for (const c of all) {
    if (c.status === 'rejected' || c.status === 'retired') continue;
    let sc: Scored;
    try { compileSignal(c.code); sc = scoreSignals(u, [new SandboxedSignal(c.id, c.name, c.code, c.idea)], policy); }
    catch (err: any) { changes.push(setStatus(c, c.status === 'testing' ? 'rejected' : 'retired', `its code failed: ${String(err.message).slice(0, 160)}`, at)); saveRecord(KIND, c.id, c); continue; }
    c.report = report(u, sc, 0, c.liveSince);
    const { learn, exam, live } = c.report.periods;
    if (c.status === 'testing') {
      const scoredShare = sc.points.reduce((a, p) => a + p.scores.filter(v => v !== null).length, 0) / Math.max(1, sc.points.reduce((a, p) => a + p.fwd.length, 0));
      c.maxSimilarity = maxSimilarity(u, sc, [...compare, ...[...learnedScored].map(([name, s]) => ({ scored: s, k: 0, name }))]);
      if (scoredShare < 0.5) changes.push(setStatus(c, 'rejected', `it gave a score on only ${Math.round(scoredShare * 100)}% of stock-days`, at));
      else if (!(learn.meanIC! > 0) || !(learn.tStat! >= 2)) changes.push(setStatus(c, 'rejected', `no clear edge even on the learning years (IC ${learn.meanIC}, t ${learn.tStat})`, at));
      else if (!(exam.meanIC! > 0) || !(exam.tStat! >= examBar)) changes.push(setStatus(c, 'rejected', `failed the exam on the last two years (IC ${exam.meanIC}, t ${exam.tStat}, needed t ≥ ${examBar} after ${ideasTested} ideas)`, at));
      else if (c.maxSimilarity && Math.abs(c.maxSimilarity.value) > SIMILAR) changes.push(setStatus(c, 'rejected', `it is ${Math.round(Math.abs(c.maxSimilarity.value) * 100)}% the same as ${c.maxSimilarity.to}`, at));
      else { c.liveSince = today; changes.push(setStatus(c, 'shadow', `passed the exam (IC ${exam.meanIC}, t ${exam.tStat}); now scored live without counting`, at)); }
    } else if (c.status === 'shadow') {
      if (live.days >= SHADOW_DAYS && live.meanIC! > 0 && live.tStat! >= 1) {
        const activeCount = all.filter(x => x.status === 'active').length;
        if (activeCount < MAX_ACTIVE) changes.push(setStatus(c, 'active', `held up on ${live.days} live days (IC ${live.meanIC}, t ${live.tStat}); now counts in the composite`, at));
      } else if (live.days >= SHADOW_DAYS && !(live.meanIC! > 0)) changes.push(setStatus(c, 'retired', `stopped working once live (IC ${live.meanIC} over ${live.days} days)`, at));
      else if (live.days >= SHADOW_MAX_DAYS) changes.push(setStatus(c, 'retired', `never proved itself live after ${live.days} days (IC ${live.meanIC}, t ${live.tStat})`, at));
    } else if (c.status === 'active') {
      if (live.days >= ACTIVE_REVIEW_DAYS && !(live.meanIC! > 0)) changes.push(setStatus(c, 'retired', `its live record turned non-positive (IC ${live.meanIC} over ${live.days} days)`, at));
    }
    if (!['rejected', 'retired'].includes(c.status as string)) learnedScored.set(c.name, sc);
    saveRecord(KIND, c.id, c);
  }

  // Weights: built-ins from the exam years; a learned signal starts at 0.5 when promoted and
  // then follows its LIVE record (its exam years were part of what got it chosen).
  const prev = readValue<LearningLive>('learningLive');
  const weights: Record<string, number> = {};
  for (const r of builtIns) weights[r.name] = step(prev?.weights?.[r.name] ?? 1, targetWeight(r));
  const active = all.filter(c => c.status === 'active');
  for (const c of active) {
    const key = LEARNED_PREFIX + c.name, live = c.report!.periods.live;
    const target = live.days >= 20 ? targetWeight({ ...c.report!, periods: { ...c.report!.periods, exam: live } }, null) : 0.5;
    weights[key] = prev?.weights?.[key] === undefined ? 0.5 : step(prev.weights[key], target);
  }
  for (const [name, w] of Object.entries(weights)) {
    const before = prev?.weights?.[name] ?? 1;
    if (Math.abs(before - w) >= 0.05) changes.push(`${name} weight ${before.toFixed(2)} → ${w.toFixed(2)}`);
  }
  saveValue('learningLive', { at, weights, active: active.map(c => ({ id: c.id, name: c.name, code: c.code, idea: c.idea })) } satisfies LearningLive);
  // Kept separately too: the composite reads it on every tick and needs only the numbers.
  saveValue('learningWeights', weights);

  const lastProposal = readValue<string>('learningLastProposal');
  const due = !lastProposal || Date.parse(at) - Date.parse(lastProposal) >= PROPOSE_EVERY_DAYS * 86_400_000;
  if ((opts.propose ?? due) && learningSettings().proposeIdeas) {
    try {
      const added = await proposeSignals(builtIns, all, at, today);
      saveValue('learningLastProposal', at);
      if (added.length) changes.push(`new ideas to test next run: ${added.map(c => c.name).join(', ')}`);
    } catch (err: any) { changes.push(`could not get new ideas: ${String(err.message).slice(0, 200)}`); }
  }

  const out: LearningReport = {
    at, tradingDay: today, stocks: u.symbols.length, firstDay: u.dates[0], lastDay: u.dates.at(-1)!, examStart: u.examStart,
    horizonDays: HORIZON, ideasTested, examBar, builtIns, learned: candidates(), weights, changes,
  };
  saveValue('learningReport', out);
  for (const line of changes) logger.info(`[Learning] ${line}`);
  logger.info(`[Learning] measured ${builtIns.length + learnedScored.size} signals on ${u.symbols.length} stocks, ${u.dates[0]} → ${u.dates.at(-1)}`);
  return out;
}

// ── New ideas from the model ────────────────────────────────────────────────

const PROPOSE_TOOL: ToolDefinition = {
  name: 'propose_signals',
  description: 'Submit new indicator ideas to be tested.',
  input_schema: {
    type: 'object',
    properties: {
      signals: {
        type: 'array', maxItems: IDEAS_PER_ROUND,
        items: { type: 'object', properties: {
          name: { type: 'string', description: 'Short unique name, 3–40 characters.' },
          idea: { type: 'string', description: 'One or two sentences: what it measures and why it might predict the next week.' },
          code: { type: 'string', description: 'Plain JavaScript defining function signal(o, h, l, c, v) that returns a number from -1 to +1, or null.' },
        }, required: ['name', 'idea', 'code'] },
      },
    },
    required: ['signals'],
  },
};

function fmt(r: SignalReport): string {
  const l = r.periods.learn;
  return `${r.name}: IC ${l.meanIC} (t ${l.tStat}, right on ${Math.round((l.hitRate ?? 0) * 100)}% of days; up-market IC ${l.upMarketIC}, down-market IC ${l.downMarketIC})`;
}

function proposalPrompt(builtIns: SignalReport[], past: Candidate[]): string {
  const tried = past.slice(-30).map(c => `- ${c.name} [${c.status === 'rejected' && /exam/.test(c.reason) ? 'rejected' : c.status}]: ${c.idea}${c.report ? ` — learning-years IC ${c.report.periods.learn.meanIC} (t ${c.report.periods.learn.tStat})` : ''}`).join('\n') || '(none yet)';
  return `You design stock indicators for a swing-trading system that holds US stocks for days to weeks.

HOW IDEAS ARE JUDGED
Each day every stock in a universe of ~60 large US stocks and ETFs is scored by the indicator. We then check whether the stocks it scored higher did better from the next day's open to the close ${HORIZON} trading days later. The measure is the daily rank correlation between score and return (IC): 0 = no better than chance, 0.02–0.05 is useful. Ideas must show an edge on older years AND on recent years you cannot see, then keep working live for two months before they count. Copies of existing indicators (score correlation above ${SIMILAR}) are rejected.

WHAT EXISTS (numbers from the older "learning" years only)
${builtIns.map(fmt).join('\n')}

IDEAS ALREADY TRIED
${tried}

THE CODE
Write plain JavaScript (no imports, no globals, no Math.random, no Date):
  function signal(o, h, l, c, v) { ... return score; }
o, h, l, c, v are arrays of the last ${WINDOW} daily open, high, low, close and volume values, oldest first; the last element is the day being scored. Return a number from -1 (expect underperformance) to +1 (expect outperformance), or null if it cannot say. Only relative order across stocks matters, so scale is free. Helper functions may be defined inside the code. The words require, import, process, global, globalThis, constructor, prototype, Function, eval, this, Reflect, Proxy, Symbol, fetch, setTimeout are refused.

Propose up to ${IDEAS_PER_ROUND} genuinely different ideas — not small parameter changes of what exists or what failed. Favour ideas with an economic reason (e.g. volatility compression, overnight vs intraday returns, volume shocks, distance from highs, trend quality, short-term reversal) over curve-fitting.`;
}

async function proposeSignals(builtIns: SignalReport[], past: Candidate[], at: string, today: string): Promise<Candidate[]> {
  const provider = createLiveModelProvider();
  const response = await agentContext.run({ role: 'researcher', requestId: 'learning-' + today, actorId: 'learning' }, () => provider.chat({
    systemPrompt: 'You are a careful quantitative researcher. Answer only by calling propose_signals.',
    messages: [{ role: 'user', content: [{ type: 'text', text: proposalPrompt(builtIns, past) }] }],
    tools: [PROPOSE_TOOL], maxTokens: 6000, toolChoice: { type: 'tool', name: PROPOSE_TOOL.name },
  }));
  const use = response.content.find(b => b.type === 'tool_use');
  const list = use && use.type === 'tool_use' && Array.isArray((use.input as any).signals) ? (use.input as any).signals : [];
  const names = new Set(past.map(c => c.name.toLowerCase()));
  const added: Candidate[] = [];
  for (const raw of list.slice(0, IDEAS_PER_ROUND)) {
    const name = String(raw?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40), idea = String(raw?.idea ?? '').trim().slice(0, 600), code = String(raw?.code ?? '');
    const c: Candidate = { id: 'sig-' + crypto.randomUUID().slice(0, 8), name, idea, code, status: 'testing', createdAt: at, liveSince: today, reason: 'waiting for its first test', history: [] };
    if (name.length < 3 || names.has(name.toLowerCase())) { if (name.length >= 3) logger.info(`[Learning] skipped duplicate idea name ${name}`); continue; }
    try { checkCode(code); compileSignal(code); c.history.push({ at, status: 'testing', reason: 'proposed by the model' }); }
    catch (err: any) { setStatus(c, 'rejected', `its code was refused: ${err.message}`, at); }
    names.add(name.toLowerCase()); saveRecord(KIND, c.id, c); added.push(c);
  }
  return added;
}

// ── Schedule ────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | undefined;
let running: Promise<unknown> | null = null;

/** Run now unless a run is already going. Resolves with the report or an error message. */
export function triggerLearning(opts: { propose?: boolean } = {}): Promise<LearningReport> {
  if (running) return running as Promise<LearningReport>;
  const p = runLearning(opts).finally(() => { running = null; });
  running = p.catch(() => undefined);
  return p;
}

/** Checks every 20 minutes; runs once per ET weekday after 18:00, or at start if it never ran. */
export function startLearning(): void {
  if (isEphemeralStorage() || timer) return;
  const check = () => {
    if (!learningSettings().enabled || running) return;
    const et = etNow(), last = learningReport()?.tradingDay;
    const weekday = et.day >= 1 && et.day <= 5;
    if (last && (last === etDate() || !weekday || et.hours < 18)) return;
    triggerLearning().catch(err => logger.warn(`[Learning] run failed: ${err.message}`));
  };
  setTimeout(check, 120_000).unref?.();
  timer = setInterval(check, 20 * 60_000);
  timer.unref?.();
}
export function stopLearning(): void { if (timer) clearInterval(timer); timer = undefined; }

// ── Reading the results ─────────────────────────────────────────────────────

/** The plain summary agents and the dashboard read. Code measures; it states no verdicts. */
export function signalScorecard() {
  const r = learningReport(), live = readValue<LearningLive>('learningLive');
  if (!r) return { measured: false, note: 'The learning layer has not run yet. It runs each weekday after 18:00 ET.', settings: learningSettings() };
  const row = (s: SignalReport, extra: Record<string, unknown> = {}) => ({ name: s.name, ...extra,
    weight: live?.weights?.[s.name] ?? (extra.status === 'active' ? live?.weights?.[LEARNED_PREFIX + s.name] : undefined) ?? 1,
    olderYears: s.periods.learn, lastTwoYears: s.periods.exam, lastYear: s.periods.lastYear, ...(extra.status ? { live: s.periods.live } : {}) });
  return {
    measured: true, at: r.at, settings: learningSettings(),
    howToRead: `For each signal, the daily rank agreement (IC, -1..+1) between its score and each stock's return from the next open to ${r.horizonDays} trading days later, across ${r.stocks} stocks from ${r.firstDay} to ${r.lastDay}. 0 = no better than chance; 0.02–0.05 is useful. tStat above ~2 is unlikely to be luck for one signal; with many tested, more is needed (the current bar for new ideas is ${r.examBar}). Weights scale each signal's share of the trend composite; 1 = unchanged.`,
    builtIns: r.builtIns.map(s => row(s)),
    learned: r.learned.map(c => ({ id: c.id, name: c.name, status: c.status, reason: c.reason, idea: c.idea, createdAt: c.createdAt,
      ...(c.report ? row(c.report, { status: c.status }) : {}), similarTo: c.maxSimilarity ?? null })),
    recentChanges: r.changes,
  };
}
