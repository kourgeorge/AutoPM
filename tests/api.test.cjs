const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(),'autotrade-api-')), AI_PROVIDER:'ollama', AI_API_KEY:'test', HEADLESS:'1', BROKER:'alpaca' });
require('ts-node/register');
const { config } = require('../src/core/config'); config.api.port = 0;
const { HeadlessUI } = require('../src/ui/headless');
const { startApiServer } = require('../src/server/api');
const storage = require('../src/core/storage');
const policy = require('../src/policy/load');
const state = require('../src/state/state');
const { recordTick } = require('../src/features/lastTick');
const nativeFetch = global.fetch;
global.fetch = (...args) => { if (!String(args[0]).startsWith('http://127.0.0.1:')) throw new Error('External network disabled'); return nativeFetch(...args); };
let server, base;
before(async () => {
  policy.loadPolicy(); state.updateState({accountId:'alpaca:paper:test'});
  const ui = new HeadlessUI();
  ui.registerCommand({name:'pause',api:true,help:'Pause',run:()=>state.updateState({paused:true})});
  ui.registerCommand({name:'lessons',api:true,aliases:['learn'],args:'[n]',help:'Recent lessons',run:args=>ui.reply('Lessons: '+args)});
  ui.registerCommand({name:'quit',help:'Local only',run:()=>assert.fail('Local commands must never run through the API')});
  server = startApiServer({ui,trader:{status:{paused:false}}});
  await new Promise(resolve=>setTimeout(resolve,30));
  base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await server?.close();storage.closeStorage();});
async function request(route, body, headers={}) {
  const res=await fetch(base+route,{headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  return {res,body:await res.json()};
}
test('the dashboard opens without a login',async()=>{
  assert.equal((await fetch(base+'/')).status,200);
  const icon=await fetch(base+'/favicon.svg');
  assert.equal(icon.status,200);assert.equal(icon.headers.get('content-type'),'image/svg+xml');
  assert.equal((await request('/api/status')).res.status,200);
});
test('tool exchanges retain complete input and output in history, polling and live events', async () => {
  const { logger, attachUI } = require('../src/core/logger');
  const input = { symbol: 'FULLPAYLOAD', nested: { text: 'input'.repeat(300) } };
  const output = JSON.stringify({ bars: Array.from({ length: 700 }, (_, i) => ({ close: i, note: 'complete observation' })), end: 'last observation' });
  assert.ok(output.length > 10000);
  const tool = { id: 'full-tool-call', requestId: 'full-tool-request', agent: 'concierge', name: 'get_bars', input, output };
  const controller = new AbortController();
  const stream = await fetch(base + '/api/stream', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
  const reader = stream.body.getReader();
  try {
    attachUI(new HeadlessUI());
    logger.tool(tool.agent, tool.name, output, input, { id: tool.id, requestId: tool.requestId });
    let received = '';
    const decoder = new TextDecoder();
    while (!received.includes('event: feed\n')) { const chunk = await reader.read();assert.equal(chunk.done, false);received += decoder.decode(chunk.value, { stream: true }); }
    while (!received.includes('\n\n', received.indexOf('event: feed\n'))) { const chunk = await reader.read();assert.equal(chunk.done, false);received += decoder.decode(chunk.value, { stream: true }); }
    const live = JSON.parse(received.split('\n').find(line => line.startsWith('data: ')).slice(6));
    assert.deepEqual(live.tool, tool);
    assert.equal(live.source, 'concierge');
    storage.closeStorage();
    const tail = (await request('/api/feed?tail=1')).body.entries[0];
    assert.deepEqual(tail.tool, tool);
    assert.equal(tail.source, 'concierge');
    const polled = (await request('/api/feed?after=' + (tail.seq - 1))).body.entries[0];
    assert.deepEqual(polled.tool, tool);
    assert.ok(tail.text.length < output.length, 'compact log text does not replace the full payload');
  } finally { attachUI(null);controller.abort();await reader.cancel().catch(() => {}); }
});
test('only this computer can use the API: other host names and other sites are refused',async()=>{
  const http=require('node:http');
  const viaOtherName=await new Promise((resolve,reject)=>http.get(base+'/api/status',{headers:{Host:'attacker.example:'+server.address().port}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(viaOtherName,403);
  assert.equal((await request('/api/commands/pause',{},{Origin:'https://wrong.example'})).res.status,403);
  assert.equal(state.getState().paused,false);
  assert.equal((await request('/api/commands/pause',{},{Origin:base})).res.status,200);
  assert.equal(state.getState().paused,true);
});
test('structured strategy saves are atomic, validate ceilings, and reject stale revisions',async()=>{
  const headers={};
  const old=(await request('/api/strategy',undefined,headers)).body;
  const changed=structuredClone(old.policy);changed.risk.maxPositions=2;
  const saved=await request('/api/strategy',{policy:changed,expectedHash:old.hash},headers);
  assert.equal(saved.res.status,200);assert.notEqual(saved.body.hash,old.hash);
  assert.equal((await request('/api/strategy',{policy:old.policy,expectedHash:old.hash},headers)).res.status,409);
  changed.risk.positionSizePct=1;
  assert.equal((await request('/api/strategy',{policy:changed,expectedHash:saved.body.hash},headers)).res.status,400);
  policy.loadPolicy();assert.equal(policy.getPolicy().risk.maxPositions,2);
  assert.equal(storage.readRecords('strategy-changes').length,1);
});
test('missing holdings and orders are unavailable rather than an empty portfolio',async()=>{
  const headers={};
  recordTick({positions:{},positionsStale:true,positionsError:'Broker timeout',ordersStale:true,orders:[],account:{equity:null},portfolio:{},watchlist:{},tickAt:new Date().toISOString()});
  const positions=(await request('/api/positions',undefined,headers)).body;
  const orders=(await request('/api/orders',undefined,headers)).body;
  assert.equal(positions.available,false);assert.equal(positions.positions,null);
  assert.equal(orders.available,false);assert.equal(orders.orders,null);
});
test('chat receipts record the operator and lessons can be reviewed',async()=>{
  const operator={};
  const receipt=await request('/api/messages',{text:'Review my managed holdings'},operator);
  assert.equal(receipt.res.status,200);
  const command=require('../src/core/requests').getRequest(receipt.body.requestId);
  assert.equal(command.actorId,'operator');assert.equal(command.status,'queued');
  const lessons=require('../src/journal/lessons');lessons.recordLesson('Operator observation.');
  const lesson=lessons.listLessons()[0];
  assert.equal((await request('/api/lessons/'+lesson.id,{text:'Reviewed observation.',active:false},operator)).res.status,200);
  assert.equal(lessons.listLessons()[0].active,false);
});
test('command discovery and execution share an explicit registry, preserve aliases and audit the operator',async()=>{
  const operator={};
  const commands=(await request('/api/commands',undefined,operator)).body.commands;
  assert.deepEqual(commands.map(c=>c.name),['help','pause','lessons']);
  assert.deepEqual(commands.find(c=>c.name==='lessons'),{name:'lessons',aliases:['learn'],args:'[n]',help:'Recent lessons'});
  const before=require('../src/core/requests').listRequests().length;
  const result=await request('/api/commands/LEARN',{args:'3'},operator);
  assert.equal(result.res.status,200);assert.equal(result.body.ok,true);
  assert.equal(result.body.output[0].text,'Lessons: 3');
  assert.equal(result.body.output[0].source,'system','slash-command output is not a concierge reply');
  const audit=storage.readRecords('operator-commands').at(-1);
  assert.equal(audit.actorId,'operator');assert.equal(audit.action,'lessons');assert.equal(audit.args,'3');
  const help=await request('/api/commands/%3F',{},operator);
  assert.match(help.body.output[0].text,/\/lessons \[n\]/);
  assert.doesNotMatch(help.body.output[0].text,/quit/);
  for(const name of ['quit','missing','approve'])assert.equal((await request('/api/commands/'+name,{},operator)).res.status,404);
  assert.equal((await request('/api/commands/lessons',{args:42},operator)).res.status,400);
  assert.equal((await request('/api/commands/lessons',{args:'x'.repeat(4001)},operator)).res.status,400);
  assert.equal((await request('/api/messages',{text:'/lessons 3'},operator)).res.status,400);
  assert.equal(require('../src/core/requests').listRequests().length,before,'slash commands bypass the concierge queue');
});
test('account information is saved in settings.json and everything else in state.json',()=>{
  const db=path.join(process.env.DATA_DIR,'db');
  storage.saveValue('account',{id:'alpaca:paper:split-check'});storage.saveValue('modelUsage:split-check',{requests:1});
  const settings=JSON.parse(fs.readFileSync(path.join(db,'settings.json'),'utf8')),appState=JSON.parse(fs.readFileSync(path.join(db,'state.json'),'utf8'));
  assert.equal(settings.account.id,'alpaca:paper:split-check');assert.equal(settings['modelUsage:split-check'],undefined);
  assert.deepEqual(appState['modelUsage:split-check'],{requests:1});assert.equal(appState.account,undefined);
});


test('ticker history validates requests, coalesces reads, and preserves OHLC provenance',async()=>{
  const collector=require('../src/collect/barSource'),original=collector.collectBars;
  let calls=0;
  collector.collectBars=async(symbol,limit,timeframe)=>{
    calls++;assert.equal(symbol,'CHARTTEST');assert.equal(limit,120);assert.equal(timeframe,'1Hour');
    await new Promise(resolve=>setTimeout(resolve,20));
    return {source:'alpaca',asOf:'2026-10-07T14:00:00Z',fetchedAt:'2026-10-07T14:20:00Z',stale:true,value:[
      {t:'2026-10-07T14:00:00Z',o:101,h:105,l:100,c:104,v:1200},
      {t:'2026-10-07T13:00:00Z',o:100,h:102,l:99,c:101,v:1000},
      {t:'2026-10-07T12:00:00Z',o:100,h:98,l:99,c:101,v:1000},
      {t:'bad',o:100,h:102,l:99,c:101,v:1000},
      {t:'2026-10-07T13:00:00Z',o:100,h:103,l:99,c:102,v:1500}
    ]};
  };
  try {
    for(const query of ['symbol=%3Cscript%3E','symbol=AAPL&timeframe=1Second','symbol='])assert.equal((await request('/api/price-history?'+query)).res.status,400);
    assert.equal(calls,0);
    const results=await Promise.all([request('/api/price-history?symbol=charttest&timeframe=1Hour'),request('/api/price-history?symbol=CHARTTEST&timeframe=1Hour')]);
    assert.equal(calls,1);
    const result=results[0].body;assert.equal(result.available,true);assert.equal(result.stale,true);assert.equal(result.source,'alpaca');assert.equal(result.bars.length,2);
    assert.equal(result.bars[0].c,102);assert.equal(result.bars[1].c,104);assert.equal(result.asOf,'2026-10-07T14:00:00Z');
    await request('/api/price-history?symbol=CHARTTEST&timeframe=1Hour');assert.equal(calls,1);
  } finally {collector.collectBars=original;}
});
test('unavailable ticker history stays unavailable without synthetic candles or provider details',async()=>{
  const collector=require('../src/collect/barSource'),original=collector.collectBars;
  try {
    collector.collectBars=async()=>({value:null,source:'alpaca',stale:true,error:'private provider error'});
    const missing=(await request('/api/price-history?symbol=NOCHART')).body;
    assert.equal(missing.available,false);assert.deepEqual(missing.bars,[]);assert.doesNotMatch(missing.error,/private provider/);
    collector.collectBars=async()=>{throw new Error('private provider error');};
    const failed=(await request('/api/price-history?symbol=FAILEDCHART')).body;
    assert.equal(failed.available,false);assert.deepEqual(failed.bars,[]);assert.doesNotMatch(failed.error,/private provider/);
  } finally {collector.collectBars=original;}
});

test('activity history includes durable decisions, action transitions and corrected fills with pagination',async()=>{
  const {recordDecision,decision}=require('../src/journal/journal');
  const {createAction,decideAction}=require('../src/core/actions');
  const {recordFills}=require('../src/review/fills');
  const hold=recordDecision(decision('hold','trader',{symbol:'HISTORY',rationale:'Wait for a clearer signal'}));
  const action=createAction({kind:'entry',symbol:'HISTORY',venue:'paper',params:{qty:3},reason:'History proposal',timeoutMs:60000});
  decideAction(action.id,'reject','human','Exposure too high');
  const fill={execId:'history-exec.01',orderId:'history-order',permId:null,symbol:'HISTORY',side:'buy',qty:1,price:100,fee:null,at:'2026-10-08T12:00:00Z'};
  recordFills([fill,{...fill,execId:'history-exec.02',qty:2,price:101}]);
  storage.closeStorage();
  const history=(await request('/api/activity-history?q=HISTORY&limit=2')).body;
  assert.equal(history.total,3);assert.equal(history.entries.length,2);
  const page2=(await request('/api/activity-history?q=HISTORY&limit=2&offset=2')).body;
  const entries=[...history.entries,...page2.entries];
  assert.equal(new Set(entries.map(e=>e.id)).size,3);
  assert.ok(entries.some(e=>e.record.id===hold.id && e.status==='no action'));
  const proposal=entries.find(e=>e.record.actionId===action.id);
  assert.equal(proposal.status,'rejected');assert.equal(proposal.action.rejectReason,'Exposure too high');
  assert.deepEqual(proposal.transitions.map(e=>e.transition),['created','rejected']);
  const fills=(await request('/api/activity-history?type=fill&q=HISTORY')).body.entries;
  assert.equal(fills.length,1);assert.equal(fills[0].record.execId,'history-exec.02');
  assert.equal(fills[0].record.qty,2);assert.equal(fills[0].record.fee,null);
  assert.equal((await request('/api/activity-history?q=unfindable-history')).body.total,0);
  assert.equal((await request('/api/activity-history?type=oops')).res.status,400);
  assert.equal((await request('/api/activity-history?offset=-1')).res.status,400);
});

test('event history retains handled events, merges escalations and shows queue state without handling events',async()=>{
  const {appendAlertLog,recordAlertHandling}=require('../src/features/alertLog');
  const make=(kind,at)=>({id:`${kind}:EVENTHISTORY:${at}`,kind,symbol:'EVENTHISTORY',firedAt:at,severity:'urgent',headline:`EVENTHISTORY ${kind}`,evidence:{price:109.78},policyVersion:47,cooldownKey:`${kind}:EVENTHISTORY`,suggestedAction:'review',ackedAt:null,ackDisposition:null,ackNote:null,wakeCount:1});
  const observed=make('entry_signal','2026-10-08T12:00:00Z');
  appendAlertLog(observed);appendAlertLog({...observed,wakeCount:2});
  const current={...observed,wakeCount:2,handling:'observed',ackDisposition:'acknowledged',ackNote:'Reviewed; still monitoring'};
  recordAlertHandling(current);
  const resolved={...make('position_drop','2026-10-08T12:01:00Z'),handling:'resolved',ackedAt:'2026-10-08T12:05:00Z',ackDisposition:'acknowledged',ackNote:'Position already closed'};
  appendAlertLog(resolved);
  const awaiting={...make('stop_breach','2026-10-08T12:02:00Z'),handling:'action_pending',actionId:'not-reconciled-by-history'};
  appendAlertLog(awaiting);
  const fresh=make('heartbeat','2026-10-08T12:03:00Z');appendAlertLog(fresh);
  const registry={pending:[current,awaiting,fresh],live:[current,awaiting,fresh]};
  storage.saveValue('eventRegistry',registry);storage.closeStorage();
  const first=(await request('/api/activity-history?type=event&q=EVENTHISTORY&limit=2')).body;
  const second=(await request('/api/activity-history?type=event&q=EVENTHISTORY&limit=2&offset=2')).body;
  assert.equal(first.total,4);assert.equal(first.entries.length,2);
  const events=[...first.entries,...second.entries];
  assert.equal(new Set(events.map(event=>event.id)).size,4);
  assert.deepEqual(events.map(event=>event.at),[fresh.firedAt,awaiting.firedAt,resolved.firedAt,current.firedAt]);
  assert.equal(events.find(event=>event.record.id===current.id).queued,true);
  assert.equal(events.find(event=>event.record.id===current.id).status,'observed');
  assert.equal(events.find(event=>event.record.id===current.id).record.wakeCount,2);
  assert.equal(events.find(event=>event.record.id===resolved.id).queued,false);
  assert.equal(events.find(event=>event.record.id===resolved.id).status,'resolved');
  assert.equal(events.find(event=>event.record.id===awaiting.id).status,'action pending');
  assert.equal(events.find(event=>event.record.id===fresh.id).status,'unreviewed');
  assert.deepEqual(storage.readValue('eventRegistry'),registry,'reading history must not reconcile or acknowledge queued events');
  const filtered=(await request('/api/activity-history?type=event&q=Position%20already%20closed')).body;
  assert.equal(filtered.total,1);assert.equal(filtered.entries[0].record.id,resolved.id);
});

test('broker exit labels distinguish a reconciled fill from an outcome with no matching fill',async()=>{
  const {recordDecision,decision}=require('../src/journal/journal');
  const {recordFills}=require('../src/review/fills');
  const confirmed=recordDecision(decision('exit','broker',{symbol:'RECONLABEL',executed:true,qty:5,price:1159.8,orderId:'reconciled-exit',rationale:'Closed at the venue — reconciled from fills.'}));
  const unmatched=recordDecision(decision('exit','broker',{symbol:'RECONLABEL',executed:true,qty:5,price:1159.8,orderId:'no-fill',rationale:'Previously recorded outcome'}));
  recordFills([{execId:'recon-label-fill',orderId:'reconciled-exit',permId:null,symbol:'RECONLABEL',side:'sell',qty:5,price:1159.8,fee:null,at:'2026-10-08T14:01:07Z'}]);
  const history=(await request('/api/activity-history?type=decision&q=RECONLABEL')).body;
  assert.equal(history.entries.find(entry=>entry.record.id===confirmed.id).status,'reconciled fill');
  assert.equal(history.entries.find(entry=>entry.record.id===unmatched.id).status,'recorded outcome');
});
