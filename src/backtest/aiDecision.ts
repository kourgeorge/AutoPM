/**
 * L1.5 — the AI call itself: check the cache, otherwise call the model with a forced tool
 * call, parse and sanity-check the response, then cache it.
 *
 * Any provider error is sanitized before being thrown — status + message only, never the raw
 * error object. Same fix already applied in `src/backtest/barCache.ts` after a real API-key
 * leak: an unhandled Anthropic/OpenAI SDK error prints its full request on its way out of
 * Node, including the `Authorization` header, in plaintext.
 */

import type { AiConfig } from '../core/types';
import type { Policy } from '../policy/types';
import type { ModelProvider } from '../core/modelProvider';
import type { DailyDossier } from './aiDossier';
import { AI_DECISION_TOOL, buildSystemPrompt, buildDossierMessage } from './aiPrompt';
import { decisionCacheKey, getCachedDecision, cacheDecision } from './aiDecisionCache';

export interface Decision {
  symbol: string;
  action: 'enter' | 'exit' | 'hold';
  stopLoss?: number;
  takeProfit?: number;
  reason: string;
}

export interface DecideDayResult {
  decisions: Decision[];
  fromCache: boolean;
}

function throwSanitizedAiError(date: string, err: any): never {
  const status = err?.response?.status ?? err?.status;
  const message = err?.response?.data?.message ?? err?.message ?? 'unknown error';
  throw new Error(`AI decision call failed for ${date}${status ? ` (${status})` : ''}: ${message}`);
}

/**
 * Node's fetch throws a bare `TypeError: fetch failed` for connection-level failures (reset,
 * timeout, DNS blip) — distinct from `OpenAI API error: <status> ...`, which is a real response
 * from the proxy and won't change on retry. A multi-hour pilot/full run makes thousands of
 * sequential calls through an internal proxy; one dropped connection shouldn't kill the run.
 */
function isTransientNetworkError(err: any): boolean {
  return /fetch failed/i.test(err?.message ?? '');
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

function parseDecisions(raw: unknown): Decision[] {
  if (!raw || typeof raw !== 'object') return [];
  const arr = (raw as any).decisions;
  if (!Array.isArray(arr)) return [];
  const out: Decision[] = [];
  for (const d of arr) {
    if (!d || typeof d !== 'object') continue;
    if (typeof d.symbol !== 'string') continue;
    if (d.action !== 'enter' && d.action !== 'exit' && d.action !== 'hold') continue;
    if (typeof d.reason !== 'string') continue;
    out.push({
      symbol: d.symbol,
      action: d.action,
      stopLoss: typeof d.stopLoss === 'number' ? d.stopLoss : undefined,
      takeProfit: typeof d.takeProfit === 'number' ? d.takeProfit : undefined,
      reason: d.reason,
    });
  }
  return out;
}

export async function decideDay(
  dossier: DailyDossier,
  policy: Policy,
  aiConfig: AiConfig,
  provider: ModelProvider,
): Promise<DecideDayResult> {
  const systemPrompt = buildSystemPrompt(policy);
  const dossierMessage = buildDossierMessage(dossier);
  const dossierText = dossierMessage.content.map(b => (b.type === 'text' ? b.text : '')).join('\n');
  const toolSchemaJson = JSON.stringify(AI_DECISION_TOOL);

  const key = decisionCacheKey(aiConfig.model, systemPrompt, toolSchemaJson, dossierText);
  const cached = getCachedDecision(key);
  if (cached) return { decisions: cached, fromCache: true };

  let response: Awaited<ReturnType<ModelProvider['chat']>> | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await provider.chat({
        systemPrompt,
        messages: [dossierMessage],
        tools: [AI_DECISION_TOOL],
        maxTokens: aiConfig.maxTokensPerTurn,
        toolChoice: { type: 'tool', name: AI_DECISION_TOOL.name },
      });
      break;
    } catch (err: any) {
      if (attempt < MAX_ATTEMPTS && isTransientNetworkError(err)) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        continue;
      }
      throwSanitizedAiError(dossier.date, err);
    }
  }

  // Unreachable without a value: the loop above only exits via `break` (response set) or
  // `throwSanitizedAiError` (never returns) — TS can't see across the loop boundary.
  const toolUse = response!.content.find(b => b.type === 'tool_use');
  const decisions = toolUse && toolUse.type === 'tool_use' ? parseDecisions(toolUse.input) : [];

  cacheDecision(key, decisions, aiConfig.model);
  return { decisions, fromCache: false };
}
