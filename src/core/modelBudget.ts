import { readValue, saveValue, transaction } from './storage';
import { agentContext } from './agentContext';
import type { ModelProvider } from './modelProvider';
interface Usage { day: string; requests: number; inputTokens: number; outputTokens: number; missingUsage: number; conciergeRequests?: number }
export function modelUsage(day = new Date().toISOString().slice(0, 10)): Usage {
  return readValue<Usage>('modelUsage:' + day) ?? { day, requests: 0, inputTokens: 0, outputTokens: 0, missingUsage: 0 };
}
export function withModelBudget(provider: ModelProvider): ModelProvider {
  const limit = Number(process.env.AI_MAX_REQUESTS_PER_DAY ?? 300);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('AI_MAX_REQUESTS_PER_DAY must be 1–5000');
  return { async chat(params) {
    if (JSON.stringify(params).length > 200_000) throw new Error('Model context exceeds the account request limit');
    const day = new Date().toISOString().slice(0, 10);
    transaction(() => {
      const usage = modelUsage(day);
      if (usage.requests >= limit) throw new Error('Daily AI request budget reached; broker protection continues');
      const concierge = agentContext.getStore()?.role === 'concierge';
      const chatLimit = Math.max(1, Math.floor(limit * 0.4));
      if (concierge && (usage.conciergeRequests ?? 0) >= chatLimit) throw new Error('Chat budget reached; remaining model capacity is reserved for the trader');
      saveValue('modelUsage:' + day, { ...usage, requests: usage.requests + 1,
        conciergeRequests: (usage.conciergeRequests ?? 0) + (concierge ? 1 : 0) });
    });
    const response = await provider.chat(params);
    params.signal?.throwIfAborted();
    transaction(() => {
      const usage = modelUsage(day);
      saveValue('modelUsage:' + day, { ...usage,
        inputTokens: usage.inputTokens + response.usage.inputTokens,
        outputTokens: usage.outputTokens + response.usage.outputTokens,
        missingUsage: usage.missingUsage + (response.usage.inputTokens + response.usage.outputTokens === 0 ? 1 : 0) });
    });
    return response;
  } };
}
