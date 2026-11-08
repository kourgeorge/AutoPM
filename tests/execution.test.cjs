const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const { spawnSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-test-'));
Object.assign(process.env, { DATA_DIR: dir, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets' });
require('ts-node/register');
const denyNetwork = () => { throw new Error('Unexpected network access'); };
require('http').request = denyNetwork;
require('https').request = denyNetwork;
global.fetch = denyNetwork;
const state = require('../src/state/state');
const store = require('../src/core/storage');
const policy = require('../src/policy/load');
const actions = require('../src/core/orders');
const orders = require('../src/strategy/orderManager');
const validateRealEntry = orders.validateEntry;
const { broker } = require('../src/broker');
const executor = require('../src/strategy/orderExecutor');
const journal = require('../src/journal/journal');
const runtime = require('../src/core/runtime');
const { HeadlessUI } = require('../src/ui/headless');
let placed, brokerOrder, held;
const signal = { symbol: 'AAPL', signal: 'buy', price: 100, stopLoss: 95, takeProfit: 110, atr: 2, reason: 'test' };
const { signal: _side, reason: _reason, ...plan } = signal;
function entry(automatic = false) {
  return actions.createOrder({ kind: 'entry', symbol: 'AAPL', venue: 'paper', params: { ...plan, qty: 2, maxQty: 2 }, reason: 'test', timeoutMs: 60000, automatic });
}
beforeEach(async () => {
  store.resetStorage();
  state.updateState({ positionSnapshots: {}, accountId: 'alpaca:paper:acct', paused: false });
  policy.loadPolicy();
  placed = 0; brokerOrder = null; held = [];
  broker.getAccountInfo = async () => ({ accountId: 'acct', equity: 100000, cash: 100000, buyingPower: 100000, previousCloseEquity: 100000 });
  broker.getPositions = async () => held;
  broker.getOpenOrders = async () => [];
  broker.getOrder = async () => brokerOrder;
  broker.findOrder = async () => brokerOrder;
  broker.placeOrder = async req => { placed++; return { id: 'broker-1' }; };
  orders.validateEntry = async (s, q) => ({ ...s, regimeQty: q });
  await runtime.initializeAccount();
});
after(() => { runtime.stopRuntime(); store.closeStorage(); });

/** Runs `fn` with `Date.now` under test control; `tick(ms)` moves it forward. */
async function withClock(fn) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try { await fn(ms => { now += ms; }); }
  finally { Date.now = realNow; }
}

test('manual approval and automatic execution share bookkeeping; baselines wait for fills', async () => {
  const p = entry();
  actions.decideOrder(p.id, 'approve', 'human', undefined, 'alice');
  brokerOrder = { id: 'broker-1', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 0, filledPrice: null, status: 'open' };
  await executor.sweepOrders();
  assert.equal(placed, 1);
  assert.equal(actions.getOrder(p.id).status, 'submitted');
  assert.equal(state.getPositionSnapshot('AAPL'), undefined);
  assert.equal(journal.readDecisions({ filter: r => r.kind === 'entry' }).length, 1);
  brokerOrder = { ...brokerOrder, status: 'filled', filledQty: 2, filledPrice: 100.5 };
  await executor.sweepOrders();
  assert.equal(placed, 1);
  assert.equal(actions.getOrder(p.id).status, 'executed');
  assert.equal(state.getPositionSnapshot('AAPL').entryPrice, 100.5);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 95);
  assert.equal(actions.getOrder(p.id).actorId, 'alice');
});

test('restart in the broker acceptance window recovers once without resubmission', async () => {
  const p = entry(true);
  actions.transitionOrder(p.id, 'executing');
  brokerOrder = { id: 'broker-existing', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 2, filledPrice: 101, status: 'filled' };
  await executor.sweepOrders();
  assert.equal(placed, 0);
  assert.equal(actions.getOrder(p.id).status, 'executed');
  assert.equal(journal.readDecisions().length, 1);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 95);
});

test('unknown broker outcomes block another account action', async () => {
  const first = entry(true);
  actions.transitionOrder(first.id, 'executing');
  const second = actions.createOrder({ kind: 'entry', symbol: 'MSFT', venue: 'paper', params: { ...plan, symbol: 'MSFT', qty: 1 }, reason: 'test', timeoutMs: 60000, automatic: true });
  await executor.sweepOrders();
  assert.equal(actions.getOrder(first.id).status, 'unknown');
  assert.equal(actions.getOrder(second.id).status, 'approved');
  assert.equal(placed, 0);
});

test('an unknown exit the broker never received is marked failed, and the stop is re-armed', async () => {
  const { sweepStops } = require('../src/strategy/stopOrders');
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 9555 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, takeProfitLevel: 281 });
  const p = actions.createOrder({ kind: 'exit', symbol: 'IBM', venue: 'paper', params: { qty: 39 }, reason: 'test', timeoutMs: 60000, automatic: true });
  actions.transitionOrder(p.id, 'executing');
  actions.transitionOrder(p.id, 'unknown', { result: { error: 'Broker has not confirmed cancellation of f1159a95' } });
  state.updateState({ paused: false });
  let oco = 0;
  broker.placeOco = async () => { oco++; return { stopOrderId: 'stop-new', takeProfitOrderId: 'tp-new' }; };
  await withClock(async tick => {
    await executor.sweepOrders();
    assert.equal(actions.getOrder(p.id).status, 'unknown', 'a fresh unknown is given time to reach the venue');
    tick(executor.NEVER_ARRIVED_AFTER_MS + 1000);
    await executor.sweepOrders();
  });
  assert.equal(actions.getOrder(p.id).status, 'failed');
  assert.match(actions.getOrder(p.id).result.error, /never arrived/);
  assert.equal(placed, 0, 'nothing is resubmitted');
  await sweepStops();
  assert.equal(oco, 1, 'with the lock gone, the sweep re-arms the bracket');
  assert.equal(state.getPositionSnapshot('IBM').stopOrderId, 'stop-new');
});

test('on a venue that cannot prove absence, an unknown order stays unknown', async () => {
  const proves = Object.getOwnPropertyDescriptor(broker, 'provesOrderAbsence');
  Object.defineProperty(broker, 'provesOrderAbsence', { value: false, configurable: true });
  try {
    const p = entry(true);
    actions.transitionOrder(p.id, 'executing');
    await withClock(async tick => { tick(executor.NEVER_ARRIVED_AFTER_MS * 10); await executor.sweepOrders(); });
    assert.equal(actions.getOrder(p.id).status, 'unknown');
  } finally { if (proves) Object.defineProperty(broker, 'provesOrderAbsence', proves); else delete broker.provesOrderAbsence; }
});

test('unconfirmed stop cancellation fails the unsent exit without an unknown sell', async () => {
  held = [{ symbol: 'AAPL', qty: 2, marketValue: 200 }];
  state.openPositionSnapshot({ symbol: 'AAPL', stopLevel: 95, stopOrderId: 'stop-1' });
  broker.getOpenOrders = async () => [{ id: 'stop-1', symbol: 'AAPL', side: 'sell', type: 'stop', qty: 2, filled: 0, stopPrice: 95 }];
  broker.cancelOrder = async () => { throw new Error('Broker has not confirmed cancellation'); };
  const validate = orders.validateExit;
  orders.validateExit = async () => ({ pos: held[0], sellQty: 2, price: 100, pnl: 0, session: 'open' });
  try {
    const p = actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', params: { qty: 2 }, reason: 'test', timeoutMs: 60000, automatic: true });
    await executor.sweepOrders();
    assert.equal(actions.getOrder(p.id).status, 'failed');
    assert.match(actions.getOrder(p.id).result.error, /not confirmed cancellation/);
    assert.equal(placed, 0);
    assert.equal(actions.pendingOrders().length, 0);
    await executor.sweepOrders();
    assert.equal(placed, 0, 'failed exit is not automatically retried');
  } finally { orders.validateExit = validate; }
});

test('an exit whose stop cancel succeeds and target cancel fails forgets only the cancelled stop', async () => {
  held = [{ symbol: 'AAPL', qty: 2, marketValue: 200 }];
  state.openPositionSnapshot({ symbol: 'AAPL', stopLevel: 95, takeProfitLevel: 110, stopOrderId: 'stop-1', takeProfitOrderId: 'tp-1' });
  broker.getOpenOrders = async () => [
    { id: 'stop-1', symbol: 'AAPL', side: 'sell', type: 'stop', qty: 2, filled: 0, stopPrice: 95 },
    { id: 'tp-1', symbol: 'AAPL', side: 'sell', type: 'limit', qty: 2, filled: 0, limitPrice: 110 },
  ];
  broker.cancelOrder = async id => { if (id === 'tp-1') throw new Error('Broker has not confirmed cancellation'); };
  const validate = orders.validateExit;
  orders.validateExit = async () => ({ pos: held[0], sellQty: 2, price: 100, pnl: 0, session: 'open' });
  try {
    const p = actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', params: { qty: 2 }, reason: 'test', timeoutMs: 60000, automatic: true });
    await executor.sweepOrders();
    assert.equal(actions.getOrder(p.id).status, 'failed');
    assert.equal(placed, 0);
    const snap = state.getPositionSnapshot('AAPL');
    assert.equal(snap.stopOrderId, undefined, 'the cancelled stop is not kept as protection');
    assert.equal(snap.takeProfitOrderId, 'tp-1', 'the target still rests');
  } finally { orders.validateExit = validate; }
});

test('the stop lock stays held until its last holder finishes', async () => {
  const { withStopLock, isStopLocked } = require('../src/strategy/stopOrders');
  let releaseFirst, releaseSecond;
  const first = withStopLock('AAPL', () => new Promise(r => { releaseFirst = r; }));
  const second = withStopLock('AAPL', () => new Promise(r => { releaseSecond = r; }));
  releaseFirst(); await first;
  assert.equal(isStopLocked('AAPL'), true);
  releaseSecond(); await second;
  assert.equal(isStopLocked('AAPL'), false);
});

test('pause blocks execution and survives a fresh process', async () => {
  const p = entry(true);
  state.updateState({ paused: true });
  await executor.sweepOrders();
  assert.equal(placed, 0);
  assert.equal(actions.getOrder(p.id).status, 'approved');
  const child = spawnSync(process.execPath, ['-r','ts-node/register','-e', "console.log(require('./src/state/state').getState().paused)"], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /true/);
});

test('expired approval is rejected even before a sweep', () => {
  const p = entry();
  store.saveRecord('orders', p.id, { ...p, expiresAt: Date.now() - 1 });
  assert.throws(() => actions.decideOrder(p.id, 'approve', 'human'), /expired/);
  assert.equal(actions.getOrder(p.id).status, 'expired');
});

test('an action is not executed after the strategy changed', async () => {
  const p = entry(true);
  store.saveRecord('orders', p.id, { ...p, policyHash: 'changed' });
  await executor.sweepOrders();
  assert.equal(actions.getOrder(p.id).status, 'failed');
  assert.equal(placed, 0);
});

test('state and audit changes roll back together', () => {
  assert.throws(() => store.transaction(() => {
    state.updateState({ paused: true });
    store.appendRecord('audit-test','one',new Date().toISOString(), { changed: true });
    throw new Error('disk operation interrupted');
  }));
  assert.equal(state.getState().paused, false);
  assert.deepEqual(store.readRecords('audit-test'), []);
});

test('feed cursors remain valid across UI instances', () => {
  const first = new HeadlessUI(); first.reply('first');
  const cursor = first.feedAfter(0,100).at(-1).seq;
  const next = new HeadlessUI(); next.reply('second');
  assert.equal(next.feedAfter(cursor,100)[0].text, 'second');
});

test('an accepted but unfilled exit retains its position baseline', async () => {
  held = [{ symbol: 'AAPL', qty: 2, avgCost: 100, marketValue: 200 }];
  state.openPositionSnapshot({ symbol: 'AAPL', entryPrice: 100, stopLevel: 95 });
  orders.validateExit = async () => ({ pos: held[0], sellQty: 2, price: 100, pnl: 0 });
  const p = actions.createOrder({ kind: 'exit', symbol: 'AAPL', venue: 'paper', params: { qty: 2 }, reason: 'test', timeoutMs: 60000, automatic: true });
  brokerOrder = { id: 'broker-1', symbol: 'AAPL', side: 'sell', qty: 2, filledQty: 0, filledPrice: null, status: 'open' };
  await executor.sweepOrders();
  assert.equal(actions.getOrder(p.id).status, 'submitted');
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 95);
  held = []; brokerOrder = { ...brokerOrder, filledQty: 2, filledPrice: 100, status: 'filled' };
  await executor.sweepOrders();
  assert.equal(state.getPositionSnapshot('AAPL'), undefined);
});

test('a filled new entry replaces a stale trade snapshot and protection IDs', async () => {
  state.openPositionSnapshot({symbol:'AAPL',entryPrice:60,stopLevel:50,stopOrderId:'old-stop',openedAt:'2020-01-01T00:00:00Z',entryDecisionId:'old'});
  const p=entry(true);
  brokerOrder={id:'broker-1',symbol:'AAPL',side:'buy',qty:2,filledQty:2,filledPrice:101,status:'filled'};
  await executor.sweepOrders();
  const saved=state.getPositionSnapshot('AAPL');
  assert.equal(saved.stopLevel,95);assert.equal(saved.stopOrderId,undefined);assert.equal(saved.entryDecisionId,'order-'+p.id);
});

test('a policy change while validation awaits invalidates the approval', async () => {
  const p=entry(true);
  orders.validateEntry=async(s,q)=>{
    const previous=policy.getPolicySnapshot();
    policy.saveStrategy({...previous.policy,risk:{...previous.policy.risk,maxPositions:2}},previous.hash);
    return {...s,regimeQty:q};
  };
  await executor.sweepOrders();
  assert.equal(placed,0);assert.equal(actions.getOrder(p.id).status,'expired');
});

test('an external order is never cancelled to free shares for an exit', async () => {
  let cancelled=0;
  held=[{symbol:'AAPL',qty:2,avgCost:100,marketValue:200}];
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:95,stopOrderId:'our-stop'});
  broker.getOpenOrders=async()=>[{id:'external',symbol:'AAPL',side:'sell',qty:2,filled:0,type:'limit'}];
  broker.cancelOrder=async()=>{cancelled++;};
  await assert.rejects(()=>orders.actExit('AAPL','test',{pos:held[0],sellQty:2,price:100,pnl:0},'test-id'),/will not cancel/);
  assert.equal(cancelled,0);assert.equal(placed,0);
});

test('uncertain protection survives restart semantics and is never blindly placed twice', async () => {
  const { armStop }=require('../src/strategy/stopOrders');
  held=[{symbol:'AAPL',qty:2,avgCost:100,marketValue:200}];
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:95});
  broker.placeOrder=async()=>{placed++;throw new Error('Connection lost after broker acceptance');};
  assert.equal((await armStop('AAPL',2,95)).ok,false);
  assert.equal((await armStop('AAPL',2,95)).ok,false);
  assert.equal(placed,1);assert.equal(state.getState().paused,true);
  assert.equal(store.readValue('protectionIntents').AAPL.status,'unknown');
});

test('a definite broker refusal of a stop is retried without pausing trading', async () => {
  const { armStop }=require('../src/strategy/stopOrders');
  const { BrokerRejection }=require('../src/broker/errors');
  held=[{symbol:'AAPL',qty:2,avgCost:100,marketValue:200}];
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:95});
  broker.placeOrder=async req=>{placed++;throw new BrokerRejection(422,'stop price must be below market',null,req);};
  assert.equal((await armStop('AAPL',2,95)).ok,false);
  assert.equal(state.getState().paused,false);
  assert.equal(store.readValue('protectionIntents').AAPL,undefined);
  broker.placeOrder=async()=>{placed++;return {id:'stop-2'};};
  const second=await armStop('AAPL',2,95);
  assert.equal(second.ok,true);assert.equal(placed,2);
  assert.equal(store.readValue('protectionIntents').AAPL.status,'confirmed');
});

test('a retry-later broker answer is still treated as uncertain', async () => {
  const { armStop }=require('../src/strategy/stopOrders');
  const { BrokerRejection }=require('../src/broker/errors');
  held=[{symbol:'AAPL',qty:2,avgCost:100,marketValue:200}];
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:95});
  broker.placeOrder=async req=>{placed++;throw new BrokerRejection(429,'rate limit',null,req);};
  assert.equal((await armStop('AAPL',2,95)).ok,false);
  assert.equal(state.getState().paused,true);
  assert.equal(store.readValue('protectionIntents').AAPL.status,'unknown');
});

test('a pair whose stop was accepted before the target failed keeps the stop id', async () => {
  const { armOco }=require('../src/strategy/stopOrders');
  const { BrokerRejection }=require('../src/broker/errors');
  held=[{symbol:'AAPL',qty:2,avgCost:100,marketValue:200}];
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:95,takeProfitLevel:110});
  broker.placeOco=async req=>{throw new BrokerRejection(null,'target leg timed out',null,req,'ib-stop-7');};
  assert.equal((await armOco('AAPL',2,95,110)).ok,false);
  assert.equal(state.getPositionSnapshot('AAPL').stopOrderId,'ib-stop-7');
  assert.equal(state.getState().paused,true);
});

test('pending exits keep their baseline across multiple protection sweeps', async () => {
  const { sweepStops }=require('../src/strategy/stopOrders');
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:95,stopOrderId:'our-stop'});
  const p=actions.createOrder({kind:'exit',symbol:'AAPL',venue:'paper',params:{qty:2},reason:'test',timeoutMs:60000,automatic:true});
  actions.transitionOrder(p.id,'executing');actions.transitionOrder(p.id,'submitted',{result:{brokerOrderId:'exit',qty:2}});
  held=[];
  for(let i=0;i<6;i++)await sweepStops();
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel,95);
});

test('unheld snapshots wait for consecutive reads and do not depend on protective order lookups', async () => {
  const { sweepStops } = require('../src/strategy/stopOrders');
  held = [{symbol:'MSFT',qty:1,avgCost:100,marketValue:100}];
  state.openPositionSnapshot({symbol:'BRKB',stopLevel:532.32,stopOrderId:'cancelled-stop',takeProfitOrderId:'expired-target'});
  let lookups = 0;
  broker.getOrder = async () => { lookups++; throw new Error('Old order unavailable'); };
  await withClock(async tick => {
    await sweepStops();
    assert.ok(state.getPositionSnapshot('BRKB'));
    tick(61_000);
    await sweepStops();
    assert.equal(state.getPositionSnapshot('BRKB'), undefined);
    await sweepStops();
  });
  assert.equal(lookups, 0);
});

test('a burst of missing reads inside the time window keeps the snapshot', async () => {
  const { sweepStops } = require('../src/strategy/stopOrders');
  held = [{symbol:'MSFT',qty:1,avgCost:100,marketValue:100}];
  state.openPositionSnapshot({symbol:'BRKB',stopLevel:532.32});
  await withClock(async tick => {
    // 2-second sweeps: twenty reads in forty seconds is venue trouble, not a close.
    for (let i = 0; i < 20; i++) { await sweepStops(); tick(2_000); }
    assert.ok(state.getPositionSnapshot('BRKB'));
    tick(21_000);
    await sweepStops();
    assert.equal(state.getPositionSnapshot('BRKB'), undefined);
  });
});

test('flat book preserves snapshots until five consecutive missing reads', async () => {
  const { sweepStops } = require('../src/strategy/stopOrders');
  state.openPositionSnapshot({symbol:'BRKB',stopLevel:532.32});
  await withClock(async tick => {
    for (let i = 0; i < 4; i++) {
      await sweepStops();
      assert.ok(state.getPositionSnapshot('BRKB'));
      tick(100_000);
    }
    await sweepStops();
    assert.equal(state.getPositionSnapshot('BRKB'), undefined);
  });
});

test('a flat book read many times within five minutes keeps the snapshot', async () => {
  const { sweepStops } = require('../src/strategy/stopOrders');
  state.openPositionSnapshot({symbol:'BRKB',stopLevel:532.32});
  await withClock(async tick => {
    for (let i = 0; i < 100; i++) { await sweepStops(); tick(2_000); }
    assert.ok(state.getPositionSnapshot('BRKB'));
    tick(101_000);
    await sweepStops();
    assert.equal(state.getPositionSnapshot('BRKB'), undefined);
  });
});

test('a returning holding resets the snapshot absence count', async () => {
  const { sweepStops } = require('../src/strategy/stopOrders');
  const other = {symbol:'MSFT',qty:1,avgCost:100,marketValue:100};
  state.openPositionSnapshot({symbol:'BRKB'});
  await withClock(async tick => {
    held = [other];
    await sweepStops();
    tick(61_000);
    held = [other, {symbol:'BRKB',qty:1,avgCost:543.77,marketValue:543.77}];
    await sweepStops();
    held = [other];
    await sweepStops();
    tick(61_000);
    assert.ok(state.getPositionSnapshot('BRKB'));
    await sweepStops();
    assert.equal(state.getPositionSnapshot('BRKB'), undefined);
  });
});

test('a stop moved during a sweep is re-read, not flagged as vanished', async () => {
  const { sweepStops }=require('../src/strategy/stopOrders');
  held=[{symbol:'AAPL',qty:2,avgCost:100,marketValue:200}];
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:96,stopOrderId:'new-stop'});
  store.saveValue('protectionIntents',{AAPL:{id:'atp-x',symbol:'AAPL',at:new Date().toISOString(),stop:96,status:'confirmed'}});
  const live={id:'new-stop',symbol:'AAPL',side:'sell',qty:2,filled:0,type:'stop',stopPrice:96};
  let reads=0;
  broker.getOpenOrders=async()=>(++reads===1?[]:[live]);
  await sweepStops();
  assert.equal(state.getState().paused,false);
  assert.equal(state.getPositionSnapshot('AAPL').stopOrderId,'new-stop');
  assert.equal(store.readValue('protectionIntents').AAPL.status,'confirmed');
});

test('a stop the venue reports cancelled minutes after placement still pauses trading', async () => {
  const { sweepStops }=require('../src/strategy/stopOrders');
  held=[{symbol:'AAPL',qty:2,avgCost:100,marketValue:200}];
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:96,stopOrderId:'gone-stop'});
  store.saveValue('protectionIntents',{AAPL:{id:'atp-y',symbol:'AAPL',at:new Date().toISOString(),stop:96,status:'confirmed'}});
  brokerOrder={id:'gone-stop',symbol:'AAPL',side:'sell',qty:2,filledQty:0,filledPrice:null,status:'cancelled'};
  await sweepStops();
  assert.equal(state.getState().paused,true);
  assert.equal(store.readValue('protectionIntents').AAPL.status,'unknown');
});

test('entry validation requires a fresh quote and caps a valid order at a cent-priced limit', async () => {
  const prices = require('../src/collect/priceSource');
  const bars = require('../src/collect/barSource');
  const fundamentals=require('../src/collect/fundamentals');
  const originalFundamentals=fundamentals.getFundamentals;
  const regime=require('../src/macro/regime'), originalRegime=regime.getRegime;
  regime.getRegime=async()=>({regime:'expansion',confidence:'high'});
  const originalPrices=prices.collectPrices, originalBars=bars.collectBars;
  try {
    await assert.rejects(()=>validateRealEntry({...signal,stopLoss:95.001},2),err=>err.rule==='price_precision');
    // This case isolates quote handling for an existing account. Risk-profile entry checks
    // (including limit-price reward:risk) are exercised with live validation in risk.test.cjs.
    const p=policy.getPolicy(); policy.useEphemeralPolicy({...p,risk:{...p.risk,earningsBlackoutDays:0,riskPerTradePct:null,targetVolatilityPct:null,minRewardRisk:null}});
    state.updateState({startOfDayEquity:100000});broker.isMarketOpen=async()=>true;
    fundamentals.getFundamentals=async()=>({calendar:{nextEarningsAt:null,daysUntil:null}});
    prices.collectPrices=async()=>new Map([['AAPL',{value:100.13,stale:true,asOf:new Date().toISOString()}]]);
    await assert.rejects(()=>validateRealEntry(signal,2),err=>err.rule==='quote_unavailable');
    prices.collectPrices=async()=>new Map([['AAPL',{value:100.13,stale:false,asOf:new Date().toISOString()}]]);
    bars.collectBars=async()=>({stale:false,asOf:new Date().toISOString(),value:Array.from({length:200},(_,i)=>({t:new Date(Date.now()-(200-i)*86400000).toISOString(),o:20+i*.4,h:21+i*.4,l:19+i*.4,c:20.5+i*.4,v:100000+i*1000}))});
    const validated=await validateRealEntry(signal,2);
    assert.ok(validated.price<=101);assert.ok(validated.price>=100.13);
    assert.equal(Math.round(validated.price*100),validated.price*100);
  } finally {prices.collectPrices=originalPrices;bars.collectBars=originalBars;fundamentals.getFundamentals=originalFundamentals;regime.getRegime=originalRegime;}
});

test('an order is saved once: the journal row holds no copy of it, and readers still see the whole decision', async () => {
  const p = entry(true);
  brokerOrder = { id: 'broker-1', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 2, filledPrice: 100.5, status: 'filled' };
  await executor.sweepOrders();
  const row = store.readRecord('journal', 'order-' + p.id);
  for (const field of ['rationale', 'qty', 'price', 'fillPrice', 'filledQty', 'requestedQty', 'orderStatus', 'intendedPrice', 'intendedStop', 'brokerOrderId', 'thesis', 'executed', 'policyHash'])
    assert.equal(field in row, false, `${field} is a copy of the order`);
  assert.equal(Object.values(row).includes(null), false, 'empty fields are not written');
  const d = journal.readDecision('order-' + p.id);
  assert.deepEqual([d.rationale, d.qty, d.price, d.fillPrice, d.requestedQty, d.orderStatus, d.intendedStop, d.brokerOrderId, d.executed],
    ['test', 2, 100.5, 100.5, 2, 'executed', 95, 'broker-1', true]);
  const saved = actions.getOrder(p.id);
  assert.equal('signal' in saved.params, false, 'the plan is not saved twice inside the order');
  const steps = saved.history.filter(s => s.result);
  assert.deepEqual(steps.at(-1).result, { filledQty: 2, filledPrice: 100.5 }, 'a step keeps only what it changed');
});

test('a protection check that finds nothing new writes nothing', async () => {
  const p = entry(true);
  brokerOrder = { id: 'broker-1', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 2, filledPrice: 100.5, status: 'filled' };
  await executor.sweepOrders();
  state.upsertPositionSnapshot('AAPL', { stopOrderId: 'stop', takeProfitLevel: undefined });
  held = [{ symbol: 'AAPL', qty: 2 }];
  broker.getOpenOrders = async () => [{ id: 'stop', symbol: 'AAPL', side: 'sell', type: 'stop', stopPrice: 95, qty: 2, filled: 0 }];
  const { refreshJournalProtection } = require('../src/journal/protection');
  await refreshJournalProtection();
  assert.equal(journal.readDecision('order-' + p.id).protectionStatus, 'confirmed');
  const writes = [], realSave = store.saveRecord;
  store.saveRecord = (kind, ...rest) => { writes.push(kind); return realSave(kind, ...rest); };
  try { await refreshJournalProtection(); await refreshJournalProtection(); } finally { store.saveRecord = realSave; }
  assert.deepEqual(writes, []);
});

test('startup reports our own stop resting at a different price than recorded', async () => {
  const { checkRecordedStops } = require('../src/review/reconcile');
  state.openPositionSnapshot({ symbol: 'AAPL', stopLevel: 116, stopOrderId: 'our-stop' });
  state.openPositionSnapshot({ symbol: 'MSFT', stopLevel: 300, stopOrderId: 'ms-stop' });
  broker.getOpenOrders = async () => [
    { id: 'our-stop', symbol: 'AAPL', side: 'sell', type: 'stop', qty: 2, filled: 0, stopPrice: 100 },
    { id: 'ms-stop', symbol: 'MSFT', side: 'sell', type: 'stop', qty: 1, filled: 0, stopPrice: 300 },
  ];
  const found = await checkRecordedStops();
  assert.equal(found.length, 1);
  assert.match(found[0], /AAPL.*\$116.*\$100/);
});

test('removing a target on Alpaca re-places the linked stop the cancel took with it', async () => {
  const { agentContext } = require('../src/core/agentContext');
  const traderTools = require('../src/tools/traderTools');
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 39 * 260 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, takeProfitLevel: 281, stopOrderId: 'stop-1', takeProfitOrderId: 'tp-1' });
  let book = [
    { id: 'tp-1', groupId: 'tp-1', symbol: 'IBM', side: 'sell', type: 'limit', qty: 39, filled: 0, limitPrice: 281, status: 'accepted' },
    { id: 'stop-1', groupId: 'tp-1', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84, status: 'held' },
  ];
  const cancelled = [];
  broker.getOpenOrders = async () => book;
  broker.cancelOrder = async id => { cancelled.push(id); book = []; };
  broker.placeOrder = async req => { placed++; book = [{ id: 'stop-2', symbol: 'IBM', side: 'sell', type: 'stop', qty: req.qty, filled: 0, stopPrice: req.stopPrice }]; return { id: 'stop-2' }; };

  const scheduled = JSON.parse(await agentContext.run({ role: 'trader', requestId: 'cycle', actorId: 'system' },
    () => traderTools.executeTraderTool('annotate_position', { symbol: 'IBM', removeTarget: true, thesis: 'let it run' })));
  assert.equal(scheduled.ok, false, 'the scheduler cannot remove a target on its own');

  const queued = JSON.parse(await agentContext.run({ role: 'assistant', requestId: 'chat', actorId: 'alice' },
    () => traderTools.executeTraderTool('annotate_position', { symbol: 'IBM', removeTarget: true, thesis: 'Operator asked to drop the target; the stop stays' })));
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.stopLoss, 241.84, 'the recorded stop is kept');
  const order = actions.getOrder(queued.orderId);
  if (order.status === 'pending') actions.decideOrder(order.id, 'approve', 'human', undefined, 'alice');
  await executor.sweepOrders();

  assert.deepEqual(cancelled, ['tp-1']);
  assert.equal(actions.getOrder(queued.orderId).status, 'executed');
  const snap = state.getPositionSnapshot('IBM');
  assert.equal(snap.takeProfitLevel, undefined);
  assert.equal(snap.takeProfitOrderId, undefined);
  assert.equal(snap.stopOrderId, 'stop-2');
  assert.equal(snap.stopLevel, 241.84);
  assert.deepEqual(book.map(o => [o.type, o.stopPrice]), [['stop', 241.84]]);
});

test('removing a target keeps a stop that survives the cancel', async () => {
  const { dropTakeProfit } = require('../src/strategy/stopOrders');
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 39 * 260 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, takeProfitLevel: 281, stopOrderId: 's', takeProfitOrderId: 't' });
  let book = [
    { id: 't', groupId: 'g', symbol: 'IBM', side: 'sell', type: 'limit', qty: 39, filled: 0, limitPrice: 281 },
    { id: 's', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84 },
  ];
  broker.getOpenOrders = async () => book;
  broker.cancelOrder = async id => { book = book.filter(o => o.id !== id); };
  const r = await dropTakeProfit('IBM', 39, 241.84);
  assert.deepEqual(r, { ok: true, brokerOrderId: 's' });
  assert.equal(placed, 0, 'no new stop is placed');
  assert.equal(state.getPositionSnapshot('IBM').takeProfitLevel, undefined);
});

test('a pause holds the scheduler\'s own orders but not the operator\'s', async () => {
  const { agentContext } = require('../src/core/agentContext');
  const traderTools = require('../src/tools/traderTools');
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 39 * 260 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, takeProfitLevel: 281, stopOrderId: 'stop-1', takeProfitOrderId: 'tp-1' });
  let book = [
    { id: 'tp-1', groupId: 'tp-1', symbol: 'IBM', side: 'sell', type: 'limit', qty: 39, filled: 0, limitPrice: 281 },
    { id: 'stop-1', groupId: 'tp-1', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84 },
  ];
  broker.getOpenOrders = async () => book;
  broker.cancelOrder = async () => { book = []; };
  broker.placeOrder = async req => { placed++; book = [{ id: 'stop-2', symbol: 'IBM', side: 'sell', type: 'stop', qty: req.qty, filled: 0, stopPrice: req.stopPrice }]; return { id: 'stop-2' }; };
  state.updateState({ paused: true });

  const scheduled = JSON.parse(await agentContext.run({ role: 'trader', requestId: 'cycle', actorId: 'system' },
    () => traderTools.executeTraderTool('annotate_position', { symbol: 'IBM', stopLoss: 245, thesis: 'tighten on strength' })));
  assert.equal(scheduled.ok, undefined); assert.match(scheduled.error, /paused/);

  const asked = JSON.parse(await agentContext.run({ role: 'assistant', requestId: 'chat', actorId: 'alice' },
    () => traderTools.executeTraderTool('annotate_position', { symbol: 'IBM', removeTarget: true, thesis: 'Operator asked to drop the target' })));
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const order = actions.getOrder(asked.orderId);
  if (order.status === 'pending') actions.decideOrder(order.id, 'approve', 'human', undefined, 'alice');
  await executor.sweepOrders();
  assert.equal(actions.getOrder(asked.orderId).status, 'executed');
  assert.equal(state.getPositionSnapshot('IBM').takeProfitLevel, undefined);
  assert.equal(state.getState().paused, true, 'the pause itself is left alone');
});

test('a scheduler order queued before a pause does not run during it', async () => {
  const p = entry(true);
  state.updateState({ paused: true });
  await executor.sweepOrders();
  assert.equal(actions.getOrder(p.id).status, 'approved');
  assert.equal(placed, 0);
});

test('a target is put back on a stop-only position as a linked pair', async () => {
  const { moveOcoTo } = require('../src/strategy/stopOrders');
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 39 * 260 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, takeProfitLevel: 281, stopOrderId: 'stop-2' });
  let book = [{ id: 'stop-2', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84 }];
  const cancelled = [];
  broker.getOpenOrders = async () => book;
  broker.cancelOrder = async id => { cancelled.push(id); book = book.filter(o => o.id !== id); };
  broker.placeOco = async req => {
    book = [{ id: 'tp-9', groupId: 'tp-9', symbol: 'IBM', side: 'sell', type: 'limit', qty: req.qty, filled: 0, limitPrice: req.takeProfitPrice },
      { id: 'stop-9', groupId: 'tp-9', symbol: 'IBM', side: 'sell', type: 'stop', qty: req.qty, filled: 0, stopPrice: req.stopPrice }];
    return { stopOrderId: 'stop-9', takeProfitOrderId: 'tp-9' };
  };
  const r = await moveOcoTo('IBM', 39, 241.84, 281);
  assert.deepEqual(r, { ok: true, stopOrderId: 'stop-9', takeProfitOrderId: 'tp-9' });
  assert.deepEqual(cancelled, ['stop-2']);
  const snap = state.getPositionSnapshot('IBM');
  assert.equal(snap.stopOrderId, 'stop-9'); assert.equal(snap.takeProfitOrderId, 'tp-9');
});

test('if the pair is refused, the lone stop is put back', async () => {
  const { moveOcoTo } = require('../src/strategy/stopOrders');
  const { BrokerRejection } = require('../src/broker/errors');
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 39 * 260 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, takeProfitLevel: 281, stopOrderId: 'stop-2' });
  let book = [{ id: 'stop-2', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84 }];
  broker.getOpenOrders = async () => book;
  broker.cancelOrder = async id => { book = book.filter(o => o.id !== id); };
  broker.placeOco = async () => { throw new BrokerRejection(422, 'refused', null, {}); };
  broker.placeOrder = async req => { placed++; book = [{ id: 'stop-3', symbol: 'IBM', side: 'sell', type: 'stop', qty: req.qty, filled: 0, stopPrice: req.stopPrice }]; return { id: 'stop-3' }; };
  const r = await moveOcoTo('IBM', 39, 241.84, 281);
  assert.equal(r.ok, false); assert.match(r.reason, /lone stop .* was put back/);
  assert.equal(state.getPositionSnapshot('IBM').stopOrderId, 'stop-3');
  assert.deepEqual(book.map(o => o.stopPrice), [241.84]);
});

test('an unknown adjustment the broker book shows was not made is marked failed, freeing the symbol', async () => {
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 39 * 260 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, takeProfitLevel: 281, stopOrderId: 'stop-2' });
  broker.getOpenOrders = async () => [{ id: 'stop-2', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84 }];
  const p = actions.createOrder({ kind: 'target_adjust', symbol: 'IBM', venue: 'paper', params: { symbol: 'IBM', stopLoss: 241.84, takeProfit: 281 }, reason: 'restore target', timeoutMs: 60000, automatic: true });
  actions.transitionOrder(p.id, 'executing');
  actions.transitionOrder(p.id, 'unknown', { result: { error: 'Protection update is not confirmed at the broker' } });
  await withClock(async tick => {
    await executor.sweepOrders();
    assert.equal(actions.getOrder(p.id).status, 'unknown', 'given time first');
    tick(executor.NEVER_ARRIVED_AFTER_MS + 1000);
    await executor.sweepOrders();
  });
  assert.equal(actions.getOrder(p.id).status, 'failed');
  assert.equal(actions.pendingOrders().length, 0);
});

test('the pair waits until the cancelled stop has released the shares', async () => {
  const { moveOcoTo } = require('../src/strategy/stopOrders');
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 39 * 260 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, takeProfitLevel: 281, stopOrderId: 'stop-2' });
  const stop = { id: 'stop-2', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84 };
  let book = [stop], lingering = 0;
  // The broker confirms the cancel but keeps listing the stop for a few more reads.
  broker.getOpenOrders = async () => { if (lingering > 0) { lingering--; return [stop]; } return book; };
  broker.cancelOrder = async () => { book = []; lingering = 3; };
  broker.placeOco = async req => {
    book = [{ id: 'tp-9', groupId: 'tp-9', symbol: 'IBM', side: 'sell', type: 'limit', qty: 39, filled: 0, limitPrice: 281 },
      { id: 'stop-9', groupId: 'tp-9', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84 }];
    return { stopOrderId: 'stop-9', takeProfitOrderId: 'tp-9' };
  };
  const r = await moveOcoTo('IBM', 39, 241.84, 281);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(placed, 0, 'no fallback stop was needed');
});

test('a refused target restore fails plainly: no pause, no lock, record matches the broker', async () => {
  const { BrokerRejection } = require('../src/broker/errors');
  held = [{ symbol: 'IBM', qty: 39, avgCost: 253.78, marketValue: 39 * 260 }];
  state.openPositionSnapshot({ symbol: 'IBM', stopLevel: 241.84, stopOrderId: 'stop-2' });
  let book = [{ id: 'stop-2', symbol: 'IBM', side: 'sell', type: 'stop', qty: 39, filled: 0, stopPrice: 241.84 }];
  broker.getOpenOrders = async () => book;
  broker.cancelOrder = async id => { book = book.filter(o => o.id !== id); };
  broker.placeOco = async () => { throw new BrokerRejection(422, 'refused', null, {}); };
  broker.placeOrder = async req => { placed++; book = [{ id: 'stop-3', symbol: 'IBM', side: 'sell', type: 'stop', qty: req.qty, filled: 0, stopPrice: req.stopPrice }]; return { id: 'stop-3' }; };
  const p = actions.createOrder({ kind: 'target_adjust', symbol: 'IBM', venue: 'paper', params: { symbol: 'IBM', stopLoss: 241.84, takeProfit: 281, thesis: 'restore target' }, reason: 'restore target', timeoutMs: 60000, automatic: true });
  await executor.sweepOrders();
  assert.equal(actions.getOrder(p.id).status, 'failed', JSON.stringify(actions.getOrder(p.id).result));
  assert.equal(state.getState().paused, false);
  assert.equal(actions.pendingOrders().length, 0);
  const snap = state.getPositionSnapshot('IBM');
  assert.equal(snap.takeProfitLevel, undefined); assert.equal(snap.stopOrderId, 'stop-3');
});
