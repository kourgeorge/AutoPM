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

/**
 * "Are these the same instrument?" — the predicate form of `canonicalSymbol`.
 *
 * Open-coded as `canonicalSymbol(a) === canonicalSymbol(b)` at eight sites across six
 * modules, each with its own comment re-deriving the `BTC/USD` vs `BTCUSD` rule. One name
 * makes the invariant greppable, and makes the site that forgets it visible as a bare `===`.
 */
export function sameSymbol(a: string, b: string): boolean {
  return canonicalSymbol(a) === canonicalSymbol(b);
}

/**
 * "Is this a crypto pair?" — the one test, in the file that owns symbol identity.
 *
 * `symbol.includes('/')` is NOT this test, and that is the whole reason this exists. An order
 * placed as `BTC/USD` comes back from the venue as `BTCUSD`, and `canonicalSymbol` strips the
 * slash by design — so anything reading `getPositions()` or a snapshot key sees a spelling the
 * slash test calls an equity. Three layers each had their own weaker version of this.
 *
 * A ticker ending in a quote currency would be a false positive. None exists in US equities, and
 * the cost if one appears is a skipped venue stop — a stated unknown, not a wrong number.
 * `BRK-B` is deliberately NOT matched: the hyphen there is a class-share spelling, and `B` is
 * not a quote currency.
 */
const CRYPTO_PAIR = /(^|[/-])(BTC|ETH|LTC|BCH|SOL|DOGE|AVAX|LINK|UNI|AAVE|DOT|MATIC|XRP|ADA)?[/-]?(USD|USDT|USDC)$/;

export function isCryptoSymbol(s: string): boolean {
  return s.includes('/') || CRYPTO_PAIR.test(s.toUpperCase());
}

/**
 * A crypto symbol in the spelling Alpaca's crypto market-data endpoints demand: `BTC/USD`.
 *
 * The inverse of what `canonicalSymbol` does, and needed for the same reason it exists. A
 * pair is written three ways in this system — `BTC/USD` as an order is placed, `BTCUSD` as
 * the venue reports the resulting position, `BTC-USD` as Yahoo wants it — and
 * `/v1beta3/crypto/us/bars` accepts only the first. It does not fall back or guess: asking
 * it for `BTCUSD` returns `400 invalid symbol: BTCUSD does not match ^[A-Z]+x?/[A-Z]+$`
 * (measured 2026-08-29). So a holding read straight from `getPositions()` cannot be used to
 * fetch its own bars without passing through here.
 *
 * Canonicalizes first and re-splits, rather than inserting a slash where one is missing, so
 * that all three spellings converge on one answer. The quote currencies are ordered
 * longest-first because `USDT` and `USDC` both end in a string that is itself a quote
 * currency. A symbol this cannot parse is returned uppercased and unchanged — the venue
 * rejecting it by name is a better failure than a slash guessed into the wrong place.
 */
export function cryptoPair(s: string): string {
  const flat = canonicalSymbol(s);
  const parts = flat.match(/^([A-Z0-9]+?)(USDT|USDC|USD)$/);
  return parts ? `${parts[1]}/${parts[2]}` : flat;
}
