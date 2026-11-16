import crypto from 'crypto';
import { appendRecord, readValue, saveValue, transaction } from './storage';
import { agentContext } from './agentContext';
import { notifyAccount } from './notifications';
import type { ModelProvider } from './modelProvider';
interface AgentUsage { requests: number; inputTokens: number; outputTokens: number; missingUsage: number }
interface Usage extends AgentUsage { day: string; assistantRequests?: number; byAgent?: Partial<Record<'trader' | 'assistant' | 'researcher' | 'unassigned', AgentUsage>>;
  /** Set once the 80% token warning was sent today, so it is sent only once. */
  tokenWarned?: boolean }
const emptyUsage = (): AgentUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, missingUsage: 0 });
/** Null means unlimited for both limits. */
export interface AiSettings { maxRequestsPerDay: number | null; maxInputTokensPerDay?: number | null }
/** Share of the daily token budget at which the app warns. */
export const TOKEN_WARN_SHARE = 0.8;
const offValue = (raw: string | undefined) => !raw || raw === 'unlimited' || raw === '0' ? null : Number(raw);
function validateSettings(settings: AiSettings): Required<AiSettings> {
  const limit = settings.maxRequestsPerDay;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)) {
    throw new Error('Daily AI call limit must be unlimited or a whole number from 1 to 5000');
  }
  const tokens = settings.maxInputTokensPerDay ?? null;
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1000 || tokens > 1_000_000_000)) {
    throw new Error('Daily AI input-token limit must be unlimited or a whole number from 1,000 to 1,000,000,000');
  }
  return { maxRequestsPerDay: limit, maxInputTokensPerDay: tokens };
}
/** Saved account settings override the optional environment values. Null means unlimited. */
export function aiSettings(): Required<AiSettings> {
  const saved = readValue<AiSettings>('aiSettings');
  const envTokens = offValue(process.env.AI_MAX_INPUT_TOKENS_PER_DAY?.trim().toLowerCase());
  if (saved) return validateSettings({ ...saved, maxInputTokensPerDay: Object.hasOwn(saved, 'maxInputTokensPerDay') ? saved.maxInputTokensPerDay : envTokens });
  return validateSettings({ maxRequestsPerDay: offValue(process.env.AI_MAX_REQUESTS_PER_DAY?.trim().toLowerCase()), maxInputTokensPerDay: envTokens });
}
/** A setting left out keeps its current value. Saving also clears a remembered plan limit, so the next call tries again. */
export function saveAiSettings(settings: AiSettings): Required<AiSettings> {
  const current = aiSettings();
  const valid = validateSettings({ ...current, ...settings });
  saveValue('aiSettings', valid);
  saveValue('modelPlanLimit', null);
  return valid;
}

/**
 * The provider said the account's plan is used up (e.g. ChatGPT Plus weekly limit, HTTP 429
 * "usage_limit_reached"). Remembered so calls stop until `resetsAt` instead of failing every wake-up.
 */
export interface PlanLimit { at: string; resetsAt: string; message: string }
/** Without a reset time in the reply, wait this long before trying again. */
const PLAN_LIMIT_FALLBACK_MS = 60 * 60_000;
export function planLimitFromError(err: unknown, now = Date.now()): PlanLimit | null {
  const text = err instanceof Error ? err.message : String(err);
  if (!/usage_limit_reached|usage limit (has been )?reached/i.test(text)) return null;
  let resetsAt: number | null = null;
  const at = text.match(/"?resets_at"?\s*[:=]\s*"?([^",}\s]+)/);
  if (at) {
    const n = Number(at[1]);
    resetsAt = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(at[1]);
  }
  const inSec = text.match(/"?resets_in_seconds"?\s*[:=]\s*(\d+)/);
  if ((resetsAt === null || !Number.isFinite(resetsAt)) && inSec) resetsAt = now + Number(inSec[1]) * 1000;
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now) resetsAt = now + PLAN_LIMIT_FALLBACK_MS;
  return { at: new Date(now).toISOString(), resetsAt: new Date(resetsAt).toISOString(), message: text.slice(0, 300) };
}
/** The remembered plan limit, or null once it has passed. */
export function activePlanLimit(now = Date.now()): PlanLimit | null {
  const saved = readValue<PlanLimit | null>('modelPlanLimit');
  return saved && Date.parse(saved.resetsAt) > now ? saved : null;
}
/** Chat and research each get a share of the daily cap so neither can starve the trader. */
const SHARES = { assistant: 0.4, researcher: 0.3 } as const;
const shareLimit = (limit: number | null, share: number) => limit === null ? null : Math.max(1, Math.floor(limit * share));
/** One saved key holding today's counts; a new day starts from zero and overwrites it. */
export function modelUsage(day = new Date().toISOString().slice(0, 10)): Usage {
  const saved = readValue<Usage>('modelUsage');
  return saved?.day === day ? saved : { day, requests: 0, inputTokens: 0, outputTokens: 0, missingUsage: 0 };
}
export function modelBudgetStatus() {
  const settings = aiSettings(), usage = modelUsage(), limit = settings.maxRequestsPerDay;
  const tokenLimit = settings.maxInputTokensPerDay;
  const tokenShare = tokenLimit === null ? null : usage.inputTokens / tokenLimit;
  const planLimit = activePlanLimit();
  const warnings: string[] = [];
  if (planLimit) warnings.push(`AI plan limit reached, resets at ${planLimit.resetsAt}`);
  if (tokenShare !== null && tokenShare >= 1) warnings.push(`Daily AI token budget reached (${usage.inputTokens.toLocaleString('en-US')} of ${tokenLimit!.toLocaleString('en-US')} input tokens); broker protection continues`);
  else if (tokenShare !== null && tokenShare >= TOKEN_WARN_SHARE) warnings.push(`AI token use is at ${Math.floor(tokenShare * 100)}% of today's budget (${usage.inputTokens.toLocaleString('en-US')} of ${tokenLimit!.toLocaleString('en-US')} input tokens)`);
  if (limit !== null && usage.requests >= limit) warnings.push('Daily AI request budget reached; broker protection continues');
  return { settings, usage,
    remaining: limit === null ? null : Math.max(0, limit - usage.requests),
    tokenLimit,
    tokensRemaining: tokenLimit === null ? null : Math.max(0, tokenLimit - usage.inputTokens),
    tokenUsedPct: tokenShare === null ? null : Math.round(tokenShare * 1000) / 10,
    tokenWarning: tokenShare !== null && tokenShare >= TOKEN_WARN_SHARE,
    tokenBudgetReached: tokenShare !== null && tokenShare >= 1,
    planLimit,
    warnings,
    assistantLimit: shareLimit(limit, SHARES.assistant),
    researchLimit: shareLimit(limit, SHARES.researcher),
    resetsAt: new Date(Date.parse(usage.day + 'T00:00:00Z') + 86_400_000).toISOString() };
}
/** Largest model request the account accepts, in characters of the whole request (instructions, tools and messages). */
export const REQUEST_CHAR_LIMIT = 200_000;
/** `model` may be a function when the model can change between calls (see `createLiveModelProvider`). */
export function withModelBudget(provider: ModelProvider, modelName: string | (() => string) = 'unknown'): ModelProvider {
  aiSettings();
  return { async chat(params) {
    if (JSON.stringify(params).length > REQUEST_CHAR_LIMIT) throw new Error('Model context exceeds the account request limit');
    const day = new Date().toISOString().slice(0, 10);
    const role = agentContext.getStore()?.role ?? 'unassigned';
    const plan = activePlanLimit();
    if (plan) throw new Error(`AI plan limit reached, resets at ${plan.resetsAt}; broker protection continues`);
    transaction(() => {
      const { maxRequestsPerDay: limit, maxInputTokensPerDay: tokenLimit } = aiSettings();
      const usage = modelUsage(day);
      if (limit !== null && usage.requests >= limit) throw new Error('Daily AI request budget reached; broker protection continues');
      if (tokenLimit !== null && usage.inputTokens >= tokenLimit) throw new Error('Daily AI token budget reached; broker protection continues');
      const assistant = role === 'assistant';
      const chatLimit = shareLimit(limit, SHARES.assistant), researchLimit = shareLimit(limit, SHARES.researcher);
      if (assistant && chatLimit !== null && (usage.assistantRequests ?? 0) >= chatLimit) throw new Error('Chat budget reached; remaining model capacity is reserved for the trader');
      if (role === 'researcher' && researchLimit !== null && (usage.byAgent?.researcher?.requests ?? 0) >= researchLimit) throw new Error('Research budget reached; remaining model capacity is reserved for the trader');
      saveValue('modelUsage', { ...usage, requests: usage.requests + 1,
        byAgent: { ...usage.byAgent, [role]: { ...(usage.byAgent?.[role] ?? emptyUsage()), requests: (usage.byAgent?.[role]?.requests ?? 0) + 1 } },
        assistantRequests: (usage.assistantRequests ?? 0) + (assistant ? 1 : 0) });
    });
    const startedAt = new Date().toISOString();
    const model = typeof modelName === 'function' ? modelName() : modelName;
    let response: Awaited<ReturnType<ModelProvider['chat']>>;
    try {
      response = await provider.chat(params);
    } catch (err) {
      recordModelCall({ startedAt, role, model, inputTokens: 0, outputTokens: 0, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      const limit = planLimitFromError(err);
      if (limit) {
        const known = activePlanLimit();
        saveValue('modelPlanLimit', limit);
        if (!known) try { notifyAccount('ai_plan_limit', `AI plan limit reached, resets at ${limit.resetsAt}. AI calls pause until then; broker protection continues.`); } catch { /* never mask the model error */ }
      }
      throw err;
    }
    recordModelCall({ startedAt, role, model, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cachedInputTokens: response.usage.cachedInputTokens });
    params.signal?.throwIfAborted();
    let warn = null as string | null;
    transaction(() => {
      const usage = modelUsage(day);
      const agent = usage.byAgent?.[role] ?? emptyUsage();
      const tokenLimit = aiSettings().maxInputTokensPerDay, inputTokens = usage.inputTokens + response.usage.inputTokens;
      const crossed = tokenLimit !== null && !usage.tokenWarned && inputTokens >= tokenLimit * TOKEN_WARN_SHARE;
      if (crossed) warn = `AI token use is at ${Math.floor(inputTokens / tokenLimit! * 100)}% of today's budget (${inputTokens.toLocaleString('en-US')} of ${tokenLimit!.toLocaleString('en-US')} input tokens). At 100% the trader stops; broker protection continues.`;
      saveValue('modelUsage', { ...usage,
        byAgent: { ...usage.byAgent, [role]: { ...agent,
          inputTokens: agent.inputTokens + response.usage.inputTokens,
          outputTokens: agent.outputTokens + response.usage.outputTokens,
          missingUsage: agent.missingUsage + (response.usage.inputTokens + response.usage.outputTokens === 0 ? 1 : 0) } },
        inputTokens: usage.inputTokens + response.usage.inputTokens,
        outputTokens: usage.outputTokens + response.usage.outputTokens,
        missingUsage: usage.missingUsage + (response.usage.inputTokens + response.usage.outputTokens === 0 ? 1 : 0),
        ...(crossed || usage.tokenWarned ? { tokenWarned: true } : {}) });
    });
    if (warn) try { notifyAccount('ai_token_budget', warn); } catch { /* a warning must never fail a model call */ }
    return response;
  } };
}

/**
 * One row per model call, kept for good: `modelUsage` holds today only (it is the budget), so
 * without this nothing could answer what yesterday cost. Read by `review/llmUsage.ts`.
 */
export interface ModelCall {
  at: string; day: string; role: string; requestId: string | null; model: string;
  inputTokens: number; outputTokens: number; durationMs: number; error?: string;
  /** Part of `inputTokens` read from the prompt cache. */
  cachedInputTokens?: number;
}
function recordModelCall(c: { startedAt: string; role: string; model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number; error?: string }): void {
  const at = new Date().toISOString();
  const row: ModelCall = { at, day: at.slice(0, 10), role: c.role, requestId: agentContext.getStore()?.requestId ?? null,
    model: c.model, inputTokens: c.inputTokens, outputTokens: c.outputTokens,
    ...(c.cachedInputTokens ? { cachedInputTokens: c.cachedInputTokens } : {}),
    durationMs: Date.parse(at) - Date.parse(c.startedAt), ...(c.error ? { error: c.error } : {}) };
  try { appendRecord('model-calls', crypto.randomUUID(), at, row); } catch { /* usage history must never fail a model call */ }
}
