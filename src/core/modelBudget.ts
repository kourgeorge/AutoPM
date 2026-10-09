import { readValue, saveValue, transaction } from './storage';
import { agentContext } from './agentContext';
import type { ModelProvider } from './modelProvider';
interface AgentUsage { requests: number; inputTokens: number; outputTokens: number; missingUsage: number }
interface Usage extends AgentUsage { day: string; assistantRequests?: number; byAgent?: Partial<Record<'trader' | 'assistant' | 'researcher' | 'unassigned', AgentUsage>> }
const emptyUsage = (): AgentUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, missingUsage: 0 });
export interface AiSettings { maxRequestsPerDay: number | null }
function validateSettings(settings: AiSettings): AiSettings {
  const limit = settings.maxRequestsPerDay;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)) {
    throw new Error('Daily AI call limit must be unlimited or a whole number from 1 to 5000');
  }
  return { maxRequestsPerDay: limit };
}
/** Saved account settings override the optional environment value. Null means unlimited. */
export function aiSettings(): AiSettings {
  const saved = readValue<AiSettings>('aiSettings');
  if (saved) return validateSettings(saved);
  const raw = process.env.AI_MAX_REQUESTS_PER_DAY?.trim().toLowerCase();
  return validateSettings({ maxRequestsPerDay: !raw || raw === 'unlimited' || raw === '0' ? null : Number(raw) });
}
export function saveAiSettings(settings: AiSettings): AiSettings {
  const valid = validateSettings(settings);
  saveValue('aiSettings', valid);
  return valid;
}
/** Chat and research each get a share of the daily cap so neither can starve the trader. */
const SHARES = { assistant: 0.4, researcher: 0.3 } as const;
const shareLimit = (limit: number | null, share: number) => limit === null ? null : Math.max(1, Math.floor(limit * share));
export function modelUsage(day = new Date().toISOString().slice(0, 10)): Usage {
  return readValue<Usage>('modelUsage:' + day) ?? { day, requests: 0, inputTokens: 0, outputTokens: 0, missingUsage: 0 };
}
export function modelBudgetStatus() {
  const settings = aiSettings(), usage = modelUsage(), limit = settings.maxRequestsPerDay;
  return { settings, usage,
    remaining: limit === null ? null : Math.max(0, limit - usage.requests),
    assistantLimit: shareLimit(limit, SHARES.assistant),
    researchLimit: shareLimit(limit, SHARES.researcher),
    resetsAt: new Date(Date.parse(usage.day + 'T00:00:00Z') + 86_400_000).toISOString() };
}
export function withModelBudget(provider: ModelProvider): ModelProvider {
  aiSettings();
  return { async chat(params) {
    if (JSON.stringify(params).length > 200_000) throw new Error('Model context exceeds the account request limit');
    const day = new Date().toISOString().slice(0, 10);
    const role = agentContext.getStore()?.role ?? 'unassigned';
    transaction(() => {
      const limit = aiSettings().maxRequestsPerDay;
      const usage = modelUsage(day);
      if (limit !== null && usage.requests >= limit) throw new Error('Daily AI request budget reached; broker protection continues');
      const assistant = role === 'assistant';
      const chatLimit = shareLimit(limit, SHARES.assistant), researchLimit = shareLimit(limit, SHARES.researcher);
      if (assistant && chatLimit !== null && (usage.assistantRequests ?? 0) >= chatLimit) throw new Error('Chat budget reached; remaining model capacity is reserved for the trader');
      if (role === 'researcher' && researchLimit !== null && (usage.byAgent?.researcher?.requests ?? 0) >= researchLimit) throw new Error('Research budget reached; remaining model capacity is reserved for the trader');
      saveValue('modelUsage:' + day, { ...usage, requests: usage.requests + 1,
        byAgent: { ...usage.byAgent, [role]: { ...(usage.byAgent?.[role] ?? emptyUsage()), requests: (usage.byAgent?.[role]?.requests ?? 0) + 1 } },
        assistantRequests: (usage.assistantRequests ?? 0) + (assistant ? 1 : 0) });
    });
    const response = await provider.chat(params);
    params.signal?.throwIfAborted();
    transaction(() => {
      const usage = modelUsage(day);
      const agent = usage.byAgent?.[role] ?? emptyUsage();
      saveValue('modelUsage:' + day, { ...usage,
        byAgent: { ...usage.byAgent, [role]: { ...agent,
          inputTokens: agent.inputTokens + response.usage.inputTokens,
          outputTokens: agent.outputTokens + response.usage.outputTokens,
          missingUsage: agent.missingUsage + (response.usage.inputTokens + response.usage.outputTokens === 0 ? 1 : 0) } },
        inputTokens: usage.inputTokens + response.usage.inputTokens,
        outputTokens: usage.outputTokens + response.usage.outputTokens,
        missingUsage: usage.missingUsage + (response.usage.inputTokens + response.usage.outputTokens === 0 ? 1 : 0) });
    });
    return response;
  } };
}
