import * as dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

/**
 * `paper` or `live`, DERIVED — never a flag of its own.
 *
 * A boolean an operator sets by hand can disagree with the endpoint the orders actually go
 * to, and the one thing that must never be wrong here is which account is live: the UI
 * paints it red based on this, so it cannot disagree with where orders actually go.
 *
 * Alpaca announces it in the hostname. IBKR announces it only in the port — 7497 (TWS) and
 * 4002 (Gateway) are the paper listeners — so an unrecognised port is treated as LIVE. That
 * asymmetry is deliberate: mistaking live for paper is the expensive direction.
 */
function resolveVenue(broker: string, alpacaBaseUrl: string, ibkrPort: number): 'paper' | 'live' {
  if (broker === 'alpaca') return new URL(alpacaBaseUrl).hostname === 'paper-api.alpaca.markets' ? 'paper' : 'live';
  return ibkrPort === 7497 || ibkrPort === 4002 ? 'paper' : 'live';
}

const BROKER = (process.env.BROKER ?? 'alpaca') as 'alpaca' | 'ibkr';
const ALPACA_BASE_URL = process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets';
const IBKR_PORT = parseInt(process.env.IBKR_PORT ?? '7497'); // 7497=paper TWS, 4002=paper Gateway

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
  requestTimeoutMs: 15_000,
  /**
   * Active EXECUTION venue — orders, positions, account, fills. Set BROKER=ibkr to switch;
   * defaults to alpaca.
   *
   * It does NOT switch the market-data vendor. Prices, bars and the model's market-data
   * tools read the Alpaca data client whichever broker is active, because there is no
   * market-data method on `IBroker` to switch. So `BROKER=ibkr` still wants the ALPACA_*
   * data credentials below, and an IBKR-only operator who omits them gets Yahoo-only
   * prices, not no prices — a degradation that looks like a slow feed.
   *
   * It does NOT switch the data directory either — that is `DATA_DIR` alone, in
   * `core/paths.ts`. Two brokers sharing one journal is an operator decision, not something
   * inferred from this value.
   */
  broker: BROKER,

  /**
   * Which account the active broker's orders reach. Derived from the endpoint above by
   * `resolveVenue` — see the note there. `daemon.ts` pushes it to the UI banner and
   * `core/automation.ts` arms the automation gate off it.
   */
  venue: resolveVenue(BROKER, ALPACA_BASE_URL, IBKR_PORT),

  /** Trading host serves the active broker only when `broker === 'alpaca'`; the data host
   *  serves market data unconditionally. See the note on `broker` above. */
  alpaca: {
    keyId: process.env.ALPACA_KEY_ID ?? '',
    secretKey: process.env.ALPACA_SECRET_KEY ?? '',
    baseUrl: ALPACA_BASE_URL,
    dataUrl: process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
  },

  /** Interactive Brokers TWS / IB Gateway connection. */
  ibkr: {
    host:     process.env.IBKR_HOST     ?? 'localhost',
    port:     IBKR_PORT,
    clientId: parseInt(process.env.IBKR_CLIENT_ID ?? '1'),
    account:  process.env.IBKR_ACCOUNT ?? '',  // required: never select an account implicitly
  },

  ai: {
    provider: process.env.AI_PROVIDER ?? 'anthropic',
    model: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
    apiKey: process.env.AI_API_KEY ?? (process.env.AI_PROVIDER?.toLowerCase() === 'ollama' ? 'ollama' : requireEnv('AI_API_KEY')),
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

  /** The local dashboard (`server/api.ts`), started under `HEADLESS=1` on 127.0.0.1 only. */
  api: {
    port: parseInt(process.env.API_PORT ?? '8787'),
  },
} as const;

if (!['alpaca', 'ibkr'].includes(config.broker)) throw new Error('BROKER must be alpaca or ibkr');
for (const [key, value, maximum] of [['API_PORT', config.api.port, 65535], ['IBKR_PORT', config.ibkr.port, 65535], ['AI_MAX_TOKENS', config.ai.maxTokensPerTurn, 16384], ['AI_MAX_TOOL_ROUNDS', config.ai.maxToolRounds, 20]] as const) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${key} is outside its supported range`);
}
