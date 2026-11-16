const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {test,after,beforeEach}=require('node:test');
Object.assign(process.env,{DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'autotrade-tokens-')),AI_PROVIDER:'ollama',AI_API_KEY:'test',HEADLESS:'1',BROKER:'alpaca'});
delete process.env.AI_MAX_REQUESTS_PER_DAY;delete process.env.AI_MAX_INPUT_TOKENS_PER_DAY;delete process.env.ALERT_WEBHOOK_URL;
require('ts-node/register');
const storage=require('../src/core/storage');
const budget=require('../src/core/modelBudget');
after(()=>storage.closeStorage());
const params={systemPrompt:'test',messages:[],tools:[],maxTokens:10};
const day=()=>new Date().toISOString().slice(0,10);
const alerts=()=>storage.listRecords('activity').map(r=>r.value).filter(e=>e.kind==='alert').map(e=>e.text);
beforeEach(()=>{storage.saveValue('modelUsage',null);storage.saveValue('modelPlanLimit',null);storage.saveValue('aiSettings',{maxRequestsPerDay:null,maxInputTokensPerDay:null});});
const provider=(inputTokens,onCall=()=>{})=>budget.withModelBudget({chat:async()=>{onCall();return {content:[],stopReason:'end_turn',usage:{inputTokens,outputTokens:1}};}});

test('null token budget means off: any amount of tokens is allowed and nothing warns',async()=>{
  storage.saveValue('modelUsage',{day:day(),requests:0,inputTokens:5_000_000_000,outputTokens:0,missingUsage:0});
  await provider(100).chat(params);
  const s=budget.modelBudgetStatus();
  assert.equal(s.tokenLimit,null);assert.equal(s.tokenWarning,false);assert.equal(s.tokenBudgetReached,false);assert.deepEqual(s.warnings,[]);
});

test('token use at 80% warns once in status and as a notification, but calls continue',async()=>{
  budget.saveAiSettings({maxInputTokensPerDay:10_000});
  assert.equal(budget.aiSettings().maxRequestsPerDay,null);
  const before=alerts().length;
  await provider(7_000).chat(params);
  assert.equal(budget.modelBudgetStatus().tokenWarning,false);
  await provider(1_000).chat(params);
  const s=budget.modelBudgetStatus();
  assert.equal(s.tokenWarning,true);assert.equal(s.tokenBudgetReached,false);assert.equal(s.tokenUsedPct,80);
  assert.match(s.warnings.join('\n'),/80% of today's budget/);
  await provider(500).chat(params);
  const sent=alerts().slice(before).filter(t=>/today's budget/.test(t));
  assert.equal(sent.length,1,'the 80% warning is sent once a day');
});

test('token use at 100% stops further calls with the broker-protection message',async()=>{
  budget.saveAiSettings({maxInputTokensPerDay:1_000});
  let calls=0;
  await provider(1_000,()=>calls++).chat(params);
  await assert.rejects(()=>provider(1,()=>calls++).chat(params),/Daily AI token budget reached; broker protection continues/);
  assert.equal(calls,1);
  const s=budget.modelBudgetStatus();
  assert.equal(s.tokenBudgetReached,true);assert.equal(s.tokensRemaining,0);assert.equal(s.usage.requests,1,'a refused call is not counted');
  budget.saveAiSettings({maxInputTokensPerDay:null});
  await provider(1,()=>calls++).chat(params);assert.equal(calls,2,'turning the budget off lets calls run again');
});

test('a 429 usage-limit reply pauses model calls until resets_at',async()=>{
  const resetsAt=Math.floor(Date.now()/1000)+3600;
  let calls=0;
  const failing=budget.withModelBudget({chat:async()=>{calls++;throw new Error(`OpenAI API error: 429 {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":${resetsAt}}}`);}});
  await assert.rejects(()=>failing.chat(params),/usage_limit_reached/);
  assert.equal(calls,1);
  const s=budget.modelBudgetStatus();
  assert.equal(s.planLimit.resetsAt,new Date(resetsAt*1000).toISOString());
  assert.match(s.warnings.join('\n'),/AI plan limit reached, resets at/);
  assert.ok(alerts().some(t=>/AI plan limit reached/.test(t)));
  // Later wake-ups do not call the provider again until the reset time.
  await assert.rejects(()=>failing.chat(params),/AI plan limit reached, resets at .*broker protection continues/);
  await assert.rejects(()=>provider(1,()=>calls++).chat(params),/AI plan limit reached/);
  assert.equal(calls,1);
  // Once resets_at has passed, calls go through again.
  storage.saveValue('modelPlanLimit',{...s.planLimit,resetsAt:new Date(Date.now()-1000).toISOString()});
  await provider(1,()=>calls++).chat(params);
  assert.equal(calls,2);assert.equal(budget.modelBudgetStatus().planLimit,null);
});

test('usage-limit errors are recognised with ISO or missing reset times; other errors are not',()=>{
  const now=Date.parse('2026-11-14T12:00:00Z');
  assert.equal(budget.planLimitFromError(new Error('429 {"type":"usage_limit_reached","resets_at":"2026-11-18T00:00:00Z"}'),now).resetsAt,'2026-11-18T00:00:00.000Z');
  assert.equal(budget.planLimitFromError(new Error('The usage limit has been reached'),now).resetsAt,'2026-11-14T13:00:00.000Z');
  assert.equal(budget.planLimitFromError(new Error('OpenAI API error: 429 rate limited, slow down'),now),null);
  assert.equal(budget.planLimitFromError(new Error('upstream timeout'),now),null);
});
