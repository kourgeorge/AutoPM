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
