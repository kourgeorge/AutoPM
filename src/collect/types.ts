/**
 * L1 — data provenance.
 *
 * Every value crossing out of the collection layer carries where it came from and
 * how old it is. Detectors (L2) narrow with `isUsable` before reading, so the
 * compiler — not a code review — is what stops an event firing on a dead feed.
 */

export type SourceId = 'yahoo' | 'alpaca' | 'ibkr' | 'derived';

export interface Observation<T> {
  value: T;
  source: SourceId;
  /** Timestamp of the DATA, not of the fetch. */
  asOf: string;
  fetchedAt: string;
  stale: boolean;
  /**
   * Did trading confirm this number, or is it only what somebody was asking?
   *
   * The third provenance axis, and PRICES ONLY — nothing else crossing this layer has a
   * tape to be confirmed against, so every other observation leaves it undefined.
   *
   * True for a print, and for a book midpoint that trading corroborates (see
   * `priceSource.ts`). False for a midpoint nothing corroborates: a book so wide that no
   * one would deal at the middle of it, or one floating clear of the day's traded range.
   * Such a price is still the best number available and is still reported — it just may
   * not set a record, because a high-water mark is permanent and a quote is not.
   *
   * UNDEFINED MEANS "no reason to doubt it", not "unconfirmed". Only a source that
   * actually distinguishes the two cases sets the field, so a reader must treat absence
   * as permission — otherwise adding this field would have silently frozen every baseline
   * fed by a source that does not report a book at all.
   */
  tradeConfirmed?: boolean;
}

export interface Missing {
  value: null;
  source: SourceId;
  fetchedAt: string;
  error: string;
  /** Always true — absence is maximally stale. */
  stale: true;
}

export type Maybe<T> = Observation<T> | Missing;

export const isPresent = <T>(m: Maybe<T>): m is Observation<T> => m.value !== null;
export const isUsable = <T>(m: Maybe<T>): m is Observation<T> => isPresent(m) && !m.stale;

/**
 * Fallback staleness threshold. Callers that have a policy loaded should pass
 * `policy.triggers.maxQuoteAgeMs` explicitly; this constant exists so L1 is
 * usable before L0 lands.
 */
export const DEFAULT_MAX_AGE_MS = 90_000;

/**
 * How far into the future an `asOf` may sit before we stop believing it.
 *
 * Exchange timestamps are stamped against the exchange's clock, so on a machine whose
 * own clock lags — NTP drift of a few seconds is routine, and unremarkable enough that
 * nothing else notices — the freshest possible quote arrives dated in the future. Read
 * as an age that is a negative number, which is precisely the opposite of stale.
 *
 * The tolerance is generous because the direction is the safe one: a future `asOf`
 * cannot describe old data. Beyond it, the timestamp is not drift but nonsense.
 */
export const MAX_CLOCK_SKEW_MS = 30_000;

export function observe<T>(
  value: T,
  source: SourceId,
  asOf: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Observation<T> {
  const fetchedAt = new Date().toISOString();
  const ageMs = Date.parse(fetchedAt) - Date.parse(asOf);
  return {
    value,
    source,
    asOf,
    fetchedAt,
    // NaN age (unparseable asOf) counts as stale — an unknown age is not a fresh one.
    // Kept distinct from a negative age: that one is clock skew, not a dead feed.
    stale: Number.isNaN(ageMs) || ageMs < -MAX_CLOCK_SKEW_MS || ageMs > maxAgeMs,
  };
}

export function missing(source: SourceId, error: string): Missing {
  return {
    value: null,
    source,
    fetchedAt: new Date().toISOString(),
    error,
    stale: true,
  };
}

/** Normalizes a thrown value into the `error` string of a `Missing`. */
export function missingFrom(source: SourceId, err: unknown): Missing {
  const message = err instanceof Error ? err.message : String(err);
  return missing(source, message);
}
