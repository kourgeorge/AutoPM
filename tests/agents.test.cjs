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
const actions = from('core/orders');
const journal = from('journal/journal');
const lessons = from('journal/lessons');
const events = from('features/eventBus');
const eventLog = from('features/alertLog');
const { ui } = from('ui/ui');
const { AssistantAgent } = from('agents/assistant');
const { Trader, buildCycleContext } = from('agents/trader');
const { Researcher, startResearch, researchStatus } = from('agents/researcher');
const { logger } = from('core/logger');
for (const name of ['info', 'warn', 'error', 'trade', 'tool']) logger[name] = () => {};
ui.reply = () => {};
ui.replyChart = () => {};
ui.setAssistantActivity = () => {};
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
const { runAgentLoop, compactMessages, readTrajectory } = from('agents/agentLoop');
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

test('assistant rejects undeclared mutations and malformed tool inputs', async () => {
  let handoffs = 0;
  const assistant = new AssistantAgent(() => { handoffs++; });
  for (const name of ['execute_exit','execute_entry','write_lesson','ack_event']) {
    const result = JSON.parse(await assistant.executeTool(name, { symbol: 'AAPL' }));
    assert.match(result.error, /not permitted/);
  }
  for (const input of [null, {}, { message: 42 }, { message: 'x', extra: true }]) {
    assert.equal(JSON.parse(await assistant.executeTool('send_to_trader', input)).ok, false);
  }
  assert.equal(handoffs, 0);
  assert.equal(lessons.readLessons().length, 0);
});

test('assistant settings reads are fresh, local and unaffected by conflicting playbook prose', async () => {
  let handoffs = 0;
  const assistant = new AssistantAgent(() => { handoffs++; });
  const before = policy.getPolicySnapshot();
  const original = JSON.parse(await assistant.executeTool('get_strategy_settings', {}));
  assert.equal(original.profile, 'Balanced');
  assert.equal(original.risk.riskPerTradePctOfEquity, 0.5);
  const next = structuredClone(before.policy);
  next.risk.riskPerTradePct = 0.35;
  next.automation.level.entry = 'auto';
  const changed = policy.saveStrategy(next, before.hash, before.playbook + '\nLegacy note: risk per trade is 9%.');
  const fresh = JSON.parse(await assistant.executeTool('get_strategy_settings', {}));
  assert.equal(fresh.profile, 'Custom');
  assert.equal(fresh.risk.riskPerTradePctOfEquity, 0.35);
  assert.equal(fresh.strategyHash, changed.hash);
  assert.equal(fresh.automation.entries, 'Automatic approval');
  assert.doesNotMatch(fresh.summary, /9%/);
  assert.equal(policy.getPolicyHash(), changed.hash);
  assert.equal(handoffs, 0);
  assert.equal(JSON.parse(await assistant.executeTool('get_strategy_settings', { activate: true })).ok, false);
});

test('assistant saves requested settings changes and refuses invalid ones', async () => {
  const assistant = new AssistantAgent(() => assert.fail('Settings changes must not wake the trader'));
  const before = policy.getPolicySnapshot();
  const values = { riskPerTradePct: 0.75, targetVolatilityPct: 20, minRewardRisk: 2.5, maxSectorWeightPct: 20 };
  const result = JSON.parse(await assistant.executeTool('update_trading_settings', values));
  assert.equal(result.ok, true);
  assert.ok(result.applied.some(line => /riskPerTradePct: 0\.5 → 0\.75/.test(line)));
  assert.equal(result.saved.risk.riskPerTradePctOfEquity, 0.75);
  assert.notEqual(policy.getPolicyHash(), before.hash);
  const fresh = JSON.parse(await assistant.executeTool('get_strategy_settings', {}));
  assert.equal(fresh.risk.riskPerTradePctOfEquity, 0.75);
  assert.equal(fresh.risk.annualizedPortfolioVolatilityTargetPct, 20);
  assert.deepEqual(policy.getPolicy().automation, before.policy.automation);
  const hash = policy.getPolicyHash();
  assert.equal(JSON.parse(await assistant.executeTool('update_trading_settings', { riskPerTradePct: 50 })).ok, false);
  assert.equal(policy.getPolicyHash(), hash);
  assert.equal(commands.pendingRequests('trader').length, 0);
  policy.saveStrategy(before.policy, hash, before.playbook);
});

test('a settings explanation reaches the account conversation without a trader handoff', async () => {
  const assistant = new AssistantAgent(() => assert.fail('No trader action was requested'));
  let rounds = 0;
  assistant.provider = { chat: async request => {
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
  const receipt = assistant.handleMessage('Explain my strategy settings clearly', 'alice');
  await assistant.active;
  const command = commands.getRequest(receipt.id);
  assert.equal(command.status, 'completed');
  assert.match(command.result, /Saved strategy: Balanced/);
  assert.match(command.result, /0.5% of equity at the planned stop/);
  assert.match(command.result, /Human approval|human approval/);
  assert.ok(storage.readActivity(0, 100).some(entry => entry.kind === 'reply' && entry.source === 'assistant' && entry.text.includes(command.result)));
  commands.updateRequest(commands.enqueueRequest('trader', 'Review', 'system').id, { status: 'completed', result: 'Review completed; no trade action was queued.' });
  assert.ok(!storage.readActivity(0, 1000).some(entry => entry.kind === 'reply' && /no trade action/.test(entry.text)), 'trader results are not chat replies');
  assert.ok(storage.readActivity(0, 1000).some(entry => entry.kind === 'log' && entry.source === 'trader' && /no trade action/.test(entry.text)));
  assert.equal(policy.getPolicyHash(), hash);
  assert.equal(commands.pendingRequests('trader').length, 0);
});

test('a failed chart returns a paired error and the assistant can answer the next message', async () => {
  let rounds = 0;
  const trader = new Trader();
  const assistant = new AssistantAgent(message => trader.wake(message));
  const realChart = chartTools.executeChartTool;
  chartTools.executeChartTool = async () => { throw new Error('Chart unavailable'); };
  assistant.provider = { chat: async request => {
    if (rounds++ === 0) return toolResponse([['send_to_trader', { message: 'Review AAPL' }], ['show_price_history', { symbol: 'AAPL' }]]);
    const assistant = request.messages.find(m => m.role === 'assistant');
    assert.equal(assistant.content.filter(b => b.type === 'tool_use').length, 2);
    const results = request.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
    assert.equal(results.length, 2); assert.match(results[1].content, /Chart unavailable/);
    return textResponse();
  } };
  try {
    const first = assistant.handleMessage('Review AAPL and chart it', 'alice');
    await assistant.active;
    assert.equal(commands.getRequest(first.id).status, 'completed');
    assert.equal(commands.pendingRequests('trader')[0].actorId, 'alice');
    const second = assistant.handleMessage('What happened?', 'bob');
    await assistant.active;
    assert.equal(commands.getRequest(second.id).status, 'completed');
    // The second chat continues from the first chat's saved turn.
    const firstTurn = storage.readRecord('trajectories', first.id).messages, secondTurn = storage.readRecord('trajectories', second.id).messages;
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
  assert.equal(storage.readRecord('trajectories', command.id).status, 'failed');
});

test('sleep rejects later calls and truncated model output executes no tools', async () => {
  const trader = new Trader();
  trader.provider = { chat: async () => toolResponse([['sleep', { reason: 'Finished' }], ['write_lesson', { lesson: 'Do not save', evidenceIds: [] }]]) };
  const receipt = trader.wake('Review');
  await trader.runCycle();
  assert.equal(lessons.readLessons().length, 0);
  const request = storage.readRecord('requests', receipt.requestId);
  assert.deepEqual(request.wokenBy, ['startup', 'message'], 'the cycle records what woke it');
  assert.ok(Array.isArray(request.eventIds), 'and which events it was shown');
  assert.equal(storage.readRecord('tool-calls', `${receipt.requestId}:1:0`).kind, 'housekeeping', 'each tool call records its kind');
  const stored = storage.readRecord('trajectories', receipt.requestId);
  assert.match(stored.messages.at(-1).content[1].content, /^\[Saved as receipt /, 'the saved trajectory keeps the receipt id, not a copy of the result');
  const turn = readTrajectory(receipt.requestId);
  assert.match(turn.messages.at(-1).content[1].content, /not executed/);
  let executed = 0;
  const registry = new ToolRegistry([{ name: 'write', description: 'test', input_schema: { type: 'object', properties: {}, required: [] } }], async () => { executed++; return '{}'; });
  const result = await runAgentLoop({ context: { requestId: 'truncated', actorId: 'test', role: 'trader' }, registry,
    provider: { chat: async () => ({ ...toolResponse([['write', {}]]), stopReason: 'max_tokens' }) },
    systemPrompt: '', messages: async () => [], maxTokens: 100 });
  assert.equal(result.status, 'failed'); assert.equal(executed, 0);
});
test('full tool receipts survive reload while model context stays bounded', async () => {
  const output = JSON.stringify({ observations: 'long observation '.repeat(1500), end: 'complete' });
  let executions = 0, modelCalls = 0;
  const registry = new ToolRegistry([{ name: 'read', description: 'audit', input_schema: { type: 'object', properties: {}, required: [] } }], async () => { executions++;return output; });
  const run = await runAgentLoop({ context: { requestId: 'full-receipt', actorId: 'test', role: 'assistant' }, registry,
    provider: { chat: async request => {
      if (modelCalls++ === 0) return toolResponse([['read', {}]]);
      const receipt = request.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
      assert.equal(JSON.parse(receipt.content).truncated, true);
      return textResponse();
    } }, messages: async () => [], systemPrompt: '', maxTokens: 100 });
  assert.equal(run.status, 'completed');assert.equal(executions, 1);
  storage.closeStorage();
  const receipt = storage.readRecord('tool-calls', 'full-receipt:1:0');
  assert.equal(receipt.result, output);assert.ok(receipt.startedAt);assert.ok(receipt.finishedAt);
});

test('critical observation remains open and acting requires a linked action', async () => {
  const p = policy.getPolicy(), tick = { cooldowns: {}, armed: new Set(), dirty: false };
  const hit = { symbol: 'AAPL', cooldownKey: 'audit:stop', severity: 'critical', headline: 'Below stop', evidence: {}, crossing: { level: 90, threshold: 95, direction: 'below', band: 1 } };
  const [event] = events.processHits('stop_breach', [hit], p, tick);
  const bad = JSON.parse(await traderTools.executeTraderTool('ack_event', { id: event.id, disposition: 'acting' }));
  assert.match(bad.error, /orderId/);
  events.ackEvent(event.id, 'acknowledged', 'Observed');
  assert.equal(events.getPendingEvents().length, 1);
  const action = actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'Below stop', params: { qty: 2 }, eventId: event.id, automatic: true, timeoutMs: 60000 });
  events.ackEvent(event.id, 'acting', 'Exit queued', action.id);
  assert.equal(events.getPendingEvents()[0].handling, 'order_pending');
  actions.transitionOrder(action.id, 'failed', { result: { error: 'Cannot execute' } });
  assert.equal(events.getPendingEvents()[0].handling, 'observed');
  assert.equal(events.getPendingEvents()[0].ackedAt, null);
  assert.equal(storage.readRecords('alerts').find(e => e.id === event.id).handling, 'observed', 'event.jsonl records the handling');
});

test('a finished child request is an event for a trader parent and a chat reply for an assistant parent', () => {
  const { publishRequestFinished } = from('features/requestFinished');
  const stop = commands.onRequestFinished(publishRequestFinished);
  try {
    const cycle = commands.enqueueRequest('trader', 'Review', 'system');
    const research = agentContext.run({ role: 'trader', requestId: cycle.id, actorId: 'system', toolCallId: 'ask-research' }, () => startResearch('PLTR', 'system'));
    assert.equal(research.parentId, cycle.id);
    commands.updateRequest(research.id, { status: 'completed', result: 'Wait: no entry yet.' });
    const event = events.getPendingEvents().find(e => e.kind === 'request_finished');
    assert.equal(event?.severity, 'urgent'); assert.equal(event?.evidence.requestId, research.id);
    commands.updateRequest(research.id, { status: 'completed', result: 'Wait: no entry yet.' });
    assert.equal(events.getPendingEvents().filter(e => e.kind === 'request_finished').length, 1, 'announced once');
    const chat = commands.enqueueRequest('assistant', 'Tell the trader to review AAPL');
    const sent = agentContext.run({ role: 'assistant', requestId: chat.id, actorId: 'alice', toolCallId: 'relay' }, () => commands.enqueueRequest('trader', 'Review AAPL'));
    commands.updateRequest(sent.id, { status: 'completed', result: 'Reviewed AAPL; holding.' });
    assert.ok(storage.readActivity(0, 1000).some(e => e.kind === 'reply' && e.text === 'The trader request you sent finished: Reviewed AAPL; holding.'));
  } finally { stop(); }
});

test('a repeated request reuses its action, and each status change adds a step to the action history', () => {
  const context = { role: 'trader', requestId: 'dedup-request', actorId: 'alice' };
  const make = () => agentContext.run(context, () => actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'audit', timeoutMs: 60000, params: { qty: 1 } }));
  const first = make();
  actions.decideOrder(first.id, 'reject', 'human', 'Not now', 'alice');
  const again = make();
  assert.equal(again.id, first.id, 'the same request and intent resolve to the same action, even once it is closed');
  const saved = actions.getOrder(first.id);
  assert.equal(saved.dedupKeys.length, 1);
  assert.deepEqual(saved.history.map(s => s.transition), ['created', 'rejected']);
  assert.equal(saved.history[1].rejectReason, 'Not now');
});

test('an answered event is journalled as skip for a stock you do not hold; for a held stock the note stays on the alert', async () => {
  const p = policy.getPolicy(), tick = { cooldowns: {}, armed: new Set(), dirty: false };
  const hit = symbol => ({ symbol, cooldownKey: 'kind:' + symbol, severity: 'urgent', headline: 'Review ' + symbol, evidence: {}, crossing: { level: 90, threshold: 95, direction: 'below', band: 1 } });
  const [held, notHeld] = events.processHits('ema_cross_down', [hit('AAPL'), hit('LLY')], p, tick);
  state.updateState({ positionSnapshots: { AAPL: { symbol: 'AAPL', entryDecisionId: 'entry-1' } } });
  for (const e of [held, notHeld]) assert.equal(JSON.parse(await traderTools.executeTraderTool('ack_event', { id: e.id, disposition: 'acknowledged', note: 'Reviewed; no action needed' })).ok, true);
  const kindFor = id => journal.readDecisions().find(d => d.triggerEventId === id)?.kind;
  assert.equal(kindFor(held.id), undefined);
  assert.equal(eventLog.readAlertLog().find(e => e.id === held.id)?.ackNote, 'Reviewed; no action needed');
  assert.equal(kindFor(notHeld.id), 'skip');
});

test('an observed urgent event closes for a stock you do not hold, stays open for one you do, and journals once', async () => {
  const p = policy.getPolicy(), tick = { cooldowns: {}, armed: new Set(), dirty: false };
  const hit = (symbol, severity = 'urgent') => ({ symbol, cooldownKey: 'kind:' + symbol, severity, headline: 'Review ' + symbol, evidence: {}, crossing: { level: 90, threshold: 95, direction: 'below', band: 1 } });
  const [held, notHeld, critical] = events.processHits('ema_cross_down', [hit('AAPL'), hit('KO'), hit('LLY', 'critical')], p, tick);
  state.updateState({ positionSnapshots: { AAPL: { symbol: 'AAPL', entryDecisionId: 'entry-1' } } });
  const ack = id => traderTools.executeTraderTool('ack_event', { id, disposition: 'acknowledged', note: 'Reviewed; no entry' }).then(JSON.parse);
  for (const e of [held, notHeld, critical]) assert.equal((await ack(e.id)).ok, true);
  const open = () => events.getPendingEvents().map(e => e.id);
  assert.ok(open().includes(held.id), 'a held position keeps re-waking until it is dealt with');
  assert.ok(!open().includes(notHeld.id), 'nothing left to do on a stock you do not hold');
  assert.ok(open().includes(critical.id), 'critical events keep escalating');
  // Answering the still-open critical event again is not a new decision.
  assert.equal((await ack(critical.id)).ok, true);
  assert.equal(journal.readDecisions().filter(d => d.triggerEventId === critical.id).length, 1);
});

// Runs `fn` the way the agent loop runs a tool: inside its context, then merging the receipt fields.
function asTool(role, requestId, toolCallId, name, input, fn) {
  const save = result => {
    storage.saveRecord('tool-calls', toolCallId, { ...storage.readRecord('tool-calls', toolCallId), role, requestId, name, input,
      result: typeof result === 'string' ? result : JSON.stringify(result), startedAt: new Date().toISOString() });
    return result;
  };
  const result = agentContext.run({ role, requestId, actorId: 'system', toolCallId }, fn);
  return result instanceof Promise ? result.then(save) : save(result);
}
const savePlan = (id, requestId, symbol, allowed, rewardRisk, violations = [], role = 'trader', levels = { stopLoss: 516, takeProfit: 600 }) => storage.saveRecord('tool-calls', id, {
  name: 'get_entry_plan', role, requestId, kind: 'read', input: { symbol }, startedAt: new Date().toISOString(),
  result: JSON.stringify({ symbol, policyHash: policy.getPolicyHash(), allowed, maxQty: allowed ? 18 : 0, rewardRisk, violations, evidenceId: id,
    proposedLevels: { referencePrice: 541.15, ...levels } }) });

test('sleep is refused once while a plan or comparison has no decision; the cycle end journals what is still open', async () => {
  const rd = from('journal/reviewDecisions'), req = 'req-open';
  savePlan('plan-msft-1', req, 'MSFT', false, 1.91, [{ rule: 'reward_risk_too_low' }]);
  savePlan('plan-msft-2', req, 'MSFT', true, 2.21);
  savePlan('plan-crm', req, 'CRM', false, 1.92, [{ rule: 'reward_risk_too_low' }]);
  savePlan('plan-v', req, 'V', true, 2.05);
  savePlan('plan-pg', req, 'PG', true, 2.1, [], 'researcher');
  storage.saveRecord('tool-calls', 'cmp-aapl', { name: 'compare_position_actions', role: 'trader', requestId: req, input: { symbol: 'AAPL' }, result: '{}' });
  agentContext.run({ role: 'trader', requestId: req, actorId: 'system' }, () =>
    journal.recordDecision(journal.decision('entry', 'trader', { symbol: 'V', rationale: 'Entered' })));
  const sleep = () => asTool('trader', req, 'sleep-' + Math.random(), 'sleep', { reason: 'done' }, () => traderTools.executeTraderTool('sleep', { reason: 'done' }));
  const first = JSON.parse(await sleep());
  assert.equal(first.ok, false);
  assert.deepEqual(first.open.map(o => o.symbol).sort(), ['AAPL', 'CRM', 'MSFT'], 'entered V and researcher-only PG are not open');
  assert.equal(JSON.parse(await sleep()).ok, true, 'a second sleep always ends the cycle');
  assert.equal(rd.journalUnresolved(req), 3);
  const rows = journal.readDecisions({ filter: d => d.requestId === req && d.kind !== 'entry' });
  const msft = rows.find(d => d.symbol === 'MSFT');
  assert.equal(msft.kind, 'skip');
  assert.deepEqual(msft.entryPlan, { evidenceId: 'plan-msft-2', allowed: true, maxQty: 18, rewardRisk: 2.21, refusals: [] }, 'the last plan wins');
  assert.match(msft.rationale, /no reason recorded: you ran an entry plan.*allowed, up to 18 shares, reward:risk 2\.21/);
  assert.deepEqual(rows.find(d => d.symbol === 'CRM').entryPlan.refusals, ['reward_risk_too_low']);
  assert.equal(rows.find(d => d.symbol === 'AAPL').kind, 'hold');
  assert.equal(rd.journalUnresolved(req), 0, 'running it again writes nothing new');
});

test("a trader's candidate wait is a skip with its plan, written once per change; a researcher's is advice", () => {
  const { saveCandidateReview } = from('review/decisionFollowup'), rd = from('journal/reviewDecisions');
  const review = (role, n, reason, decision = 'wait', rewardRisk = 1.91, levels) => {
    const req = 'req-cand-' + role, at = new Date().toISOString();
    storage.saveRecord('tool-calls', `snap-${role}-${n}`, { name: 'get_position_review', kind: 'read', input: { symbol: 'MSFT' }, finishedAt: at,
      result: JSON.stringify({ evidenceId: `snap-${role}-${n}`, symbol: 'MSFT', positionKnown: true, holding: null, policyHash: policy.getPolicyHash(), forward: { price: 541.15 } }) });
    savePlan(`plan-${role}-${n}`, req, 'MSFT', false, rewardRisk, [{ rule: 'reward_risk_too_low' }], role, levels);
    return asTool(role, req, `cand-${role}-${n}`, 'record_candidate_review', { symbol: 'MSFT' }, () =>
      saveCandidateReview('MSFT', decision, reason, [`snap-${role}-${n}`, `plan-${role}-${n}`], `snap-${role}-${n}`, { entryPlanId: `plan-${role}-${n}` }));
  };
  review('researcher', 1, 'Plan is 1.91:1, below the 2:1 minimum; wait.');
  review('trader', 1, 'Plan is 1.91:1, below the 2:1 minimum; wait for a pullback.');
  review('trader', 2, 'Still 1.91:1 and still extended; keep waiting for a pullback.');
  const rows = journal.readDecisions({ symbol: 'MSFT' });
  assert.equal(rows.length, 1, 'researcher advice and an unchanged restatement write nothing');
  assert.equal(rows[0].kind, 'skip'); assert.equal(rows[0].reviewDecision, 'wait');
  assert.match(rows[0].rationale, /^wait: Plan is 1\.91:1/);
  assert.equal(rows[0].entryPlan.rewardRisk, 1.91); assert.equal(rows[0].intendedTarget, 600);
  assert.deepEqual(rd.unresolvedDecisions('req-cand-trader'), [], 'a recorded review closes the plan');
  review('trader', 4, 'Re-ran the plan; same wait.', 'wait', 1.9102, { stopLoss: 516.05, takeProfit: 600.04 });
  assert.equal(journal.readDecisions({ symbol: 'MSFT' }).length, 1, 'levels a few cents off are the same decision');
  review('trader', 5, 'Stop is now far lower; still waiting.', 'wait', 1.6, { stopLoss: 500, takeProfit: 600 });
  assert.equal(journal.readDecisions({ symbol: 'MSFT' }).length, 2, 'a real move in the plan is a new row');
  review('trader', 3, 'Pullback arrived; the setup now supports a buy at these levels.', 'skip');
  assert.equal(journal.readDecisions({ symbol: 'MSFT' }).length, 3, 'a changed decision is a new row');
});

test('a kept holding is a hold row when the decision changes; an exit review holds the cycle until the order is sent', () => {
  const rd = from('journal/reviewDecisions'), { savePositionReview } = from('journal/thesis'), req = 'req-hold';
  state.updateState({ positionSnapshots: { AAPL: { symbol: 'AAPL', entryDecisionId: 'entry-1' } } });
  const review = (n, decision, changedEvidence) => {
    storage.saveRecord('tool-calls', 'psnap-' + n, { name: 'get_position_review', kind: 'read', input: { symbol: 'AAPL' }, finishedAt: new Date().toISOString(),
      result: JSON.stringify({ evidenceId: 'psnap-' + n, symbol: 'AAPL', positionKnown: true, managed: true, entryDecisionId: 'entry-1', holding: { qty: 5 }, policyHash: policy.getPolicyHash() }) });
    return asTool('trader', req, 'prev-' + n, 'record_position_review', { symbol: 'AAPL' }, () => savePositionReview({ symbol: 'AAPL', decision, changedEvidence,
      evidenceIds: ['psnap-' + n], snapshotId: 'psnap-' + n, unknowns: [], price: 100, contextVariant: 'decision-context-v1', policyHash: policy.getPolicyHash(), holdingHorizonDays: null }));
  };
  review(1, 'keep', 'Trend intact above the 50-day average; stop unchanged.');
  review(2, 'keep', 'Trend still intact; nothing material changed since the last review.');
  const holds = journal.readDecisions({ symbol: 'AAPL' });
  assert.equal(holds.length, 1); assert.equal(holds[0].kind, 'hold'); assert.equal(holds[0].reviewDecision, 'keep');
  assert.equal(from('journal/types').isTradeAction(holds[0]), false, 'a review hold is not a stop change');
  assert.deepEqual(rd.unresolvedDecisions(req), []);
  review(3, 'exit', 'Close broke below the 50-day average on heavy volume; thesis is done.');
  assert.equal(journal.readDecisions({ symbol: 'AAPL' }).length, 1, 'the exit order journals itself, not the review');
  assert.match(rd.unresolvedDecisions(req)[0].problem, /review says exit, but no exit order was sent/);
  agentContext.run({ role: 'trader', requestId: req, actorId: 'system' }, () =>
    journal.recordDecision(journal.decision('exit', 'trader', { symbol: 'AAPL', rationale: 'Thesis broken' })));
  assert.deepEqual(rd.unresolvedDecisions(req), []);
});

test('a tick with unreadable equity reports the invested share as unknown, not 0%', () => {
  const { computeTick } = from('features/compute'), { missing } = from('collect/types');
  const at = new Date().toISOString(), ok = value => ({ value, source: 'alpaca', fetchedAt: at, asOf: at });
  const raw = equity => ({ collectedAt: at,
    positions: ok([{ symbol: 'AAPL', qty: 10, avgEntryPrice: 100, marketValue: 1000, currentPrice: 100 }]),
    account: equity == null ? missing('alpaca', 'account endpoint 503') : ok({ equity, cash: equity - 1000, buyingPower: equity }),
    openOrders: ok([]), prices: new Map([['AAPL', ok(100)]]), bars: new Map() });
  const p = policy.getPolicy();
  assert.equal(computeTick(raw(null), p).portfolio.grossDeployedPct, null);
  assert.equal(computeTick(raw(10000), p).portfolio.grossDeployedPct, 10);
});

test('below the investment target, fitting scan candidates need a decision and the flat heartbeat speeds up', async () => {
  const rd = from('journal/reviewDecisions'), lastTick = from('features/lastTick'), { heartbeatDetector } = from('features/detectors/heartbeat');
  const base = policy.getPolicy();
  policy.useEphemeralPolicy({ ...base, risk: { ...base.risk, targetInvestedPct: 80, minInvestedPct: 60 } });
  const tick = (session, grossDeployedPct) => ({ session, portfolio: { grossDeployedPct }, account: { positionCount: 0, dayPnLPct: 0, equity: 100000 }, positions: {}, watchlist: {}, tickAt: new Date().toISOString(), policyVersion: 1 });
  try {
    const p = policy.getPolicy();
    const [flatUnder] = heartbeatDetector.evaluate(tick('open', 0), p);
    assert.equal(flatUnder.cooldownMs, p.triggers.heartbeatWithPositionsMs);
    assert.match(flatUnder.headline, /UNDER-INVESTED: 0\.0% invested, target 80%, floor 60%/);
    assert.equal(heartbeatDetector.evaluate(tick('open', 85), p)[0].cooldownMs, p.triggers.heartbeatFlatMs, 'at target, flat stays hourly');
    assert.equal(heartbeatDetector.evaluate(tick('closed', 0), p)[0].cooldownMs, p.triggers.heartbeatFlatMs, 'closed, nothing to buy');
    // Unreadable equity is an unknown invested share, not 0%: it must not demand buys.
    const blind = heartbeatDetector.evaluate(tick('open', null), p)[0];
    assert.equal(blind.cooldownMs, p.triggers.heartbeatFlatMs);
    assert.doesNotMatch(blind.headline, /UNDER-INVESTED|below target/);
    lastTick.recordTick(tick('open', null));
    assert.deepEqual(rd.unresolvedDecisions('req-blind'), [], 'equity unknown: no floor complaint');

    const req = 'req-scan';
    const rowsOf = list => list.map(([symbol, score, maxQty]) => ({ symbol, price: 100, priceStale: false, composite: score, riskAdjustedScore: score, riskFit: { allowed: score != null, maxQty } }));
    storage.saveRecord('tool-calls', 'scan-1', { name: 'get_watchlist_scan', role: 'trader', requestId: req, input: {},
      result: JSON.stringify({ rows: rowsOf([['MA', 0.74, 16], ['LLY', 0.67, 7], ['XOM', null, 0]]) }) });
    storage.saveRecord('tool-calls', 'scan-2', { name: 'get_watchlist_scan', role: 'trader', requestId: req, input: { offset: 3 },
      result: JSON.stringify({ rows: rowsOf([['V', 0.64, 24], ['WMT', 0.47, 30]]) }) });
    lastTick.recordTick(tick('closed', 0));
    assert.deepEqual(rd.unresolvedDecisions(req), [], 'market closed: no entry is possible, so nothing is owed');
    lastTick.recordTick(tick('open', 85));
    assert.deepEqual(rd.unresolvedDecisions(req), [], 'at target: cash is allowed');
    lastTick.recordTick(tick('open', 0));
    const open = rd.unresolvedDecisions(req);
    assert.deepEqual(open.map(o => o.symbol), ['MA', 'LLY', 'V'], 'the three best fitting candidates, across pages; unscored XOM is not one');
    assert.match(open[0].problem, /fitting the risk budget \(composite 0\.74, up to 16 shares\)/);
    agentContext.run({ role: 'trader', requestId: req, actorId: 'system' }, () =>
      journal.recordDecision(journal.decision('veto', 'guard', { symbol: 'MA', rationale: 'earnings_window', vetoRule: 'earnings_window' })));
    assert.deepEqual(rd.unresolvedDecisions(req).map(o => o.symbol), ['LLY', 'V'], 'an attempted entry is a decision');
    assert.equal(rd.journalUnresolved(req), 2);
    assert.equal(journal.readDecisions({ symbol: 'V' })[0].intendedPrice, 100);

    // Sending a name to the research worker is the decision on it for this cycle; a failed request is not.
    storage.saveRecord('tool-calls', 'rr-lly', { name: 'request_research', role: 'trader', requestId: req, input: { symbol: 'LLY' }, result: JSON.stringify({ ok: true, requestId: 'r1' }) });
    storage.saveRecord('tool-calls', 'rr-v', { name: 'request_research', role: 'trader', requestId: req, input: { symbol: 'V' }, result: JSON.stringify({ error: 'queue full' }) });
    storage.saveRecord('tool-calls', 'plan-cost', { name: 'get_entry_plan', role: 'trader', requestId: req, input: { symbol: 'COST' }, result: JSON.stringify({ symbol: 'COST', allowed: true, maxQty: 3 }) });
    storage.saveRecord('tool-calls', 'rr-cost', { name: 'request_research', role: 'trader', requestId: req, input: { symbol: 'COST' }, result: JSON.stringify({ ok: true, requestId: 'r2' }) });
    storage.saveRecord('tool-calls', 'scan-3', { name: 'get_watchlist_scan', role: 'trader', requestId: 'req-scan-2', input: {},
      result: JSON.stringify({ rows: rowsOf([['KO', 0.5, 9], ['PG', 0.4, 9]]) }) });
    storage.saveRecord('tool-calls', 'rr-ko', { name: 'request_research', role: 'trader', requestId: 'req-scan-2', input: { symbol: 'KO' }, result: JSON.stringify({ ok: true, requestId: 'r3' }) });
    storage.saveRecord('tool-calls', 'rr-pg', { name: 'request_research', role: 'trader', requestId: 'req-scan-2', input: { symbol: 'PG' }, result: JSON.stringify({ error: 'failed' }) });
    assert.deepEqual(rd.unresolvedDecisions('req-scan-2').map(o => o.symbol), ['PG'], 'researched KO is decided; PG, whose request failed, is not');
    assert.ok(!rd.unresolvedDecisions(req).some(o => o.symbol === 'COST'), 'an entry plan followed by a research request is decided too');

    assert.match(rd.unresolvedDecisions('req-no-scan')[0].problem, /under-invested.*did not scan the watchlist/);
    assert.equal(rd.unresolvedDecisions('req-no-scan')[0].symbol, null);
  } finally { lastTick.resetLastTick(); policy.loadPolicy(); }
});

test('get_pending_events groups all-clears to their ids and still serves them in full by kind', async () => {
  events.resetEventRegistry();
  const p = policy.getPolicy();
  const clear = symbol => events.publishDiscrete('condition_resolved', { symbol, cooldownKey: 'resolved:data_stale:' + symbol, severity: 'info', headline: symbol + ' data_stale cleared', evidence: { resolvedKind: 'data_stale' } }, p);
  const cleared = [clear('AAPL'), clear('MSFT')];
  const incident = events.publishDiscrete('review_ready', { symbol: 'LLY', cooldownKey: 'audit:review', severity: 'warn', headline: 'Review LLY', evidence: {} }, p);
  const grouped = JSON.parse(await traderTools.executeTraderTool('get_pending_events', {}));
  assert.deepEqual(grouped.events.map(e => e.id), [incident.id]);
  assert.deepEqual(grouped.allClears.data_stale, cleared.map(e => e.id));
  const full = JSON.parse(await traderTools.executeTraderTool('get_pending_events', { kind: 'condition_resolved' }));
  assert.deepEqual(full.events.map(e => e.headline), ['AAPL data_stale cleared', 'MSFT data_stale cleared']);
  events.resetEventRegistry();
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
    const first = actions.createOrder({ ...common, params: { qty: 1 } });
    assert.throws(() => actions.createOrder({ ...common, params: { qty: 10 } }), /Conflicting open action/);
    actions.transitionOrder(first.id, 'executing'); actions.transitionOrder(first.id, 'executed');
    assert.equal(actions.createOrder({ ...common, params: { qty: 1 } }).id, first.id);
    assert.equal(commands.getRequest(command.id).orderIds.length, 1);
    assert.equal(first.requestedBy, 'alice');
  });
});

test('restart recovers an action receipt saved before its tool result without rerunning a handler', async () => {
  const command = commands.enqueueRequest('trader', 'Exit AAPL', 'alice');
  const context = { role: 'trader', requestId: command.id, actorId: 'alice', toolCallId: command.id + ':1:0' };
  agentContext.run(context, () => actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'audit', timeoutMs: 60000, params: { qty: 1 } }));
  storage.saveRecord('trajectories', command.id, { id: command.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Exit AAPL' }] }, { role: 'assistant', content: toolResponse([['write', {}]]).content }], rounds: 1, status: 'running', inTokens: 0, outTokens: 0, text: '' });
  let invoked = 0;
  const registry = new ToolRegistry([{ name: 'write', description: 'audit', input_schema: { type: 'object', properties: {}, required: [] } }], async () => { invoked++; return '{}'; });
  const turn = await runAgentLoop({ context, registry, provider: { chat: async request => {
    assert.match(request.messages.at(-1).content[0].content, /orderId/); return textResponse();
  } }, messages: async () => { throw new Error('Should resume'); }, systemPrompt: '', maxTokens: 100 });
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

test('research runs while trading is paused, without order or sleep tools, and reuses a pending request', async () => {
  state.updateState({ paused: true });
  const first = startResearch('brk.b', 'alice');
  assert.equal(first.symbol, 'BRK.B'); assert.match(first.text, /^Research BRK\.B /);
  assert.equal(startResearch('BRK.B', 'bob').id, first.id);
  assert.equal(startResearch('BRKB', 'bob').id, first.id, 'the same stock spelled canonically is the same request');
  assert.throws(() => startResearch('not a ticker'), /valid ticker/);
  const researcher = new Researcher();
  let rounds = 0;
  researcher.provider = { chat: async request => {
    const names = request.tools.map(t => t.name);
    for (const name of ['execute_entry', 'execute_exit', 'annotate_position', 'ack_event', 'write_lesson', 'sleep', 'request_research', 'send_to_trader'])
      assert.ok(!names.includes(name), name + ' must not be a research tool');
    for (const name of ['get_position_review', 'read_source', 'record_candidate_review', 'record_position_review', 'get_tool_result', 'get_saved_context'])
      assert.ok(names.includes(name), name + ' is a research tool');
    assert.match(request.systemPrompt, /ACCOUNT STRATEGY/); assert.match(request.systemPrompt, /STOCK RESEARCH TASK/);
    if (rounds++ === 0) return toolResponse([['sleep', { reason: 'Market closed' }], ['get_lessons', {}]]);
    const results = request.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
    assert.match(results[0].content, /not permitted/);
    assert.doesNotMatch(results[1].content, /paused/i);
    return { ...textResponse(), content: [{ type: 'text', text: 'BRK.B: wait for trend repair.' }] };
  } };
  researcher.start();
  await researcher.active;
  await researcher.stop();
  const done = commands.getRequest(first.id);
  assert.equal(done.role, 'researcher'); assert.equal(done.status, 'completed'); assert.equal(done.actorId, 'alice');
  assert.equal(done.result, 'BRK.B: wait for trend repair.');
  const activity = storage.readActivity(0, 1000);
  assert.ok(activity.some(e => e.kind === 'log' && e.source === 'researcher' && e.text === '[Research] BRK.B: wait for trend repair.'));
  assert.ok(!activity.some(e => e.kind === 'reply'), 'research from the dashboard is not a chat reply');
  assert.equal(researchStatus().queued, 0);
  assert.equal(storage.listRecords('orders').length, 0);
});

test('research asked for in chat posts its summary to the chat when it finishes', async () => {
  const dashboard = startResearch('MSFT', 'operator');
  const assistant = new AssistantAgent(() => assert.fail('Research is not relayed to the trader'));
  let rounds = 0;
  assistant.provider = { chat: async request => {
    assert.match(request.systemPrompt, /call request_research; do not relay research to the trader/);
    if (rounds++ === 0) return toolResponse([['request_research', { symbol: 'msft' }]]);
    const result = JSON.parse(request.messages.flatMap(m => m.content).find(b => b.type === 'tool_result').content);
    assert.equal(result.requestId, dashboard.id, 'a stock already queued is not researched twice');
    return { ...textResponse(), content: [{ type: 'text', text: 'Research on MSFT has started.' }] };
  } };
  const chat = assistant.handleMessage('Research MSFT for me', 'alice');
  await assistant.active;
  assert.equal(commands.getRequest(chat.id).status, 'completed');
  assert.equal(commands.getRequest(dashboard.id).replyToChat, true);
  const researcher = new Researcher();
  researcher.provider = { chat: async () => ({ ...textResponse(), content: [{ type: 'text', text: 'Skip: no catalyst.' }] }) };
  researcher.start();
  await researcher.active;
  await researcher.stop();
  assert.ok(storage.readActivity(0, 1000).some(e => e.kind === 'reply' && e.source === 'researcher' && e.text === 'Research on MSFT finished: Skip: no catalyst.'));
  const chatResearch = startResearch('NVDA', 'alice', { replyToChat: true });
  assert.equal(chatResearch.replyToChat, true);
});

test('research tasks still queued for the trader move to the research worker and are never traded on', async () => {
  const old = commands.enqueueRequest('trader', 'Research BRK.B under the active strategy. If held, review its original thesis.', 'alice', undefined, { mode: 'review_only' });
  const trader = new Trader();
  trader.provider = { chat: async () => assert.fail('The trader must not run an old research task') };
  const researcher = new Researcher();
  researcher.provider = { chat: async () => textResponse() };
  researcher.start();
  await researcher.active;
  await researcher.stop();
  const moved = commands.getRequest(old.id);
  assert.equal(moved.status, 'failed'); assert.match(moved.result, /Restarted as research request/);
  const restarted = commands.listRequests(10).find(r => r.role === 'researcher');
  assert.equal(restarted.symbol, 'BRK.B'); assert.equal(restarted.actorId, 'alice'); assert.equal(restarted.status, 'completed');
  assert.equal(commands.pendingRequests('trader').length, 0);
});

test('research has its own share of the daily AI budget', async () => {
  const { withModelBudget, modelBudgetStatus } = from('core/modelBudget');
  const previous = process.env.AI_MAX_REQUESTS_PER_DAY; process.env.AI_MAX_REQUESTS_PER_DAY = '10';
  try {
    assert.equal(modelBudgetStatus().researchLimit, 3);
    const provider = withModelBudget({ chat: async () => textResponse() });
    const params = { systemPrompt: '', messages: [], tools: [], maxTokens: 100 };
    await agentContext.run({ role: 'researcher', actorId: 'alice', requestId: 'budget-research' }, async () => {
      for (let i = 0; i < 3; i++) await provider.chat(params);
      await assert.rejects(() => provider.chat(params), /Research budget reached/);
    });
    await agentContext.run({ role: 'trader', actorId: 'system', requestId: 'budget-trader' }, () => provider.chat(params));
    await agentContext.run({ role: 'assistant', actorId: 'alice', requestId: 'budget-chat' }, () => provider.chat(params));
  } finally { if (previous === undefined) delete process.env.AI_MAX_REQUESTS_PER_DAY; else process.env.AI_MAX_REQUESTS_PER_DAY = previous; }
});

test('chat budget exhaustion preserves a separate allocation for trader work', async () => {
  const { withModelBudget } = from('core/modelBudget');
  const previous = process.env.AI_MAX_REQUESTS_PER_DAY; process.env.AI_MAX_REQUESTS_PER_DAY = '5';
  try {
    const provider = withModelBudget({ chat: async () => textResponse() });
    const params = { systemPrompt: '', messages: [], tools: [], maxTokens: 100 };
    await agentContext.run({ role: 'assistant', actorId: 'alice', requestId: 'budget' }, async () => {
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
    actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'audit', timeoutMs: 60000, params: { qty: 1 } });
    return '{}';
  });
  const work = runAgentLoop({ context: { role: 'trader', requestId: 'cancelled', actorId: 'alice' }, registry, provider: { chat: async () => toolResponse([['write', {}]]) },
    messages: async () => [], systemPrompt: '', maxTokens: 100, signal: abort.signal });
  await began; abort.abort(); release();
  const result = await work;
  assert.equal(result.status, 'interrupted'); assert.equal(actions.listOrders().length, 0);
});

test('a model timeout fails the turn with a plain message instead of interrupting it', async () => {
  const { SLOW_MODEL_MESSAGE } = from('agents/agentLoop');
  const registry = new ToolRegistry([], async () => '{}');
  const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const result = await runAgentLoop({ context: { role: 'assistant', requestId: 'slow-model', actorId: 'alice' }, registry,
    provider: { chat: async () => timeout() }, messages: async () => [], systemPrompt: '', maxTokens: 100,
    signal: new AbortController().signal });
  assert.equal(result.status, 'failed'); assert.equal(result.error, SLOW_MODEL_MESSAGE);
});

test('a dropped model connection is retried within the same request; a bad request is not', async () => {
  const provider = new model.OpenAICompatibleProvider({ provider: 'openai', apiKey: 'k', model: 'gpt-4o', baseUrl: 'https://model.invalid' });
  const answer = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const prior = global.fetch;
  try {
    let calls = 0;
    global.fetch = async () => { if (++calls === 1) throw new TypeError('fetch failed'); return { ok: true, json: async () => answer }; };
    const reply = await provider.chat({ systemPrompt: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 10 });
    assert.equal(calls, 2); assert.equal(reply.content[0].text, 'ok');
    calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'bad request' }; };
    await assert.rejects(provider.chat({ systemPrompt: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 10 }), /400/);
    assert.equal(calls, 1);
  } finally { global.fetch = prior; }
});

test('a connection that drops on every retry fails with a plain message', async () => {
  const { UNREACHABLE_MODEL_MESSAGE } = from('agents/agentLoop');
  const registry = new ToolRegistry([], async () => '{}');
  const result = await runAgentLoop({ context: { role: 'assistant', requestId: 'unreachable-model', actorId: 'alice' }, registry,
    provider: { chat: async () => { throw new TypeError('fetch failed'); } }, messages: async () => [], systemPrompt: '', maxTokens: 100,
    signal: new AbortController().signal });
  assert.equal(result.status, 'failed'); assert.equal(result.error, UNREACHABLE_MODEL_MESSAGE);
});

test('restart honors saved truncation and terminal model responses', async () => {
  for (const reason of ['max_tokens','end_turn']) {
    const id = 'saved-' + reason;
    const content = reason === 'max_tokens' ? toolResponse([['write', {}]]).content : textResponse().content;
    storage.saveRecord('trajectories', id, { id, messages: [{ role: 'assistant', content }], rounds: 1, status: 'running', responseStopReason: reason, inTokens: 0, outTokens: 0, text: '' });
    const registry = new ToolRegistry([{ name: 'write', description: '', input_schema: { type: 'object', properties: {}, required: [] } }], async () => { throw new Error('Must not invoke a tool'); });
    const result = await runAgentLoop({ context: { role: 'trader', requestId: id, actorId: 'test' }, registry, provider: { chat: async () => { throw new Error('Must not call the model again'); } }, messages: async () => [], systemPrompt: '', maxTokens: 100 });
    assert.equal(result.status, reason === 'max_tokens' ? 'failed' : 'completed');
    if (reason === 'end_turn') assert.equal(result.text, 'Done');
  }
});

test('legacy queued actions acquire a journal record before transitioning', () => {
  const p = actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', reason: 'legacy', timeoutMs: 60000, params: { qty: 1 } });
  storage.deleteRecord('journal', 'order-' + p.id);
  actions.decideOrder(p.id, 'approve', 'human', undefined, 'alice');
  assert.equal(journal.readDecision('order-' + p.id).orderStatus, 'approved');
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
