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
  assert.equal((await request('/api/status')).res.status,200);
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
