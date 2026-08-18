export interface Position {
  symbol: string;
  qty: number;
  avgCost: number;
  marketValue?: number;
  unrealizedPnL?: number;
}

export interface AccountInfo {
  equity: number;
  cash: number;
  buyingPower: number;
  /**
   * Equity at the previous session's close, or `null` when the venue does not report it.
   *
   * The daily loss limit is measured against the start of the day, and the only other source
   * for that number is "whatever equity was when this process happened to start" — which
   * reads a mid-session start as a flat day and switches the limit off. `null` is never to be
   * substituted with `0` or with current equity here; the caller decides what to do without it
   * and says so.
   */
  previousCloseEquity: number | null;
}

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  type: 'market' | 'limit';
  limitPrice?: number;
}

export interface OpenOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  filled: number;
  type: 'market' | 'limit';
  limitPrice?: number;
  status: string;
}

/**
 * One execution, as the venue reports it — the only account of a trade that is not this
 * system's own opinion of it. `execute_entry` records the price the model *expected* and
 * `execute_exit` the mark *before* the sell; neither is what was paid.
 *
 * A single order produces several of these (partial fills), so nothing here is per-order:
 * the round trip is assembled from fills by `src/review/ledger.ts`.
 */
export interface Fill {
  /**
   * The venue's own per-fill id, and the ledger's dedup key.
   *
   * IBKR signals a *correction* with an execId differing from an earlier one only in the
   * digits after the final period (".01" superseded by ".02"), so the ledger keys on the
   * part before that period and keeps the highest suffix. Do not reformat this string.
   */
  execId: string;
  /** What `placeOrder` returned. The join back to the journal's decision record. */
  orderId: string;
  /** IBKR's durable order id, which survives client sessions where `orderId` does not. */
  permId: string | null;
  /** Canonical symbol, matching what `getPositions` reports for the same instrument. */
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  /**
   * Commissions and fees, `null` when the venue did not tell us — which is NOT zero.
   * Alpaca bills regulatory fees as separate activities, so a fill's fee is genuinely
   * unknown here; reading `null` as `0` would make expectancy incomparable across brokers.
   */
  fee: number | null;
  /** ISO 8601, UTC. */
  at: string;
}

export interface IBroker {
  getPositions(): Promise<Position[]>;
  getAccountInfo(): Promise<AccountInfo>;
  getOpenOrders(): Promise<OpenOrder[]>;
  placeOrder(order: OrderRequest): Promise<{ id: string }>;
  cancelOrder(id: string): Promise<void>;
  isMarketOpen(): Promise<boolean>;
  /**
   * Recent executions, newest-last.
   *
   * `since` is a HINT, not a contract: an implementation may return fills older than it,
   * and IBKR's cannot honour it at all beyond the current trading day. Callers must be
   * idempotent — the ledger dedups on `execId`, which makes over-fetching free and
   * under-fetching the only real failure. Never treat the result as complete history:
   * TWS serves the current day only.
   */
  getFills(since?: Date): Promise<Fill[]>;
}
