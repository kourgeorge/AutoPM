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
  /** Active broker. Set BROKER=ibkr to switch; defaults to alpaca. */
  broker: (process.env.BROKER ?? 'alpaca') as 'alpaca' | 'ibkr',

  alpaca: {
    keyId: process.env.ALPACA_KEY_ID ?? '',
    secretKey: process.env.ALPACA_SECRET_KEY ?? '',
    baseUrl: process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
  },

  /** Interactive Brokers TWS / IB Gateway connection. */
  ibkr: {
    host:     process.env.IBKR_HOST     ?? 'localhost',
    port:     parseInt(process.env.IBKR_PORT     ?? '7497'), // 7497=paper TWS, 4002=paper Gateway
    clientId: parseInt(process.env.IBKR_CLIENT_ID ?? '1'),
    account:  process.env.IBKR_ACCOUNT ?? '',  // leave blank for single-account setups
  },

  ai: {
    provider: process.env.AI_PROVIDER ?? 'anthropic',
    model: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
    apiKey: requireEnv('AI_API_KEY'),
    // Any OpenAI-compatible endpoint. Optional for the providers with a known URL
    // (openai, groq, ollama, cohere, together) and REQUIRED for anything else — an
    // unrecognised provider without this throws rather than guessing a domain to send the
    // API key to. Examples:
    // - OpenAI: https://api.openai.com/v1
    // - Azure: https://{resource}.openai.azure.com/v1
    // - Ollama: http://localhost:11434/v1
    // - LiteLLM proxy: http://localhost:8000/v1
    baseUrl: process.env.AI_BASE_URL,
    maxTokensPerTurn: parseInt(process.env.AI_MAX_TOKENS ?? '4096'),
    maxToolRounds: parseInt(process.env.AI_MAX_TOOL_ROUNDS ?? '10'),
  },
} as const;
