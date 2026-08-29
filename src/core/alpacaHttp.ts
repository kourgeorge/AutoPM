/**
 * The Alpaca HTTP transport — both base URLs, one place.
 *
 * Alpaca splits its API across two hosts (trading and market data) that take the SAME two
 * credential headers. That header pair was previously constructed in three separate files,
 * which is three places to get a credential wrong and three places to miss a change to how
 * the key is read. Everything that talks to Alpaca over REST imports from here.
 *
 * Lives in `core/` and NOT in `broker/` because only one of its two clients belongs to the
 * execution venue. `alpacaTrading` serves `AlpacaBroker`; `alpacaData` serves the price
 * collector and the model's market-data tools, which run identically when `BROKER=ibkr`.
 * While this file sat under `broker/`, `collect/priceSource.ts` and `tools/` imported market
 * data *from the execution-venue package* — which reads as though the broker choice governed
 * the data feed. It does not: see `config.broker`. Nothing here may import from `broker/`.
 *
 * Beyond the clients, this holds only the wire-format facts that are true of Alpaca
 * regardless of who is asking — `alpacaTimeToMs` below. No retry, no interceptor, no error
 * translation. Each caller wants something different from a failure — the broker raises a
 * `BrokerRejection`, `priceSource` preserves the error as provenance in a `Maybe`, and the
 * data tools hand the message to the model — so a shared opinion here would be wrong for
 * two of the three.
 */

import axios, { AxiosInstance } from 'axios';
import { config } from './config';
import { logger } from './logger';

/**
 * Warned, not thrown. Missing credentials are fatal to the market-data path but not to the
 * process: `priceSource` falls back to Yahoo per-symbol, so the system keeps trading on
 * prices from a different vendor. Throwing here would break that working (degraded) setup;
 * staying silent is what makes it read as a slow feed instead of an unauthenticated one.
 */
if (!config.alpaca.keyId || !config.alpaca.secretKey) {
  logger.warn(
    'ALPACA_KEY_ID/ALPACA_SECRET_KEY not set: every Alpaca market-data call will fail ' +
    'authentication and prices will come from the Yahoo fallback only. Market data does ' +
    `not follow BROKER (currently '${config.broker}') — it always reads Alpaca.`,
  );
}

function makeClient(baseURL: string): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      'APCA-API-KEY-ID': config.alpaca.keyId,
      'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    },
  });
}

/** Orders, positions, account, activities, clock. */
export const alpacaTrading = makeClient(config.alpaca.baseUrl);

/** Bars, snapshots, quotes, screeners, news. */
export const alpacaData = makeClient(config.alpaca.dataUrl);

/**
 * Parse a timestamp Alpaca stamped, in milliseconds. `NaN` if it is unreadable.
 *
 * Alpaca returns NANOSECOND precision ("...723490207Z", 9 fractional digits) and bare
 * `Date.parse` returns NaN for anything past milliseconds on some runtimes. That produced two
 * different silent failures from one vendor fact before this was shared: every price read as
 * stale in `collect/priceSource.ts` (ageMs = NaN), and every fill recorded at ingest time
 * rather than execution time in `AlpacaBroker.getFills`. Truncate to 3 fractional digits
 * before any date arithmetic.
 */
export function alpacaTimeToMs(ts: string): number {
  return Date.parse(ts.replace(/(\.\d{3})\d+/, '$1'));
}

/**
 * How far back a SIP request's `end` must be held.
 *
 * This subscription may query the consolidated tape historically but not recently, and the
 * venue refuses the WHOLE request rather than trimming it: `end` at now returns
 * `403 subscription does not permit querying recent SIP data` (measured 2026-08-29). So a
 * caller asking for "up to now" gets nothing at all, not a slightly short series, and
 * trimming `end` is mandatory rather than defensive.
 *
 * Fifteen minutes plus a minute of slack. A wire-format fact about Alpaca that is true of
 * every caller, which is why it lives here rather than in the two collectors that need it.
 */
export const SIP_EMBARGO_MS = 16 * 60_000;
