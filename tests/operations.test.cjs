const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {test,after}=require('node:test');
const {spawnSync}=require('node:child_process');
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
    notifyAccount('approval_required','Review a test proposal','test');
    const delivery=new NotificationDelivery();await delivery.deliver(process.env.ALERT_WEBHOOK_URL);
    assert.equal(pendingNotifications()[0].attempts,1);
    storage.saveValue('notificationOutbox',pendingNotifications().map(item=>({...item,nextAttempt:0})));
    await delivery.deliver(process.env.ALERT_WEBHOOK_URL);
    assert.deepEqual(pendingNotifications(),[]);assert.equal(keys[0],keys[1]);
  } finally {global.fetch=prior;delete process.env.ALERT_WEBHOOK_URL;}
});
test('consistent backup restores account settings and lessons paused, without sessions',()=>{
  state.updateState({accountId:'alpaca:paper:backup-test',paused:false});policy.loadPolicy();
  require('../src/journal/lessons').recordLesson('Advisory lesson preserved in the account backup.');
  storage.saveValue('sessions',{old:{username:'alice'}});
  const run=args=>spawnSync(process.execPath,['-r','ts-node/register','src/scripts/backup.ts',...args],{env:process.env,encoding:'utf8'});
  const backup=run(['create']);assert.equal(backup.status,0,backup.stderr);
  const file=backup.stdout.trim().split('\n').at(-1),target=path.join(process.env.DATA_DIR,'restored');
  const restored=run(['restore',file,target]);assert.equal(restored.status,0,restored.stderr);
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(target,'autotrade.sqlite'));
  const saved=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='state'").get().value);
  assert.equal(saved.accountId,'alpaca:paper:backup-test');assert.equal(saved.paused,true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='lesson'").get().n,1);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='sessions'").get(),undefined);db.close();
});
