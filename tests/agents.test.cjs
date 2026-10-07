const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const root = path.resolve(__dirname, '..');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-agent-audit-')),
  BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'audit',
  ALPACA_KEY_ID: 'audit', ALPACA_SECRET_KEY: 'audit',
  ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
});
require(root + '/node_modules/ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access in agent audit'); };
require('node:http').request = denyNetwork;
require('node:https').request = denyNetwork;
global.fetch = denyNetwork;
const from = name => require(root + '/src/' + name);
const storage = from('core/storage');
const state = from('state/state');
const policy = from('policy/load');
const model = from('core/modelProvider');
model.createModelProvider = () => ({ chat: async () => { throw new Error('Set audit provider'); } });
const traderTools = from('tools/traderTools');
const chartTools = from('tools/chartTools');
const orders = from('strategy/orderManager');
const actions = from('core/actions');
const journal = from('journal/journal');
const lessons = from('journal/lessons');
const events = from('features/eventBus');
const eventLog = from('features/alertLog');
const { ui } = from('ui/ui');
const { ConciergeAgent } = from('agents/concierge');
const { Trader, buildCycleContext } = from('agents/trader');
const { logger } = from('core/logger');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};
ui.reply = () => {};
ui.replyChart = () => {};
ui.setConciergeActivity = () => {};
traderTools.getAccountSnapshot = async () => ({ equity: 10000, cash: 10000, buyingPower: 10000, startOfDayEquity: 10000, dailyPnL: 0, dailyPnLPct: 0, maxPositions: 5 });
traderTools.getMarketStatusSnapshot = async () => ({ isOpen: true, etTime: '10:00', minutesUntilChange: 390, changeLabel: 'close' });
traderTools.brokerOrderView = async () => ({ orders: [], byPosition: [], ordersWithoutPosition: [], stopMismatches: [] });
from('strategy/exposure').exposure = async () => ({ positions: [] });
const { broker } = from('broker');
broker.getAccountInfo = traderTools.getAccountSnapshot;
broker.getPositions = async () => [];
broker.getOpenOrders = async () => [];
const commands = from('core/requests');
const { agentContext } = from('core/agentContext');
const { runAgentLoop, compactMessages } = from('agents/agentLoop');
const { ToolRegistry } = from('agents/toolRegistry');
const textResponse = () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Done' }], usage: { inputTokens: 1, outputTokens: 1 } });
const toolResponse = calls => ({ stopReason: 'tool_use', content: calls.map(([name, input], index) => ({ type: 'tool_use', id: 'audit-' + index, name, input })), usage: { inputTokens: 1, outputTokens: 1 } });
beforeEach(() => {
  storage.resetStorage();
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:audit', paused: false });
  policy.loadPolicy();
  events.resetEventRegistry();
});
after(() => storage.closeStorage());

test('concierge rejects undeclared mutations and malformed tool inputs', async () => {
  let handoffs = 0;
  const concierge = new ConciergeAgent(() => { handoffs++; });
  for (const name of ['execute_exit','execute_entry','write_lesson','ack_event']) {
    const result = JSON.parse(await concierge.executeTool(name, { symbol: 'AAPL' }));
    assert.match(result.error, /not permitted/);
  }
  for (const input of [null, {}, { message: 42 }, { message: 'x', extra: true }]) {
    assert.equal(JSON.parse(await concierge.executeTool('send_to_trader', input)).ok, false);
  }
  assert.equal(handoffs, 0);
  assert.equal(lessons.readLessons().length, 0);
});

test('concierge settings reads are fresh, local and unaffected by conflicting playbook prose', async () => {
  let handoffs = 0;
  const concierge = new ConciergeAgent(() => { handoffs++; });
  const before = policy.getPolicySnapshot();
  const original = JSON.parse(await concierge.executeTool('get_strategy_settings', {}));
  assert.equal(original.profile, 'Balanced');
  assert.equal(original.risk.riskPerTradePctOfEquity, 0.5);
  const next = structuredClone(before.policy);
  next.risk.riskPerTradePct = 0.35;
  next.automation.level.entry = 'auto';
  const changed = policy.saveStrategy(next, before.hash, 'alice', before.playbook + '\nLegacy note: risk per trade is 9%.');
  const fresh = JSON.parse(await concierge.executeTool('get_strategy_settings', {}));
  assert.equal(fresh.profile, 'Custom');
  assert.equal(fresh.risk.riskPerTradePctOfEquity, 0.35);
  assert.equal(fresh.strategyHash, changed.hash);
  assert.equal(fresh.automation.entries, 'Automatic approval');
  assert.doesNotMatch(fresh.summary, /9%/);
  assert.equal(policy.getPolicyHash(), changed.hash);
  assert.equal(handoffs, 0);
  assert.equal(JSON.parse(await concierge.executeTool('get_strategy_settings', { activate: true })).ok, false);
});

test('concierge saves requested settings changes and refuses invalid ones', async () => {
  const concierge = new ConciergeAgent(() => assert.fail('Settings changes must not wake the trader'));
  const before = policy.getPolicySnapshot();
  const values = { riskPerTradePct: 0.75, targetVolatilityPct: 20, minRewardRisk: 2.5, maxSectorWeightPct: 20 };
  const result = JSON.parse(await concierge.executeTool('update_trading_settings', values));
  assert.equal(result.ok, true);
  assert.ok(result.applied.some(line => /riskPerTradePct: 0\.5 → 0\.75/.test(line)));
  assert.equal(result.saved.risk.riskPerTradePctOfEquity, 0.75);
  assert.notEqual(policy.getPolicyHash(), before.hash);
  const fresh = JSON.parse(await concierge.executeTool('get_strategy_settings', {}));
  assert.equal(fresh.risk.riskPerTradePctOfEquity, 0.75);
  assert.equal(fresh.risk.annualizedPortfolioVolatilityTargetPct, 20);
  assert.deepEqual(policy.getPolicy().automation, before.policy.automation);
  const hash = policy.getPolicyHash();
  assert.equal(JSON.parse(await concierge.executeTool('update_trading_settings', { riskPerTradePct: 50 })).ok, false);
  assert.equal(policy.getPolicyHash(), hash);
  assert.equal(commands.pendingRequests('trader').length, 0);
  policy.saveStrategy(before.policy, hash, 'test', before.playbook);
});

test('a settings explanation reaches the account conversation without a trader handoff', async () => {
  const concierge = new ConciergeAgent(() => assert.fail('No trader action was requested'));
  let rounds = 0;
  concierge.provider = { chat: async request => {
    assert.match(request.systemPrompt, /Read get_strategy_settings afresh/);
    assert.match(request.systemPrompt, /Settings questions do not wake the trader/);
    assert.ok(request.tools.some(tool => tool.name === 'get_strategy_settings'));
    if (rounds++ === 0) return toolResponse([['get_strategy_settings', {}]]);
    const result = request.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
    const settings = JSON.parse(result.content);
    assert.equal(settings.truncated, undefined);
    return { ...textResponse(), content: [{ type: 'text', text: settings.summary }] };
  } };
  const hash = policy.getPolicyHash();
  const receipt = concierge.handleMessage('Explain my strategy settings clearly', 'alice');
  await concierge.active;
  const command = commands.getRequest(receipt.id);
  assert.equal(command.status, 'completed');
  assert.match(command.result, /Saved strategy: Balanced/);
  assert.match(command.result, /0.5% of equity at the planned stop/);
  assert.match(command.result, /Human approval|human approval/);
  assert.ok(storage.readActivity(0, 100).some(entry => entry.kind === 'reply' && entry.text.includes(command.result)));
  commands.updateRequest(commands.enqueueRequest('trader', 'Review', 'system').id, { status: 'completed', result: 'Review completed; no trade action was queued.' });
  assert.ok(!storage.readActivity(0, 1000).some(entry => entry.kind === 'reply' && /no trade action/.test(entry.text)), 'trader results are not chat replies');
  assert.equal(policy.getPolicyHash(), hash);
  assert.equal(commands.pendingRequests('trader').length, 0);
});

test('a failed chart returns a paired error and the concierge can answer the next message', async () => {
  let rounds = 0;
  const trader = new Trader();
  const concierge = new ConciergeAgent(message => trader.wake(message));
  const realChart = chartTools.executeChartTool;
  chartTools.executeChartTool = async () => { throw new Error('Chart unavailable'); };
  concierge.provider = { chat: async request => {
    if (rounds++ === 0) return toolResponse([['send_to_trader', { message: 'Review AAPL' }], ['show_price_history', { symbol: 'AAPL' }]]);
    const assistant = request.messages.find(m => m.role === 'assistant');
    assert.equal(assistant.content.filter(b => b.type === 'tool_use').length, 2);
    const results = request.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
    assert.equal(results.length, 2); assert.match(results[1].content, /Chart unavailable/);
    return textResponse();
  } };
  try {
    const first = concierge.handleMessage('Review AAPL and chart it', 'alice');
    await concierge.active;
    assert.equal(commands.getRequest(first.id).status, 'completed');
    assert.equal(commands.pendingRequests('trader')[0].actorId, 'alice');
    const second = concierge.handleMessage('What happened?', 'bob');
    await concierge.active;
    assert.equal(commands.getRequest(second.id).status, 'completed');
    // The second chat continues from the first chat's saved turn.
    const firstTurn = storage.readRecord('transcripts', first.id).messages, secondTurn = storage.readRecord('transcripts', second.id).messages;
    assert.deepEqual(secondTurn.slice(0, firstTurn.length), compactMessages(firstTurn, 24000));
    assert.match(JSON.stringify(secondTurn.at(-2) ?? secondTurn.at(-1)), /What happened\?/);
  } finally { chartTools.executeChartTool = realChart; }
});

test('failed trader requests remain durable with their instruction and explicit outcome', async () => {
  const trader = new Trader();
  const receipt = trader.wake('Review AAPL now');
  trader.provider = { chat: async () => { throw new Error('Model unavailable'); } };
  await trader.runCycle();
  const command = commands.getRequest(receipt.requestId);
  assert.equal(command.text, 'Review AAPL now');
  assert.equal(command.status, 'failed');
  assert.match(command.result, /Model unavailable/);
  assert.equal(storage.readRecord('transcripts', command.id).status, 'failed');
});

test('sleep rejects later calls and truncated model output executes no tools', async () => {
  const trader = new Trader();
  trader.provider = { chat: async () => toolResponse([['sleep', { minutes: 60, reason: 'Finished' }], ['write_lesson', { lesson: 'Do not save', evidenceIds: [] }]]) };
  const receipt = trader.wake('Review');
  await trader.runCycle();
  assert.equal(lessons.readLessons().length, 0);
  const turn = storage.readRecord('transcripts', receipt.requestId);
  assert.match(turn.messages.at(-1).content[1].content, /not executed/);
  let executed = 0;
  const registry = new ToolRegistry([{ name: 'write', description: 'test', input_schema: { type: 'object', properties: {}, required: [] } }], async () => { executed++; return '{}'; });
  const result = await runAgentLoop({ context: { requestId: 'truncated', actorId: 'test', role: 'trader' }, registry,
    provider: { chat: async () => ({ ...toolResponse([['write', {}]]), stopReason: 'max_tokens' }) },
    systemPrompt: '', messages: async () => [], maxRounds: 2, maxTokens: 100 });
  assert.equal(result.status, 'failed'); assert.equal(executed, 0);
});

test('critical observation remains open and acting requires a linked action', async () => {
  const p = policy.getPolicy(), tick = { cooldowns: {}, armed: new Set(), dirty: false };
  const hit = { symbol: 'AAPL', cooldownKey: 'audit:stop', severity: 'critical', headline: 'Below stop', evidence: {}, crossing: { level: 90, threshold: 95, direction: 'below', band: 1 } };
  const [event] = events.processHits('stop_breach', [hit], p, tick);
  const bad = JSON.parse(await traderTools.executeTraderTool('ack_event', { id: event.id, disposition: 'acting' }));
  assert.match(bad.error, /actionId/);
  events.ackEvent(event.id, 'acknowledged', 'Observed');
  assert.equal(events.getPendingEvents().length, 1);
  const action = actions.createAction({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'Below stop', params: { qty: 2 }, eventId: event.id, automatic: true, timeoutMs: 60000 });
  events.ackEvent(event.id, 'acting', 'Exit queued', action.id);
  assert.equal(events.getPendingEvents()[0].handling, 'action_pending');
  actions.transitionAction(action.id, 'failed', { result: { error: 'Cannot execute' } });
  assert.equal(events.getPendingEvents()[0].handling, 'observed');
  assert.equal(events.getPendingEvents()[0].ackedAt, null);
  assert.equal(storage.readRecords('alerts').find(e => e.id === event.id).handling, 'observed', 'event.jsonl records the handling');
});

test('pending urgent incidents and handling survive registry restart', () => {
  const p = policy.getPolicy(), tick = { cooldowns: {}, armed: new Set(), dirty: false };
  const hit = { symbol: 'AAPL', cooldownKey: 'audit:urgent', severity: 'urgent', headline: 'Review', evidence: {}, crossing: { level: 90, threshold: 95, direction: 'below', band: 1 } };
  const [event] = events.processHits('ema_cross_down', [hit], p, tick);
  events.resetEventRegistry(true);
  assert.equal(events.getPendingEvents()[0].id, event.id);
  events.ackEvent(event.id, 'ignoring', 'Operator deliberately accepts this condition');
  events.resetEventRegistry(true);
  assert.deepEqual(events.getPendingEvents(), []);
  assert.equal(storage.readRecords('alerts').find(e => e.id === event.id).handling, 'declined');
});

test('escalation preserves incident identity and a recross resolves pending work', () => {
  const p=policy.getPolicy(), tick={cooldowns:{},armed:new Set(),dirty:false}, now=Date.now();
  const hit={symbol:'AAPL',cooldownKey:'audit:cross',severity:'critical',headline:'Stop breach',evidence:{},crossing:{level:90,threshold:95,direction:'below',band:1}};
  const first=events.processHits('stop_breach',[hit],p,tick,now)[0];
  const next=events.processHits('stop_breach',[hit],p,tick,now+p.triggers.criticalCooldownMs+1)[0];
  assert.equal(next.id,first.id);assert.equal(next.wakeCount,2);assert.equal(events.getPendingEvents().length,1);
  events.processHits('stop_breach',[{...hit,crossing:{...hit.crossing,level:100}}],p,tick,now+p.triggers.criticalCooldownMs+2);
  assert.equal(events.getPendingEvents().some(e=>e.kind==='stop_breach'),false);
  events.resetEventRegistry(true);
  assert.equal(events.getPendingEvents().some(e=>e.kind==='stop_breach'),false);
});

test('revised action quantities conflict and identical request identities survive completion', () => {
  const common = { kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'audit', timeoutMs: 60000, automatic: true };
  const command = commands.enqueueRequest('trader', 'Exit one share', 'alice');
  agentContext.run({ role: 'trader', requestId: command.id, actorId: 'alice', toolCallId: 'attempt-one' }, () => {
    const first = actions.createAction({ ...common, params: { qty: 1 } });
    assert.throws(() => actions.createAction({ ...common, params: { qty: 10 } }), /Conflicting open action/);
    actions.transitionAction(first.id, 'executing'); actions.transitionAction(first.id, 'executed');
    assert.equal(actions.createAction({ ...common, params: { qty: 1 } }).id, first.id);
    assert.equal(commands.getRequest(command.id).actionIds.length, 1);
    assert.equal(first.requestedBy, 'alice');
  });
});

test('restart recovers an action receipt saved before its tool result without rerunning a handler', async () => {
  const command = commands.enqueueRequest('trader', 'Exit AAPL', 'alice');
  const context = { role: 'trader', requestId: command.id, actorId: 'alice', toolCallId: command.id + ':1:0' };
  agentContext.run(context, () => actions.createAction({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'audit', timeoutMs: 60000, params: { qty: 1 } }));
  storage.saveRecord('transcripts', command.id, { id: command.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Exit AAPL' }] }, { role: 'assistant', content: toolResponse([['write', {}]]).content }], rounds: 1, status: 'running', inTokens: 0, outTokens: 0, text: '' });
  let invoked = 0;
  const registry = new ToolRegistry([{ name: 'write', description: 'audit', input_schema: { type: 'object', properties: {}, required: [] } }], async () => { invoked++; return '{}'; });
  const turn = await runAgentLoop({ context, registry, provider: { chat: async request => {
    assert.match(request.messages.at(-1).content[0].content, /actionId/); return textResponse();
  } }, messages: async () => { throw new Error('Should resume'); }, systemPrompt: '', maxRounds: 3, maxTokens: 100 });
  assert.equal(invoked, 0); assert.equal(turn.status, 'completed');
});

test('canceled unfilled orders and unconfirmed protection are described without claiming execution', () => {
  const { describeDecision } = from('journal/types');
  const record = journal.recordDecision(journal.decision('entry', 'trader', { symbol: 'AAPL', rationale: 'Entry', orderStatus: 'cancelled', executed: false, requestedQty: 5, filledQty: 0, qty: 0, price: null }));
  assert.match(describeDecision(record), /cancelled; filled 0\/5/);
  assert.doesNotMatch(describeDecision(record), /@ \$/);
});

test('unconfirmed stop adjustments preserve the original entry thesis and journal the broker result', async () => {
  const stops = from('strategy/stopOrders'), realMove = stops.moveStopTo;
  stops.moveStopTo = async () => ({ ok: false, reason: 'Broker refused the adjustment' });
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 95, entryDecisionId: 'original-entry', openedAt: new Date().toISOString() });
  try {
    await traderTools.actAnnotation({ ok: true, symbol: 'AAPL', stopLoss: 96, takeProfit: null, thesis: 'Tighten protection', effectiveEntry: 100, heldQty: 5, snapEntryPriceMissing: false });
    const record = journal.readDecisions().at(-1), position = state.getPositionSnapshot('AAPL');
    assert.equal(position.entryDecisionId, 'original-entry');
    assert.equal(position.managementDecisionId, record.id);
    assert.equal(record.protectionStatus, 'unknown'); assert.equal(record.executed, false);
    assert.match(record.venueStopMissing, /Broker refused/);
  } finally { stops.moveStopTo = realMove; }
});

test('account comparisons with deposits or unverifiable cash flows withhold performance', async () => {
  const http = from('core/alpacaHttp').alpacaTrading, bars = from('collect/barSource');
  const realGet = http.get, realBars = bars.collectBars;
  let activities = [{ date: '2025-09-03', activity_type: 'CSD', net_amount: '100' }];
  http.get = async url => ({ data: url.includes('activities') ? activities : { timestamp: ['2025-09-02T12:00:00Z','2025-09-03T12:00:00Z'].map(d => Date.parse(d)/1000), equity: [100,200] } });
  bars.collectBars = async () => ({ value: [{ t: '2025-09-02T12:00:00Z', c: 100 }, { t: '2025-09-03T12:00:00Z', c: 100 }], source: 'audit', stale: false });
  try {
    for (activities of [[{ date: '2025-09-03' }], null]) {
      const result = JSON.parse(await chartTools.executeChartTool('show_performance_comparison', { a: 'ACCOUNT', b: 'SPY', days: 30 }));
      assert.equal(result.changePctA, null); assert.equal(result.excessPct, null);
    }
  } finally { http.get = realGet; bars.collectBars = realBars; }
});

test('lessons require evidence for model writes and can be retired without deleting history', () => {
  const evidence = journal.recordDecision(journal.decision('hold', 'trader', { rationale: 'Reviewed evidence' }));
  agentContext.run({ role: 'trader', requestId: 'lesson-command', actorId: 'alice', toolCallId: 'lesson-attempt' }, () => {
    assert.throws(() => lessons.recordLesson('Unsupported observation'), /source decision/);
    assert.throws(() => lessons.recordLesson('Unknown evidence', ['missing']), /existing decisions/);
    lessons.recordLesson('Supported observation', [evidence.id]);
    lessons.recordLesson('Supported observation', [evidence.id]);
  });
  assert.equal(lessons.listLessons().length, 1);
  const lesson = lessons.listLessons()[0];
  lessons.reviewLesson(lesson.id, 'Reviewed observation', false);
  assert.equal(lessons.readLessons().length, 0);
  assert.equal(lessons.listLessons()[0].text, 'Reviewed observation');
});

test('chat budget exhaustion preserves a separate allocation for trader work', async () => {
  const { withModelBudget } = from('core/modelBudget');
  const previous = process.env.AI_MAX_REQUESTS_PER_DAY; process.env.AI_MAX_REQUESTS_PER_DAY = '5';
  try {
    const provider = withModelBudget({ chat: async () => textResponse() });
    const params = { systemPrompt: '', messages: [], tools: [], maxTokens: 100 };
    await agentContext.run({ role: 'concierge', actorId: 'alice', requestId: 'budget' }, async () => {
      await provider.chat(params); await provider.chat(params);
      await assert.rejects(() => provider.chat(params), /reserved for the trader/);
    });
    await agentContext.run({ role: 'trader', actorId: 'system', requestId: 'budget-trader' }, () => provider.chat(params));
  } finally { if (previous === undefined) delete process.env.AI_MAX_REQUESTS_PER_DAY; else process.env.AI_MAX_REQUESTS_PER_DAY = previous; }
});

test('stopping a turn during an awaited tool prevents a later local mutation', async () => {
  const abort = new AbortController();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const registry = new ToolRegistry([{ name: 'write', description: 'audit', input_schema: { type: 'object', properties: {}, required: [] } }], async () => {
    entered(); await waiting;
    actions.createAction({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'audit', timeoutMs: 60000, params: { qty: 1 } });
    return '{}';
  });
  const work = runAgentLoop({ context: { role: 'trader', requestId: 'cancelled', actorId: 'alice' }, registry, provider: { chat: async () => toolResponse([['write', {}]]) },
    messages: async () => [], systemPrompt: '', maxRounds: 2, maxTokens: 100, signal: abort.signal });
  await began; abort.abort(); release();
  const result = await work;
  assert.equal(result.status, 'interrupted'); assert.equal(actions.getAllActions().length, 0);
});

test('restart honors saved truncation and terminal model responses', async () => {
  for (const reason of ['max_tokens','end_turn']) {
    const id = 'saved-' + reason;
    const content = reason === 'max_tokens' ? toolResponse([['write', {}]]).content : textResponse().content;
    storage.saveRecord('transcripts', id, { id, messages: [{ role: 'assistant', content }], rounds: 1, status: 'running', responseStopReason: reason, inTokens: 0, outTokens: 0, text: '' });
    const registry = new ToolRegistry([{ name: 'write', description: '', input_schema: { type: 'object', properties: {}, required: [] } }], async () => { throw new Error('Must not invoke a tool'); });
    const result = await runAgentLoop({ context: { role: 'trader', requestId: id, actorId: 'test' }, registry, provider: { chat: async () => { throw new Error('Must not call the model again'); } }, messages: async () => [], systemPrompt: '', maxRounds: 3, maxTokens: 100 });
    assert.equal(result.status, reason === 'max_tokens' ? 'failed' : 'completed');
    if (reason === 'end_turn') assert.equal(result.text, 'Done');
  }
});

test('legacy queued actions acquire a journal record before transitioning', () => {
  const p = actions.createAction({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'legacy', timeoutMs: 60000, params: { qty: 1 } });
  storage.deleteRecord('journal', 'action-' + p.id);
  actions.decideAction(p.id, 'approve', 'human', undefined, 'alice');
  assert.equal(journal.readDecision('action-' + p.id).orderStatus, 'approved');
});

test('only full broker coverage is reported as confirmed journal protection', async () => {
  const realOrders = broker.getOpenOrders, realPositions = broker.getPositions;
  const entry = journal.recordDecision(journal.decision('entry', 'trader', { symbol: 'AAPL', rationale: 'Entry', intendedStop: 95 }));
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 95, entryDecisionId: entry.id, stopOrderId: 'stop' });
  broker.getPositions = async () => [{ symbol: 'AAPL', qty: 5 }];
  let covered = 1;
  broker.getOpenOrders = async () => [{ id: 'stop', symbol: 'AAPL', side: 'sell', type: 'stop', stopPrice: 95, qty: covered, filled: 0 }];
  const { refreshJournalProtection } = from('journal/protection');
  try {
    await refreshJournalProtection(); assert.equal(journal.readDecision(entry.id).protectionStatus, 'unknown');
    covered = 5; await refreshJournalProtection(); assert.equal(journal.readDecision(entry.id).protectionStatus, 'confirmed');
    broker.getOpenOrders = async () => { throw new Error('Broker unavailable'); };
    await assert.rejects(() => refreshJournalProtection()); assert.equal(journal.readDecision(entry.id).protectionStatus, 'unknown');
  } finally { broker.getOpenOrders = realOrders; broker.getPositions = realPositions; }
});
