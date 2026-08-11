import * as dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

/**
 * Environment and secrets. NOT behaviour.
 *
 * Every behavioural number — watchlist, risk limits, indicator periods, trigger
 * thresholds — lives in `policy/policy.yaml` and is read through `getPolicy()`.
 * The split is by nature, not by consumer: if an operator would tune it to change
 * how the system trades, it belongs in the policy; if it is an endpoint, a key or a
 * model id, it belongs here.
 */
export const config = {
  alpaca: {
    keyId: requireEnv('ALPACA_KEY_ID'),
    secretKey: requireEnv('ALPACA_SECRET_KEY'),
    baseUrl: process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
  },

  ai: {
    provider: process.env.AI_PROVIDER ?? 'anthropic',
    model: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
    apiKey: requireEnv('AI_API_KEY'),
    // Optional: point to a LiteLLM proxy or any OpenAI-compatible endpoint
    baseUrl: process.env.AI_BASE_URL,
    maxTokensPerTurn: parseInt(process.env.AI_MAX_TOKENS ?? '4096'),
    maxToolRounds: parseInt(process.env.AI_MAX_TOOL_ROUNDS ?? '10'),
  },
} as const;
