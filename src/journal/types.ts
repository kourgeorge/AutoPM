/**
 * L5 — the history contract.
 *
 * Immutable decision intents with separately updated execution projections. This is what replaced
 * `knowledge.json`: the notes it held were the model's prose about what it had done,
 * which nothing could query and nothing could check. A `DecisionRecord` is structured,
 * so "what did the guard block this week" and "which entries went in without a stop"
 * are greps rather than readings.
 */

export type DecisionKind =
  | 'adjustment'
  /** Intent to open a position; orderStatus describes its outcome. */
  | 'entry'
  /** Intent to close a position; orderStatus describes its outcome. */
  | 'exit'
  /** A deliberate decision NOT to act — including an event acked as seen or ignored. */
  | 'hold'
  /** The L4 guard refused the intent. It never reached the venue. */
  | 'veto'
  /** The guard allowed it and the venue refused it. */
  | 'rejected';

export type DecisionActor = 'trader' | 'guard' | 'broker';

export interface DecisionRecord {
  /** `${kind}:${symbol}:${iso}` — greppable, and symmetric with event ids. */
  id: string;
  at: string;
  kind: DecisionKind;
  actor: DecisionActor;
  symbol: string | null;

  /** The machine event this decision answers, when there is one. */
  triggerEventId: string | null;
  rationale: string;

  /** True only for confirmed fills or confirmed protection changes. Legacy records require orderStatus for interpretation. */
  executed: boolean;
  qty: number | null;
  price: number | null;

  /**
   * What the decision INTENDED, recorded even when nothing filled. A veto with no
   * intended stop is indistinguishable from one with a bad stop unless this is here.
   */
  intendedPrice?: number | null;
  intendedStop: number | null;
  intendedTarget: number | null;
  atrAtEntry: number | null;

  orderId: string | null;
  /** Which guard rule refused it. Only ever set on `veto`. */
  vetoRule: string | null;
  /** The venue's own words. Only ever set on `rejected` — the antidote to an invented cause. */
  venueMessage: string | null;

  /**
   * The protective stop resting at the venue for this entry: its order id.
   *
   * Only meaningful on an executed `entry`. Exactly one of this and `venueStopMissing` is set
   * there — a stop is either resting or it is not, and both being null would mean nobody asked.
   */
  venueStopId: string | null;
  /**
   * Why no stop rests at the venue, when one was expected.
   *
   * This is the ONLY durable account of that. `armEntryStop` reports its outcome to the model in
   * the tool result and to the terminal log, and both are gone by the next cycle — so a position
   * that sat unprotected until the next sweep left no trace of why, which is exactly the question
   * asked afterwards. Measured on 2026-08-28: MA filled 2.9s after submit, inside the fill-wait,
   * and was still armed 38s later by the sweep rather than by the entry. Unanswerable at the time.
   */
  venueStopMissing: string | null;
  pnl: number | null;

  /** `Policy.version` at the moment of the decision — a number, as declared. */
  policyVersion: number;
  policyHash?: string;
  actionId?: string;
  orderStatus?: string;
  requestId?: string;
  actorId?: string;
  requestedQty?: number | null;
  filledQty?: number;
  fillPrice?: number | null;
  protectionStatus?: 'pending' | 'confirmed' | 'unknown';
  protectionCheckedAt?: string;
  protectionStopLevel?: number | null;
}

/** Everything a caller must supply. `id` and `at` are stamped by `recordDecision`. */
export type DecisionInput = Omit<DecisionRecord, 'id' | 'at'>;

/**
 * A decision that actually touched the venue — an order placed, or a resting stop/target
 * moved. `hold` is also used for a plain event acknowledgement (`toolAckEvent`), which never
 * sets `intendedStop`; only the annotation flow (`actAnnotation`) does, so that field is the
 * discriminator between the two.
 */
export function isTradeAction(r: DecisionRecord): boolean {
  return ['entry','exit','adjustment'].includes(r.kind) || (r.kind === 'hold' && r.intendedStop != null);
}

export function describeDecision(r: DecisionRecord): string {
  const status = r.orderStatus ?? (r.executed ? 'recorded (legacy outcome)' : 'recorded');
  const filled = r.filledQty != null ? `; filled ${r.filledQty}/${r.requestedQty ?? '?'}${r.fillPrice != null ? ` @ $${r.fillPrice}` : ''}` : '';
  const protection = r.intendedStop != null ? `; protection ${r.protectionStatus ?? 'unverified'}${r.protectionStopLevel != null ? ` @ $${r.protectionStopLevel}` : ''}, decision stop $${r.intendedStop}` : '';
  return `${r.kind.toUpperCase()} ${r.symbol ?? 'portfolio'} — ${status}${filled}${protection}: ${r.rationale}`;
}
