const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(),'autotrade-api-')), AI_PROVIDER:'ollama', AI_API_KEY:'test', HEADLESS:'1', BROKER:'alpaca', API_TOKEN:'internal-test-token-with-32-characters', API_VIEWER_TOKEN:'read-only-test-token-with-32-characters' });
require('ts-node/register');
const { config } = require('../src/core/config'); config.api.port = 0;
const { HeadlessUI } = require('../src/ui/headless');
const { startApiServer } = require('../src/server/api');
const auth = require('../src/server/auth');
const storage = require('../src/core/storage');
const policy = require('../src/policy/load');
const state = require('../src/state/state');
const { recordTick } = require('../src/features/lastTick');
const nativeFetch = global.fetch;
global.fetch = (...args) => { if (!String(args[0]).startsWith('http://127.0.0.1:')) throw new Error('External network disabled'); return nativeFetch(...args); };
let server, base;
before(async () => {
  policy.loadPolicy(); state.updateState({accountId:'alpaca:paper:test'});
  auth.setUser('alice','admin','test-password-at-least-16-chars');
  auth.setUser('reader','viewer','test-password-at-least-16-chars');
  const ui = new HeadlessUI();
  ui.registerCommand({name:'pause',help:'Pause',run:()=>state.updateState({paused:true})});
  server = startApiServer({ui,trader:{status:{paused:false}}});
  await new Promise(resolve=>setTimeout(resolve,30));
  base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await server?.close();storage.closeStorage();});
async function request(route, body, headers={}) {
  const res=await fetch(base+route,{headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  return {res,body:await res.json()};
}
async function signIn(username) {
  const {res,body}=await request('/api/login',{username,password:'test-password-at-least-16-chars'});
  assert.equal(res.status,200);return {Cookie:res.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':body.csrf};
}
test('dashboard is public but account data is private; readiness differs from liveness',async()=>{
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await request('/api/status')).res.status,401);
  assert.equal((await request('/health')).res.status,200);
  assert.equal((await request('/ready')).res.status,503);
});
test('viewer sessions and viewer tokens cannot mutate the account',async()=>{
  const viewer=await signIn('reader');
  assert.equal((await request('/api/status',undefined,viewer)).res.status,200);
  assert.equal((await request('/api/commands/pause',{},viewer)).res.status,403);
  assert.equal((await request('/api/commands/pause',{}, {Authorization:'Bearer '+config.api.viewerToken})).res.status,403);
});
test('browser mutations require CSRF and same origin; password rotation revokes sessions',async()=>{
  const admin=await signIn('alice');
  assert.equal((await request('/api/commands/pause',{}, {Cookie:admin.Cookie})).res.status,403);
  assert.equal((await request('/api/commands/pause',{}, {...admin,Origin:'https://wrong.example'})).res.status,403);
  assert.equal((await request('/api/commands/pause',{}, admin)).res.status,200);
  assert.equal(state.getState().paused,true);
  auth.setUser('alice','admin','a-different-password-at-least-16');
  assert.equal((await request('/api/session',undefined,admin)).res.status,401);
});
test('structured strategy saves are atomic, validate ceilings, and reject stale revisions',async()=>{
  const headers={Authorization:'Bearer '+config.api.token};
  const old=(await request('/api/strategy',undefined,headers)).body;
  const changed=structuredClone(old.policy);changed.risk.maxPositions=2;
  const saved=await request('/api/strategy',{policy:changed,expectedHash:old.hash},headers);
  assert.equal(saved.res.status,200);assert.notEqual(saved.body.hash,old.hash);
  assert.equal((await request('/api/strategy',{policy:old.policy,expectedHash:old.hash},headers)).res.status,409);
  changed.risk.positionSizePct=1;
  assert.equal((await request('/api/strategy',{policy:changed,expectedHash:saved.body.hash},headers)).res.status,400);
  policy.loadPolicy();assert.equal(policy.getPolicy().risk.maxPositions,2);
  assert.equal(storage.readRecords('strategy').length,1);
});
test('missing holdings and orders are unavailable rather than an empty portfolio',async()=>{
  const headers={Authorization:'Bearer '+config.api.token};
  recordTick({positions:{},positionsStale:true,positionsError:'Broker timeout',ordersStale:true,orders:[],account:{equity:null},portfolio:{},watchlist:{},tickAt:new Date().toISOString()});
  const positions=(await request('/api/positions',undefined,headers)).body;
  const orders=(await request('/api/orders',undefined,headers)).body;
  assert.equal(positions.available,false);assert.equal(positions.positions,null);
  assert.equal(orders.available,false);assert.equal(orders.orders,null);
});
test('chat receipts retain the authenticated actor and lesson changes require an administrator',async()=>{
  auth.setUser('bob','operator','test-password-at-least-16-chars');
  const operator=await signIn('bob');
  const receipt=await request('/api/messages',{text:'Review my managed holdings'},operator);
  assert.equal(receipt.res.status,200);
  const command=require('../src/core/commands').getCommand(receipt.body.commandId);
  assert.equal(command.actorId,'bob');assert.equal(command.status,'queued');
  const lessons=require('../src/journal/lessons');lessons.recordLesson('Operator observation.');
  const lesson=lessons.listLessons()[0];
  assert.equal((await request('/api/lessons/'+lesson.id,{text:'Updated',active:false},operator)).res.status,403);
  const admin={Authorization:'Bearer '+config.api.token};
  assert.equal((await request('/api/lessons/'+lesson.id,{text:'Reviewed observation.',active:false},admin)).res.status,200);
  assert.equal(lessons.listLessons()[0].active,false);
});
test('malformed legacy state and history stop import without deleting evidence',()=>{
  storage.database().exec("DELETE FROM settings WHERE key='state'");
  const file=path.join(process.env.DATA_DIR,'state.json');fs.writeFileSync(file,'{broken');
  assert.throws(()=>state.getState());assert.equal(fs.readFileSync(file,'utf8'),'{broken');
  const log=path.join(process.env.DATA_DIR,'broken.jsonl');fs.writeFileSync(log,'{"id":"ok"}\n{broken\n');
  assert.throws(()=>storage.importJsonLines('broken',log),/invalid JSON/);
  assert.deepEqual(storage.readRecords('broken'),[]);
});
