import { config } from './config';
import { readValue, saveValue } from './storage';
import type { AiConfig } from './types';

/**
 * The model and API key the agents use. `.env` (`AI_MODEL`, `AI_API_KEY`) gives the defaults;
 * a value saved from the Settings page overrides it and takes effect on the next model call,
 * with no restart. The server (`AI_PROVIDER`, `AI_BASE_URL`) stays an `.env` choice: it decides
 * where the key is sent, so it is shown but not editable here.
 */
export interface AiConnection { model?: string; apiKey?: string; reasoningEffort?: ReasoningEffort }

/**
 * How hard the model thinks before answering, on the OpenAI-style route only (the Anthropic
 * route ignores it). 'none' is today's behaviour. `.env` AI_REASONING_EFFORT gives the default.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
const isEffort = (v: unknown): v is ReasoningEffort => (REASONING_EFFORTS as readonly unknown[]).includes(v);
export function envReasoningEffort(): ReasoningEffort {
  const raw = process.env.AI_REASONING_EFFORT?.trim().toLowerCase();
  return isEffort(raw) ? raw : 'none';
}

const KNOWN_SERVERS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai:   'https://api.openai.com/v1',
  groq:     'https://api.groq.com/openai/v1',
  ollama:   'http://localhost:11434/v1',
  cohere:   'https://api.cohere.ai/v1',
  together: 'https://api.together.xyz/v1',
};

function validate(c: AiConnection): AiConnection {
  const out: AiConnection = {};
  for (const [field, label, max] of [['model', 'Model name', 200], ['apiKey', 'API key', 1000]] as const) {
    const value = c[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim()) || value.trim().length > max) {
      throw new Error(`${label} must be one word with no spaces, up to ${max} characters`);
    }
    out[field] = value.trim();
  }
  if (c.reasoningEffort !== undefined) {
    if (!isEffort(c.reasoningEffort)) throw new Error(`Reasoning effort must be one of: ${REASONING_EFFORTS.join(', ')}`);
    out.reasoningEffort = c.reasoningEffort;
  }
  return out;
}

export function savedAiConnection(): AiConnection {
  return validate(readValue<AiConnection>('aiConnection') ?? {});
}

/** What every model call uses right now: `.env` with the saved overrides on top. */
export function activeAiConfig(): AiConfig & { reasoningEffort: ReasoningEffort } {
  return { ...config.ai, reasoningEffort: envReasoningEffort(), ...savedAiConnection() };
}

/** `null` for a field clears its override, so `.env` applies again; `undefined` leaves it alone. */
export function saveAiConnection(change: { model?: string | null; apiKey?: string | null; reasoningEffort?: string | null }): AiConnection {
  const next: AiConnection = { ...savedAiConnection() };
  for (const field of ['model', 'apiKey', 'reasoningEffort'] as const) {
    if (change[field] === null) delete next[field];
    else if (change[field] !== undefined) (next as Record<string, unknown>)[field] = change[field];
  }
  const valid = validate(next);
  saveValue('aiConnection', valid);
  return valid;
}

/** Last four characters only — the key itself never leaves the engine. */
const maskKey = (key: string) => key.length > 8 ? '••••' + key.slice(-4) : '••••';

/** For the Settings page. Never includes the key. */
export function aiConnectionStatus() {
  const saved = savedAiConnection(), active = activeAiConfig();
  return {
    provider: active.provider,
    server: active.baseUrl ?? KNOWN_SERVERS[active.provider.toLowerCase()] ?? null,
    model: active.model,
    modelSource: saved.model ? 'settings' : 'env',
    envModel: config.ai.model,
    keyHint: maskKey(active.apiKey),
    keySource: saved.apiKey ? 'settings' : 'env',
    reasoningEffort: active.reasoningEffort,
    reasoningEffortSource: saved.reasoningEffort ? 'settings' : 'env',
    reasoningEfforts: REASONING_EFFORTS,
  } as const;
}
