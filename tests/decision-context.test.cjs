const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-context-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in decision context test'); };
require('node:http').request = require('node:https').request = global.fetch = denyNetwork;
const from = name => require('../src/' + name);
const storage = from('core/storage'), state = from('state/state'), policy = from('policy/load');
const evidence = from('journal/evidence'), thesis = from('journal/thesis');
const { agentContext } = from('core/agentContext');
const { broker } = from('broker');
const barSource = from('collect/barSource'), calendar = from('collect/marketCalendar');
const portfolio = from('strategy/portfolioRisk');
const research = from('collect/research'), economy = from('collect/economicCalendar');
const followup = from('review/decisionFollowup');
const { textPage, readSavedResult, boundedCycleContext } = from('agents/savedResults');
const { recordPage } = from('tools/paging');
const { relativeIntradayVolume } = from('collect/intradayVolume');
const { forwardGeometry, positionReviewContext } = from('collect/decisionContext');
const market = from('collect/marketContext'), prices = from('collect/priceSource'), fundamentals = from('collect/fundamentals');
const journal = from('journal/journal'), lessons = from('journal/lessons');
const traderTools = from('tools/traderTools'), orderManager = from('strategy/orderManager');
const { logger } = from('core/logger');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};
const context = { role: 'trader', actorId: 'system', requestId: 'context-test' };
const bars = (n = 65, start = '2026-01-01', price = 100) => Array.from({ length: n }, (_, i) => {
  const c = price + Math.sin(i) * 2 + i * .1;
  return { t: new Date(Date.parse(start + 'T05:00:00Z') + i * 86400000).toISOString(), c, o: c, h: c + 1, l: c - 1, v: 10000 };
});
const observe = value => ({ value, source: 'alpaca', asOf: new Date().toISOString(), fetchedAt: new Date().toISOString(), stale: false });
beforeEach(() => {
  storage.resetStorage(); policy.loadPolicy();
  state.updateState({ positionSnapshots: {}, paused: false });
  broker.getPositions = async () => [];
  broker.getOpenOrders = async () => [];
});
after(storage.closeStorage);

test('mean reversion contains three readings without the duplicate Bollinger score', () => {
  const readings = from('strategy/meanReversion').computeMeanReversionSignals(bars(), policy.getPolicy());
  assert.equal(readings.length, 3);
  assert.deepEqual(readings.map(s => s.name), ['Z-Score Reversion', 'Contrarian RSI', 'Monthly Reversal']);
});

test('daily histories exclude unfinished sessions; return intervals preserve date alignment', () => {
  const history = bars(25), day = history.at(-2).t.slice(0, 10);
  assert.equal(barSource.completedDailyBars(history, day).at(-1).t, history.at(-2).t);
  assert.throws(() => barSource.completedDailyBars([{ ...history[0], t: '2026-10-07T13:30:00Z' }], '2026-10-08'), /does not reach completed/);
  const { datedReturns } = from('strategy/returnSeries');
  const a = datedReturns(history, history.at(-1).t.slice(0, 10));
  const b = datedReturns(history.filter((_, i) => i !== 10), history.at(-1).t.slice(0, 10));
  const bridge = [...b.keys()].find(k => k.startsWith(history[9].t.slice(0, 10)));
  assert.equal(a.has(bridge), false);
  assert.throws(() => datedReturns(history.slice(0, -1), history.at(-1).t.slice(0, 10)), /does not reach/);
  assert.throws(() => datedReturns([...history, history.at(-1)], history.at(-1).t.slice(0, 10)), /duplicate/);
  assert.equal(portfolio.correlate(a, new Map([...a].map(([k]) => [k, 0]))), null);
  assert.equal(portfolio.correlate(a, new Map([...a].map(([k, v]) => ['unmatched-' + k, v]))), null);
});

test('large negative correlation cannot conceal a positive correlation veto; missing coverage stays unknown', async () => {
  const oldBars = barSource.collectBars, oldSession = calendar.lastCompletedSession;
  const baseReturns = Array.from({ length: 60 }, (_, i) => Math.sin(i) * .01);
  const history = factor => {
    let price = 100;
    return baseReturns.reduce((out, r, i) => {
      price *= 1 + r * factor;
      return [...out, { ...out[0], t: new Date(Date.UTC(2026, 0, i + 2)).toISOString(), c: price }];
    }, [{ t: '2026-01-01T00:00:00Z', c: price, h: price, l: price, o: price, v: 10 }]);
  };
  calendar.lastCompletedSession = async () => ({ date: '2026-03-02' });
  barSource.collectBars = async symbol => observe(history(symbol === 'ANTI' ? -1 : 1));
  broker.getPositions = async () => [{ symbol: 'ANTI' }, { symbol: 'SAME' }];
  try {
    const result = await portfolio.correlationGate('CAND');
    assert.equal(result.allowed, false); assert.ok(result.maxCorrelation > .99); assert.ok(result.minCorrelation < -.99);
    assert.equal(result.mostCorrelatedWith, 'SAME'); assert.equal(result.measuredPairs, 2);
    barSource.collectBars = async () => ({ source: 'alpaca', error: 'missing' });
    const unknown = await portfolio.correlationGate('UNKNOWN');
    assert.equal(unknown.allowed, false); assert.equal(unknown.maxCorrelation, null);
  } finally { barSource.collectBars = oldBars; calendar.lastCompletedSession = oldSession; }
});

test('saved contexts and receipts preserve every character and pages preserve full rows', () => {
  const text = '\"\n\\'.repeat(7000);
  storage.saveRecord('tool-calls', 'large', { result: text });
  let offset = 0, restored = '';
  do { const page = JSON.parse(readSavedResult('get_tool_result', { receiptId: 'large', offset, limit: 4000 }));
    assert.ok(JSON.stringify(page).length < 9000); restored += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(restored, text); assert.throws(() => textPage(text, 0, 0), /limit/);
  const brief = '=== ACCOUNT ===\nKnown\n=== PORTFOLIO ===\n' + text + '\n=== END PORTFOLIO ===';
  const bounded = boundedCycleContext(brief, 2000);
  assert.ok(bounded.length <= 2000); assert.match(bounded, /Whole section omitted/); assert.match(bounded, /UNKNOWN/);
  const id = storage.listRecords('contexts')[0].id;
  assert.equal(storage.readRecord('contexts', id).text, brief);
  const rows = Array.from({ length: 30 }, (_, i) => ({ symbol: 'ROW' + i, rationale: 'x'.repeat(800) }));
  const first = recordPage('scan', { rows }, 'rows', { limit: 20 });
  let all = [...first.rows], next = first.nextOffset;
  while (next !== null) { const page = recordPage('scan', { rows: [] }, 'rows', { snapshotId: first.snapshotId, offset: next }); all.push(...page.rows); next = page.nextOffset; }
  assert.deepEqual(all, rows);
  assert.throws(() => recordPage('wrong', {}, 'rows', { snapshotId: first.snapshotId }), /Unknown snapshot/);
  const scoped = recordPage('filings', { symbol: 'AAPL', rows: [] }, 'rows', {});
  assert.throws(() => recordPage('filings', {}, 'rows', { symbol: 'MSFT', snapshotId: scoped.snapshotId }), /different symbol/);
  const exchanges = [{ role: 'user', content: [{ type: 'text', text: 'Review positions' }] }];
  for (let i = 0; i < 10; i++) exchanges.push({ role: 'assistant', content: [{ type: 'tool_use', name: 'read', id: String(i), input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: String(i), receiptId: 'receipt-' + i, content: 'x'.repeat(3000) }] });
  const compact = from('agents/agentLoop').compactMessages(exchanges, 12000);
  assert.match(JSON.stringify(compact[0]), /Earlier exchanges omitted/);
  assert.ok(JSON.stringify(compact).length <= 12000);
});

test('intraday volume compares identical bins and excludes incomplete historical sessions', () => {
  const sample = [];
  for (let day = 1; day <= 8; day++) for (let minute = 30; minute < 50; minute += 5) {
    if (day === 2 && minute === 40) continue;
    sample.push({ t: `2026-10-${String(day).padStart(2, '0')}T13:${minute}:00Z`, v: day === 8 ? 200 : 100 });
  }
  const result = relativeIntradayVolume(sample, new Date('2026-10-08T13:50:00Z'));
  assert.equal(result.currentVolume, 800); assert.equal(result.averageMatchedVolume, 400);
  assert.equal(result.measuredPriorSessions, 6); assert.equal(result.relativeVolume, 2);
  assert.equal(relativeIntradayVolume(sample.slice(0, -1), new Date('2026-10-08T13:50:00Z')).relativeVolume, null);
});

test('calendar parsers preserve ET DST and unknown FOMC times', () => {
  const events = economy.parseBlsCalendar('BEGIN:VEVENT\nSUMMARY:CPI\nDTSTART;TZID=America/New_York:20261013T083000\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Winter jobs\nDTSTART;TZID=US/Eastern:20260109T083000\nEND:VEVENT');
  assert.equal(events[0].scheduledAt, '2026-10-13T12:30:00.000Z');
  assert.equal(events[1].scheduledAt, '2026-01-09T13:30:00.000Z');
  const fomc = economy.parseFomcCalendar('2026 FOMC Meetings<div class="fomc-meeting__month">October</div><div class="fomc-meeting__date">27-28*</div>');
  assert.equal(fomc[0].date, '2026-10-28'); assert.equal(fomc[0].scheduledAt, null); assert.equal(fomc[0].timeConfirmed, false);
  assert.throws(() => economy.parseBlsCalendar('outage'), /no parseable/);
});

test('thesis checks do not convert missing data, legacy prose or qualitative premises into support', () => {
  const e = evidence.recordEvidence('get_position_review', { symbol: 'AAPL', metrics: { rsi: { value: 55 } } });
  const entry = thesis.validateThesis({ setup: 'Measured trend continuation', horizonDays: 20, catalystRiskAccepted: false,
    premises: [{ label: 'RSI stays above 50', metric: 'rsi', operator: 'gt', threshold: 50, evidenceIds: [e.id] },
      { label: 'Demand improves', metric: 'qualitative', evidenceIds: [e.id] }] }, 'AAPL');
  assert.equal(thesis.evaluatePremises(entry, { rsi: { value: 49 } }).status, 'contradicted');
  assert.equal(thesis.evaluatePremises(entry, { rsi: { value: 55 } }).status, 'unknown');
  assert.equal(thesis.evaluatePremises(null, {}).status, 'unknown');
  assert.throws(() => thesis.validateThesis({ ...entry, premises: [{ ...entry.premises[0], metric: 'lastClose' }] }, 'AAPL'), /measured metric/);
  assert.throws(() => evidence.validateEvidenceIds([e.id], 'MSFT'), /different symbol/);
});

test('holding dossier separates actual stop coverage from intended levels and survives partial source failure', async () => {
  const saved = { daily: market.dailyHistory, relative: market.relativeContext, prices: prices.collectPrices, fundamentals: fundamentals.getFundamentals };
  broker.getPositions = async () => [{ symbol: 'AAPL', qty: 10, avgCost: 100 }];
  broker.getOpenOrders = async () => [{ id: 'our-stop', symbol: 'AAPL', side: 'sell', type: 'stop', stopPrice: 105, qty: 8, filled: 0 }];
  state.updateState({ positionSnapshots: { AAPL: { symbol: 'AAPL', entryDecisionId: 'entry-old', stopOrderId: 'our-stop', stopLevel: 107, takeProfitLevel: 125 } } });
  market.dailyHistory = async () => ({ ...observe(bars()), asOf: bars().at(-1).t });
  market.relativeContext = async () => { throw new Error('sector outage'); };
  prices.collectPrices = async () => new Map([['AAPL', observe(110)]]);
  fundamentals.getFundamentals = async () => { throw new Error('fundamentals outage'); };
  try {
    const data = await positionReviewContext('AAPL');
    assert.equal(data.forward.stop, 105); assert.equal(data.intendedForward.stop, 107);
    assert.equal(data.brokerProtection.fullyCovered, false); assert.equal(data.brokerProtection.stopCoveredQty, 8);
    assert.equal(data.metrics.lastClose.value, bars().at(-1).c); assert.equal(data.metrics.earningsDaysUntil.value, null);
    assert.equal(data.thesisStatus.status, 'unknown'); assert.match(data.caveats.join(' '), /sector outage/);
    assert.equal(forwardGeometry(110, 105, 125, 2).remainingRewardRisk, 3);
    assert.equal(forwardGeometry(null, 105, 125, 2).remainingRewardRisk, null);
  } finally { market.dailyHistory = saved.daily; market.relativeContext = saved.relative; prices.collectPrices = saved.prices; fundamentals.getFundamentals = saved.fundamentals; }
});

test('material reviews are durable, atomic, idempotent and scoped to the entry lifecycle', () => {
  state.updateState({ positionSnapshots: { AAPL: { symbol: 'AAPL', entryDecisionId: 'entry-old' } } });
  const e = evidence.recordEvidence('get_position_review', { symbol: 'AAPL', positionKnown: true, managed: true, holding: { qty: 10 }, entryDecisionId: 'entry-old' });
  const input = { symbol: 'AAPL', decision: 'keep', changedEvidence: 'Price recovered but missing demand evidence remains unresolved.',
    evidenceIds: [e.id], snapshotId: e.id, unknowns: ['Demand'], nextReviewAt: new Date(Date.now() + 3600000).toISOString(), price: 100,
    policyHash: policy.getPolicyHash(), contextVariant: 'decision-context-v1', holdingHorizonDays: 20 };
  const result = agentContext.run({ ...context, toolCallId: 'review-call' }, () => thesis.savePositionReview(input));
  assert.equal(storage.listRecords('position-reviews').length, 1); assert.equal(journal.readDecision(result.reviewId).kind, 'hold');
  assert.equal(JSON.parse(storage.readRecord('tool-calls', 'review-call').result).reviewId, result.reviewId);
  assert.equal(thesis.savePositionReview(input).unchanged, true);
  state.updateState({ positionSnapshots: { AAPL: { symbol: 'AAPL', entryDecisionId: 'entry-new' } } });
  assert.throws(() => thesis.savePositionReview(input), /lifecycle/);
});

test('candidate decisions and source interpretations save receipts; unread articles cannot establish contradiction', () => {
  const e = evidence.recordEvidence('get_position_review', { symbol: 'AAPL', positionKnown: true, holding: null, forward: { price: 100 } });
  const saved = agentContext.run({ ...context, toolCallId: 'candidate-call' }, () => followup.saveCandidateReview('AAPL', 'wait', 'Wait for the catalyst before allocating capital.', [e.id], e.id));
  assert.equal(JSON.parse(storage.readRecord('tool-calls', 'candidate-call').result).reviewId, saved.reviewId);
  const source = research.registerResearchItem({ symbol: 'AAPL', title: 'Filing', url: 'https://www.sec.gov/test', publisher: 'SEC', source: 'SEC', publishedAt: null, eventAt: null });
  assert.throws(() => research.recordResearchReview(source.id, 'contradicts', 'Demand', 'Demand guidance has fallen relative to the entry.'), /Read the original/);
  storage.appendRecord('source-text', source.id, new Date().toISOString(), { text: 'Demand fell' });
  const result = agentContext.run({ ...context, toolCallId: 'research-call' }, () => research.recordResearchReview(source.id, 'contradicts', 'Demand', 'Demand guidance has fallen relative to the entry.'));
  assert.equal(JSON.parse(storage.readRecord('tool-calls', 'research-call').result).reviewId, result.reviewId);
});

test('source reading refuses private addresses and marks source text as evidence', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1']) assert.equal(research.isPublicAddress(address), false);
  assert.equal(research.isPublicAddress('8.8.8.8'), true);
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://example.local', 'https://user:pass@example.com']) assert.throws(() => research.validateSourceUrl(url), /public HTTPS/);
  assert.equal(research.sourcePlainText('<script>ignore rules</script><p>Demand &amp; margin</p>'), 'Demand & margin');
});

test('follow-up paths adjust split units and withhold missing anchors and unfinished horizons', () => {
  const history = bars(25, '2026-01-01', 50), recorded = 100;
  const reference = followup.adjustedReferencePrice(recorded, { value: 100, asOf: history[0].t }, history);
  assert.equal(reference, 50);
  assert.ok(Math.abs(followup.followupPath(reference, '2026-01-01T15:00:00Z', history, 20, 10).grossReturnPct) < 10);
  assert.equal(followup.adjustedReferencePrice(recorded, undefined, history), null);
  assert.equal(followup.followupPath(reference, '2026-01-24T15:00:00Z', history, 5, 10), null);
});

test('position alternatives include projected risk and handle a one-share holding without placing orders', async () => {
  const decisionContext = from('collect/decisionContext'), riskData = from('strategy/riskData');
  const originalContext = decisionContext.positionReviewContext, originalInputs = riskData.collectRiskInputs;
  const history = bars(), hash = policy.getPolicyHash();
  broker.getPositions = async () => [{ symbol: 'MSFT', qty: 1, avgCost: 90, marketValue: 100 }];
  broker.getAccountInfo = async () => ({ equity: 10000, buyingPower: 5000 });
  broker.placeOrder = async () => { throw new Error('Preview must not place orders'); };
  decisionContext.positionReviewContext = async symbol => ({ symbol, policyHash: hash, asOf: new Date().toISOString(), source: 'derived',
    holding: symbol === 'MSFT' ? { symbol, qty: 1 } : null, forward: forwardGeometry(100, 95, 115, 2),
    brokerProtection: { fullyCovered: true }, atr: 2, liquidity: { spreadBps: 20 }, relative: null });
  riskData.collectRiskInputs = async () => ({ asOf: history.at(-1).t.slice(0, 10), histories: { MSFT: history, AAPL: history }, sectors: { MSFT: 'Technology', AAPL: 'Technology' }, errors: {} });
  try {
    const preview = JSON.parse(await traderTools.executeTraderTool('compare_position_actions', { symbol: 'MSFT', candidate: 'AAPL', candidateStop: 95, candidateTarget: 115 }));
    assert.equal(preview.alternatives.length, 4);
    assert.equal(preview.alternatives[1].sellQty, 1);
    assert.equal(preview.alternatives[0].projectedBook.grossExposurePct, 1);
    assert.equal(preview.alternatives[2].projectedBook.historicalVolatilityPct, 0);
    assert.equal(preview.alternatives[2].estimatedSpreadCost, .1);
    assert.equal(preview.alternatives[3].candidate, 'AAPL');
    assert.ok(preview.evidenceId);
  } finally { decisionContext.positionReviewContext = originalContext; riskData.collectRiskInputs = originalInputs; }
});

test('follow-up retains decisions and explicitly marks one failed history without losing the rest', async () => {
  const original = barSource.collectBars, history = bars();
  const snapshot = evidence.recordEvidence('get_position_review', { symbol: 'AAPL', metrics: { lastClose: { value: history[0].c, asOf: history[0].t } }, forward: { price: 100 } });
  storage.appendRecord('candidate-reviews', 'past', '2026-01-01T15:00:00Z', { id: 'past', symbol: 'AAPL', at: '2026-01-01T15:00:00Z', decision: 'wait', snapshotId: snapshot.id, price: 100, contextVariant: 'test', policyHash: 'test' });
  barSource.collectBars = async symbol => { if (symbol === 'AAPL') throw new Error('history outage'); return observe(history); };
  try {
    const result = await followup.decisionFollowup(undefined, 365);
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].historyError, 'history outage');
    assert.equal(result.rows[0].horizons[2].passiveStock, null);
    assert.ok(result.rows[0].horizons[2].passiveBenchmark);
  } finally { barSource.collectBars = original; }
});

test('entry requests require fresh measured thesis evidence, check catalyst acceptance, and carry the thesis to the queue', async () => {
  const original = orderManager.enterPosition;
  let intent;
  orderManager.enterPosition = async signal => { intent = signal; return { status: 'pending', actionId: 'test-action', automatic: false }; };
  const e = evidence.recordEvidence('get_position_review', { symbol: 'AAPL', policyHash: policy.getPolicyHash(), positionKnown: true, holding: null,
    metrics: { rsi: { value: 55 } }, fundamentals: { calendar: { daysUntil: 3 } } });
  const input = { symbol: 'AAPL', qty: 1, price: 100, atr: 2, stopLoss: 95, takeProfit: 115,
    reason: 'Measured trend and demand support this entry.', invalidation: 'RSI falls below 50.',
    thesis: { setup: 'Measured trend continuation', horizonDays: 20, catalystRiskAccepted: false,
      premises: [{ label: 'RSI remains above 50', metric: 'rsi', operator: 'gt', threshold: 50, evidenceIds: [e.id] }] } };
  try {
    assert.equal(JSON.parse(await traderTools.executeTraderTool('execute_entry', { ...input, thesis: undefined })).ok, false);
    assert.match(JSON.parse(await traderTools.executeTraderTool('execute_entry', input)).error, /gap risk/);
    input.thesis.catalystRiskAccepted = true;
    assert.equal(JSON.parse(await traderTools.executeTraderTool('execute_entry', input)).ok, true);
    assert.deepEqual(intent.thesis, input.thesis); assert.deepEqual(intent.observationIds, [e.id]);
    input.thesis.premises[0].threshold = 60;
    assert.match(JSON.parse(await traderTools.executeTraderTool('execute_entry', input)).error, /contradicted/);
  } finally { orderManager.enterPosition = original; }
});

test('lessons retain decision sample counts, counter-evidence and future review dates', () => {
  journal.recordDecision(journal.decision('exit', 'trader', { symbol: 'AAPL', executed: true, rationale: 'Measured loss' }), 'loss');
  journal.recordDecision(journal.decision('exit', 'trader', { symbol: 'MSFT', executed: true, rationale: 'Measured gain' }), 'gain');
  agentContext.run({ ...context, toolCallId: 'lesson' }, () => lessons.recordLesson('Check events before buying.', ['loss', 'loss'], { counterEvidenceIds: ['gain'], scope: 'Earnings gaps' }));
  const lesson = lessons.listLessons()[0];
  assert.equal(lesson.sampleCount, 1); assert.equal(lesson.completedExitCount, 1); assert.deepEqual(lesson.counterEvidenceIds, ['gain']);
  assert.match(lessons.readLessons()[0], /not independent trades/);
  assert.throws(() => lessons.recordLesson('Invalid', ['loss'], { counterEvidenceIds: ['loss'] }), /distinct/);
});
