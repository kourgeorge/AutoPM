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
const actions = require('../src/core/actions');
const orders = require('../src/strategy/orderManager');
const validateRealEntry = orders.validateEntry;
const { broker } = require('../src/broker');
const executor = require('../src/strategy/actionExecutor');
const journal = require('../src/journal/journal');
const runtime = require('../src/core/runtime');
const { HeadlessUI } = require('../src/ui/headless');
let placed, brokerOrder, held;
const signal = { symbol: 'AAPL', signal: 'buy', price: 100, stopLoss: 95, takeProfit: 110, atr: 2, reason: 'test' };
function entry(automatic = false) {
  return actions.createAction({ kind: 'entry', symbol: 'AAPL', venue: 'paper', params: { signal, qty: 2, maxQty: 2 }, reason: 'test', timeoutMs: 60000, automatic });
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

test('manual approval and automatic execution share bookkeeping; baselines wait for fills', async () => {
  const p = entry();
  actions.decideAction(p.id, 'approve', 'human', undefined, 'alice');
  brokerOrder = { id: 'broker-1', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 0, filledPrice: null, status: 'open' };
  await executor.sweepActions();
  assert.equal(placed, 1);
  assert.equal(actions.getAction(p.id).status, 'submitted');
  assert.equal(state.getPositionSnapshot('AAPL'), undefined);
  assert.equal(journal.readDecisions({ filter: r => r.kind === 'entry' }).length, 1);
  brokerOrder = { ...brokerOrder, status: 'filled', filledQty: 2, filledPrice: 100.5 };
  await executor.sweepActions();
  assert.equal(placed, 1);
  assert.equal(actions.getAction(p.id).status, 'executed');
  assert.equal(state.getPositionSnapshot('AAPL').entryPrice, 100.5);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 95);
  assert.equal(actions.getAction(p.id).actorId, 'alice');
});

test('restart in the broker acceptance window recovers once without resubmission', async () => {
  const p = entry(true);
  actions.transitionAction(p.id, 'executing');
  brokerOrder = { id: 'broker-existing', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 2, filledPrice: 101, status: 'filled' };
  await executor.sweepActions();
  assert.equal(placed, 0);
  assert.equal(actions.getAction(p.id).status, 'executed');
  assert.equal(journal.readDecisions().length, 1);
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 95);
});

test('unknown broker outcomes block another account action', async () => {
  const first = entry(true);
  actions.transitionAction(first.id, 'executing');
  const second = actions.createAction({ kind: 'entry', symbol: 'MSFT', venue: 'paper', params: { signal: { ...signal, symbol: 'MSFT' }, qty: 1 }, reason: 'test', timeoutMs: 60000, automatic: true });
  await executor.sweepActions();
  assert.equal(actions.getAction(first.id).status, 'unknown');
  assert.equal(actions.getAction(second.id).status, 'approved');
  assert.equal(placed, 0);
});

test('pause blocks execution and survives a fresh process', async () => {
  const p = entry(true);
  state.updateState({ paused: true });
  await executor.sweepActions();
  assert.equal(placed, 0);
  assert.equal(actions.getAction(p.id).status, 'approved');
  const child = spawnSync(process.execPath, ['-r','ts-node/register','-e', "console.log(require('./src/state/state').getState().paused)"], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /true/);
});

test('expired approval is rejected even before a sweep', () => {
  const p = entry();
  store.saveRecord('actions', p.id, { ...p, expiresAt: Date.now() - 1 });
  assert.throws(() => actions.decideAction(p.id, 'approve', 'human'), /expired/);
  assert.equal(actions.getAction(p.id).status, 'expired');
});

test('an action is not executed after the strategy changed', async () => {
  const p = entry(true);
  store.saveRecord('actions', p.id, { ...p, policyHash: 'changed' });
  await executor.sweepActions();
  assert.equal(actions.getAction(p.id).status, 'failed');
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
  const p = actions.createAction({ kind: 'exit', symbol: 'AAPL', venue: 'paper', params: { qty: 2 }, reason: 'test', timeoutMs: 60000, automatic: true });
  brokerOrder = { id: 'broker-1', symbol: 'AAPL', side: 'sell', qty: 2, filledQty: 0, filledPrice: null, status: 'open' };
  await executor.sweepActions();
  assert.equal(actions.getAction(p.id).status, 'submitted');
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel, 95);
  held = []; brokerOrder = { ...brokerOrder, filledQty: 2, filledPrice: 100, status: 'filled' };
  await executor.sweepActions();
  assert.equal(state.getPositionSnapshot('AAPL'), undefined);
});

test('a filled new entry replaces a stale trade snapshot and protection IDs', async () => {
  state.openPositionSnapshot({symbol:'AAPL',entryPrice:60,stopLevel:50,stopOrderId:'old-stop',openedAt:'2020-01-01T00:00:00Z',entryDecisionId:'old'});
  const p=entry(true);
  brokerOrder={id:'broker-1',symbol:'AAPL',side:'buy',qty:2,filledQty:2,filledPrice:101,status:'filled'};
  await executor.sweepActions();
  const saved=state.getPositionSnapshot('AAPL');
  assert.equal(saved.stopLevel,95);assert.equal(saved.stopOrderId,undefined);assert.equal(saved.entryDecisionId,'action-'+p.id);
});

test('a policy change while validation awaits invalidates the approval', async () => {
  const p=entry(true);
  orders.validateEntry=async(s,q)=>{
    const previous=policy.getPolicySnapshot();
    policy.saveStrategy({...previous.policy,risk:{...previous.policy.risk,maxPositions:2}},previous.hash,'alice');
    return {...s,regimeQty:q};
  };
  await executor.sweepActions();
  assert.equal(placed,0);assert.equal(actions.getAction(p.id).status,'expired');
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

test('pending exits keep their baseline across multiple protection sweeps', async () => {
  const { sweepStops }=require('../src/strategy/stopOrders');
  state.openPositionSnapshot({symbol:'AAPL',stopLevel:95,stopOrderId:'our-stop'});
  const p=actions.createAction({kind:'exit',symbol:'AAPL',venue:'paper',params:{qty:2},reason:'test',timeoutMs:60000,automatic:true});
  actions.transitionAction(p.id,'executing');actions.transitionAction(p.id,'submitted',{result:{orderId:'exit',qty:2}});
  held=[];
  for(let i=0;i<6;i++)await sweepStops();
  assert.equal(state.getPositionSnapshot('AAPL').stopLevel,95);
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
