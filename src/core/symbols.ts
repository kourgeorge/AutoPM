/**
 * The one definition of "the same symbol".
 *
 * Crypto is the whole reason: an order placed as `BTC/USD` comes back from Alpaca as
 * `BTCUSD`. Two layers used to answer this differently — the cycle context joined
 * snapshots on a normalized form while the feature computation looked up the raw key —
 * so a stop could render as recorded in the prompt and be invisible to the stop
 * detector at the same time.
 *
 * Lives in `core/` because both sides must reach it: `features/compute.ts` cannot import
 * from `agents/trader.ts`, which pulls in the UI and builds a blessed screen on import.
 */
export function canonicalSymbol(s: string): string {
  return s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}
