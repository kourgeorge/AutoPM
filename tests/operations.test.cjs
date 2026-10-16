const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {test,after}=require('node:test');
Object.assign(process.env,{DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'autotrade-ops-')),AI_PROVIDER:'ollama',AI_API_KEY:'test',HEADLESS:'1',BROKER:'alpaca',AI_MAX_REQUESTS_PER_DAY:'2'});
require('ts-node/register');
const storage=require('../src/core/storage');
const state=require('../src/state/state');
const policy=require('../src/policy/load');
after(()=>storage.closeStorage());
test('model request budget is durable and shared across provider instances',async()=>{
  const {withModelBudget,modelUsage}=require('../src/core/modelBudget');let calls=0;
  const provider=()=>withModelBudget({chat:async()=>{calls++;return {content:[],stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5}};}});
  const params={systemPrompt:'test',messages:[],tools:[],maxTokens:10};
  await Promise.all([provider().chat(params),provider().chat(params)]);
  await assert.rejects(()=>provider().chat(params),/budget reached/);
  assert.equal(calls,2);assert.equal(modelUsage().inputTokens,20);
});
test('backtests use unique account-owned job paths',()=>{
  const {newJobDirectory}=require('../src/core/jobs');
  const one=newJobDirectory('backtest'),two=newJobDirectory('backtest');
  assert.notEqual(one,two);assert.equal(one.startsWith(process.env.DATA_DIR),true);assert.equal(fs.existsSync(path.join(one,'job.json')),true);
});
test('daily per-agent token counts persist without assigning legacy usage to an agent',async()=>{
  const {withModelBudget,modelUsage}=require('../src/core/modelBudget');
  const {agentContext}=require('../src/core/agentContext');
  const previous=process.env.AI_MAX_REQUESTS_PER_DAY;process.env.AI_MAX_REQUESTS_PER_DAY='20';
  const day=new Date().toISOString().slice(0,10);
  storage.saveValue('modelUsage',{day,requests:2,inputTokens:100,outputTokens:20,missingUsage:0});
  try {
    const provider=withModelBudget({chat:async params=>({content:[],stopReason:'end_turn',usage:{inputTokens:params.maxTokens,outputTokens:5}})});
    await Promise.all(['trader','assistant'].map((role,i)=>agentContext.run({role,actorId:'test',requestId:role},()=>provider.chat({systemPrompt:'test',messages:[],tools:[],maxTokens:10+i}))));
    storage.closeStorage();
    const usage=modelUsage();
    assert.equal(usage.inputTokens,121);assert.equal(usage.outputTokens,30);
    assert.deepEqual(usage.byAgent.trader,{requests:1,inputTokens:10,outputTokens:5,missingUsage:0});
    assert.deepEqual(usage.byAgent.assistant,{requests:1,inputTokens:11,outputTokens:5,missingUsage:0});
  } finally {process.env.AI_MAX_REQUESTS_PER_DAY=previous;}
});
test('notification retries preserve delivery identity until the receiver acknowledges',async()=>{
  const {notifyAccount,NotificationDelivery,pendingNotifications}=require('../src/core/notifications');
  const prior=global.fetch;process.env.ALERT_WEBHOOK_URL='https://test.invalid/notifications';
  const keys=[];
  try {
    global.fetch=async(url,opts)=>{keys.push(opts.headers['Idempotency-Key']);return {ok:keys.length>1};};
    notifyAccount('approval_required','Review a test action','test');
    const delivery=new NotificationDelivery();await delivery.deliver(process.env.ALERT_WEBHOOK_URL);
    assert.equal(pendingNotifications()[0].attempts,1);
    storage.saveValue('notificationOutbox',pendingNotifications().map(item=>({...item,nextAttempt:0})));
    await delivery.deliver(process.env.ALERT_WEBHOOK_URL);
    assert.deepEqual(pendingNotifications(),[]);assert.equal(keys[0],keys[1]);
  } finally {global.fetch=prior;delete process.env.ALERT_WEBHOOK_URL;}
});
test('every model call is kept by day; earlier days are estimated from saved runs without double counting',async()=>{
  const {withModelBudget}=require('../src/core/modelBudget');
  const {agentContext}=require('../src/core/agentContext');
  const {llmUsage,llmUsageForDay}=require('../src/review/llmUsage');
  const previous=process.env.AI_MAX_REQUESTS_PER_DAY;process.env.AI_MAX_REQUESTS_PER_DAY='50';
  const today=new Date().toISOString().slice(0,10);
  try {
    for(const id of storage.listRecords('model-calls').map(r=>r.id))storage.deleteRecord?.('model-calls',id);
    // Two runs saved before per-call recording: one on an old day, one today that later gets calls of its own.
    storage.appendRecord('requests','req-old','2026-10-01T10:00:00.000Z',{role:'researcher',text:'Research AAPL',status:'completed',actorId:'system'});
    storage.appendRecord('trajectories','req-old','2026-10-01T10:05:00.000Z',{inTokens:1000,outTokens:50});
    storage.appendRecord('trajectories','req-now',new Date().toISOString(),{inTokens:999999,outTokens:999});
    const provider=withModelBudget({chat:async()=>({content:[],stopReason:'end_turn',usage:{inputTokens:300,outputTokens:20}})},'test-model');
    const failing=withModelBudget({chat:async()=>{throw new Error('upstream timeout');}},'test-model');
    await agentContext.run({role:'trader',actorId:'test',requestId:'req-now'},async()=>{await provider.chat({systemPrompt:'x',messages:[],tools:[],maxTokens:10});await provider.chat({systemPrompt:'x',messages:[],tools:[],maxTokens:10});
      await assert.rejects(()=>failing.chat({systemPrompt:'x',messages:[],tools:[],maxTokens:10}),/upstream timeout/);});
    const u=llmUsage();
    const day=u.days.find(d=>d.day===today), old=u.days.find(d=>d.day==='2026-10-01');
    assert.equal(day.source,'calls');assert.equal(day.calls,3);assert.equal(day.failed,1);
    assert.equal(day.inputTokens,600,"today's run is counted from its calls, not again from its trajectory");
    assert.deepEqual(day.byModel['test-model'],{calls:3,inputTokens:600,outputTokens:40,failed:1});
    assert.equal(old.source,'runs');assert.deepEqual(old.byAgent.researcher,{calls:1,inputTokens:1000,outputTokens:50,failed:0});
    assert.equal(u.caveats.length,1);
    assert.equal(llmUsage({days:7}).days.some(d=>d.day==='2026-10-01'),false);
    const [top]=llmUsageForDay('2026-10-01').requests;
    assert.equal(top.requestId,'req-old');assert.equal(top.task,'Research AAPL');assert.equal(top.role,'researcher');
    assert.throws(()=>llmUsageForDay('yesterday'),/YYYY-MM-DD/);
  } finally {process.env.AI_MAX_REQUESTS_PER_DAY=previous;}
});
