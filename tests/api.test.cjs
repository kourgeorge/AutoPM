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
test('feed tool lines point at the saved receipt instead of copying its output; the output loads in full from it', async () => {
  const { logger, attachUI } = require('../src/core/logger');
  const input = { symbol: 'FULLPAYLOAD', nested: { text: 'input'.repeat(300) } };
  const output = JSON.stringify({ bars: Array.from({ length: 700 }, (_, i) => ({ close: i, note: 'complete observation' })), end: 'last observation' });
  assert.ok(output.length > 10000);
  const tool = { id: 'full-tool-call', requestId: 'full-tool-request', agent: 'assistant', name: 'get_bars', input, output };
  const feedTool = { id: tool.id, requestId: tool.requestId, agent: tool.agent, name: tool.name, input, failed: false };
  storage.saveRecord('tool-calls', tool.id, { name: tool.name, input, result: output });
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
    assert.deepEqual(live.tool, feedTool);
    assert.equal(live.source, 'assistant');
    storage.closeStorage();
    const tail = (await request('/api/feed?tail=1')).body.entries[0];
    assert.deepEqual(tail.tool, feedTool);
    assert.equal(tail.source, 'assistant');
    const polled = (await request('/api/feed?after=' + (tail.seq - 1))).body.entries[0];
    assert.deepEqual(polled.tool, feedTool);
    assert.deepEqual((await request('/api/tool-output/' + tool.id)).body, { input, output });
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
});
test('a request trail includes the agent conversation, with tool results left as receipt marks',async()=>{
  const id='trail-request';
  storage.saveRecord('requests',id,{id,role:'trader',actorId:'operator',text:'Check AAPL',status:'completed',createdAt:new Date().toISOString()});
  const messages=[{role:'user',content:[{type:'text',text:'briefing'}]},
    {role:'assistant',content:[{type:'text',text:'I will look at the chart because the stop is close.'},{type:'tool_use',id:'tu1',name:'get_bars',input:{symbol:'AAPL'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'tu1',receiptId:id+':1:0',content:'[Saved as receipt]'}]}];
  storage.saveRecord('trajectories',id,{id,messages,rounds:2,status:'completed',inTokens:10,outTokens:5,text:'done'});
  const body=(await request('/api/agent-requests/'+id)).body;
  assert.deepEqual(body.trajectory.messages,messages);
});
test('missing holdings and orders are unavailable rather than an empty portfolio',async()=>{
  const headers={};
  recordTick({positions:{},positionsStale:true,positionsError:'Broker timeout',ordersStale:true,orders:[],account:{equity:null},portfolio:{},watchlist:{},tickAt:new Date().toISOString()});
  const positions=(await request('/api/positions',undefined,headers)).body;
  const orders=(await request('/api/broker-orders',undefined,headers)).body;
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
  assert.equal(result.body.output[0].source,'system','slash-command output is not an assistant reply');
  const audit=storage.readRecords('alerts').filter(e=>e.kind==='operator_command').at(-1);
  assert.equal(audit.handledBy,'operator');assert.equal(audit.evidence.command,'lessons');assert.equal(audit.evidence.args,'3');
  const help=await request('/api/commands/%3F',{},operator);
  assert.match(help.body.output[0].text,/\/lessons \[n\]/);
  assert.doesNotMatch(help.body.output[0].text,/quit/);
  for(const name of ['quit','missing','approve'])assert.equal((await request('/api/commands/'+name,{},operator)).res.status,404);
  assert.equal((await request('/api/commands/lessons',{args:42},operator)).res.status,400);
  assert.equal((await request('/api/commands/lessons',{args:'x'.repeat(4001)},operator)).res.status,400);
  assert.equal((await request('/api/messages',{text:'/lessons 3'},operator)).res.status,400);
  assert.equal(require('../src/core/requests').listRequests().length,before,'slash commands bypass the assistant queue');
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
  const {createOrder,decideOrder}=require('../src/core/orders');
  const {recordFills}=require('../src/review/fills');
  const hold=recordDecision(decision('hold','trader',{symbol:'HISTORY',rationale:'Wait for a clearer signal'}));
  const action=createOrder({kind:'entry',symbol:'HISTORY',venue:'paper',params:{qty:3},reason:'History proposal',timeoutMs:60000});
  decideOrder(action.id,'reject','human','Exposure too high');
  const fill={execId:'history-exec.01',brokerOrderId:'history-order',permId:null,symbol:'HISTORY',side:'buy',qty:1,price:100,fee:null,at:'2026-10-08T12:00:00Z'};
  recordFills([fill,{...fill,execId:'history-exec.02',qty:2,price:101}]);
  storage.closeStorage();
  const history=(await request('/api/activity-history?q=HISTORY&limit=2')).body;
  assert.equal(history.total,3);assert.equal(history.entries.length,2);
  const page2=(await request('/api/activity-history?q=HISTORY&limit=2&offset=2')).body;
  const entries=[...history.entries,...page2.entries];
  assert.equal(new Set(entries.map(e=>e.id)).size,3);
  assert.ok(entries.some(e=>e.record.id===hold.id && e.status==='no action'));
  const proposal=entries.find(e=>e.record.orderId===action.id);
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
  const awaiting={...make('stop_breach','2026-10-08T12:02:00Z'),handling:'order_pending',orderId:'not-reconciled-by-history'};
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
  assert.equal(events.find(event=>event.record.id===awaiting.id).status,'order pending');
  assert.equal(events.find(event=>event.record.id===fresh.id).status,'unreviewed');
  assert.deepEqual(storage.readValue('eventRegistry'),registry,'reading history must not reconcile or acknowledge queued events');
  const filtered=(await request('/api/activity-history?type=event&q=Position%20already%20closed')).body;
  assert.equal(filtered.total,1);assert.equal(filtered.entries[0].record.id,resolved.id);
});

test('broker exit labels distinguish a reconciled fill from an outcome with no matching fill',async()=>{
  const {recordDecision,decision}=require('../src/journal/journal');
  const {recordFills}=require('../src/review/fills');
  const confirmed=recordDecision(decision('exit','broker',{symbol:'RECONLABEL',executed:true,qty:5,price:1159.8,brokerOrderId:'reconciled-exit',rationale:'Closed at the venue — reconciled from fills.'}));
  const unmatched=recordDecision(decision('exit','broker',{symbol:'RECONLABEL',executed:true,qty:5,price:1159.8,brokerOrderId:'no-fill',rationale:'Previously recorded outcome'}));
  recordFills([{execId:'recon-label-fill',brokerOrderId:'reconciled-exit',permId:null,symbol:'RECONLABEL',side:'sell',qty:5,price:1159.8,fee:null,at:'2026-10-08T14:01:07Z'}]);
  const history=(await request('/api/activity-history?type=decision&q=RECONLABEL')).body;
  assert.equal(history.entries.find(entry=>entry.record.id===confirmed.id).status,'reconciled fill');
  assert.equal(history.entries.find(entry=>entry.record.id===unmatched.id).status,'recorded outcome');
});

test('the assistant can read every dashboard page in-process, read-only',async()=>{
  const {appEndpoints,readAppEndpoint}=require('../src/server/api');
  const list=appEndpoints();
  assert.equal(list.available,true);
  const paths=list.endpoints.map(e=>e.path);
  assert.ok(paths.includes('/api/llm-usage')&&paths.includes('/api/broker-orders'));
  assert.ok(!paths.includes('/api/stream'),'the live stream never ends, so it is not offered');
  assert.ok(list.endpoints.every(e=>e.returns!=='No description.'),'every readable page says what it returns');
  const usage=await readAppEndpoint('/api/llm-usage?days=7');
  assert.deepEqual(usage,(await request('/api/llm-usage?days=7')).body);
  assert.equal((await readAppEndpoint('/api/llm-usage?days=0')).status,400);
  assert.match((await readAppEndpoint('/api/nothing')).error,/No route GET/);
  assert.match((await readAppEndpoint('/api/stream')).error,/live stream/);
});
test('ticker metrics place the price in its 52-week range and keep each data source independent',async()=>{
  const collector=require('../src/collect/barSource'),yahoo=require('../src/collect/yahoo'),fundamentals=require('../src/collect/fundamentals');
  const original=[collector.collectBars,yahoo.getAnalystRaw,fundamentals.getFundamentals];
  const day=Date.parse('2025-10-01T00:00:00Z'),bars=Array.from({length:260},(_,i)=>{const c=100+i*0.2;return{t:new Date(day+i*86400000).toISOString(),o:c,h:c+1,l:c-1,c,v:1000+i};});
  try {
    collector.collectBars=async()=>({value:bars,source:'alpaca',stale:false,fetchedAt:new Date().toISOString(),asOf:bars.at(-1).t});
    yahoo.getAnalystRaw=async()=>({financialData:{targetMeanPrice:180,targetLowPrice:120,targetHighPrice:220,recommendationMean:2.1,recommendationKey:'buy',numberOfAnalystOpinions:12},recommendationTrend:{trend:[{period:'0m',strongBuy:3,buy:5,hold:3,sell:1,strongSell:0}]},summaryDetail:{trailingPE:25,dividendYield:0.012},defaultKeyStatistics:{}});
    fundamentals.getFundamentals=async()=>{throw new Error('yahoo down');};
    assert.equal((await request('/api/ticker-metrics?symbol=%3Cx%3E')).res.status,400);
    const m=(await request('/api/ticker-metrics?symbol=metricstest')).body;
    assert.equal(m.symbol,'METRICSTEST');assert.equal(m.price,151.8);assert.equal(m.priceSource,'close');
    assert.equal(m.range52w.sessions,252);assert.equal(m.range52w.source,'bars');
    assert.ok(m.range52w.positionPct>98 && m.range52w.positionPct<=100,'a steady climb sits near the top of its range');
    assert.ok(m.returns['1M']>0 && m.returns['1Y']>0);
    assert.equal(m.indicatorSource,'bars');assert.equal(m.trend.signals.length,5);assert.ok(m.momentum.rsi>50);
    assert.equal(m.analysts.targetMean,180);assert.equal(m.analysts.ratings.buy,5);assert.equal(m.analysts.valuation.dividendYieldPct,1.2);
    assert.equal(m.fundamentals,null);assert.deepEqual(m.errors,['Company fundamentals are unavailable.']);
  } finally {[collector.collectBars,yahoo.getAnalystRaw,fundamentals.getFundamentals]=original;}
});
test('a reconnecting stream that replays a large backlog does not crash the server',async()=>{
  const ui=new HeadlessUI(),own=startApiServer({ui,trader:{status:{paused:false}},serveWeb:false});
  await new Promise(resolve=>setTimeout(resolve,30));
  const port=own.address().port,big='x'.repeat(5000);
  ui.reply('before the backlog');const from=ui.feedAfter(-1,5000).at(-1).seq;
  for(let i=0;i<300;i++)ui.reply(`backlog ${i} ${big}`);
  const crashes=[],onError=e=>crashes.push(e);process.on('uncaughtException',onError);
  try {
    // Ask for everything after the line before the backlog, then read slowly so the socket buffer fills mid-replay.
    const socket=require('node:net').connect(port,'127.0.0.1');
    await new Promise(resolve=>socket.once('connect',resolve));
    socket.write(`GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nLast-Event-ID: ${from}\r\n\r\n`);
    let received='';socket.on('data',d=>{received+=d;});socket.pause();
    await new Promise(resolve=>setTimeout(resolve,300));
    ui.reply('after the replay');socket.resume();
    await new Promise(resolve=>setTimeout(resolve,800));socket.destroy();
    assert.deepEqual(crashes,[]);assert.match(received,/backlog 299/);assert.match(received,/after the replay/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status,200,'the server still answers');
  } finally {process.off('uncaughtException',onError);await own.close();}
});
test('AI model and key can be changed from settings, apply to the next call, and the key is never returned',async()=>{
  const {activeAiConfig}=require('../src/core/aiConnection');
  const {createLiveModelProvider}=require('../src/core/modelProvider');
  const start=(await request('/api/settings/ai-connection')).body;
  assert.equal(start.provider,'ollama');assert.equal(start.server,config.ai.baseUrl??'http://localhost:11434/v1');
  assert.equal(start.modelSource,'env');assert.equal(start.keySource,'env');
  const saved=(await request('/api/settings/ai-connection',{model:'llama-test',apiKey:'secret-key-1234'})).body;
  assert.equal(saved.model,'llama-test');assert.equal(saved.modelSource,'settings');assert.equal(saved.keyHint,'••••1234');
  assert.ok(!JSON.stringify(saved).includes('secret-key'),'the key never leaves the engine');
  assert.equal(activeAiConfig().apiKey,'secret-key-1234');
  // The live provider sends the newly saved model and key on its next call.
  const seen=[],realFetch=global.fetch;
  global.fetch=async(url,init)=>{seen.push({model:JSON.parse(init.body).model,auth:init.headers.Authorization});return new Response(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}),{status:200});};
  try {
    const provider=createLiveModelProvider();
    await provider.chat({systemPrompt:'t',messages:[],tools:[],maxTokens:5});
    storage.saveValue('aiConnection',{model:'llama-next'});
    await provider.chat({systemPrompt:'t',messages:[],tools:[],maxTokens:5});
  } finally { global.fetch=realFetch; }
  assert.deepEqual(seen,[{model:'llama-test',auth:'Bearer secret-key-1234'},{model:'llama-next',auth:'Bearer test'}]);
  assert.equal((await request('/api/settings/ai-connection',{model:'has space'})).res.status,400);
  const reset=(await request('/api/settings/ai-connection',{model:null,apiKey:null})).body;
  assert.equal(reset.modelSource,'env');assert.equal(reset.keySource,'env');assert.equal(reset.model,start.model);
});
