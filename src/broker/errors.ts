/**
 * A venue refusal, with the venue's own words attached.
 *
 * This exists because of a live incident. `execute_exit` on NVDA got an Alpaca 403;
 * `placeOrder` threw the raw axios error, whose `response.data.message` carries Alpaca's
 * actual reason and was never read; the tool layer flattened it to
 * `"Request failed with status code 403"`; and the model — given a number and no cause —
 * invented one, recorded *"403 error (market hours restriction)"*, and moved on.
 *
 * An `Error` subclass rather than a return value, so `IBroker` is unchanged and no caller
 * can ignore it by forgetting to check a field.
 */

import type { OrderRequest } from './IBroker';

/**
 * What was asked of the venue. Not every request is a new order: moving a resting stop names
 * an existing one and carries no side or qty, so describing it as an `OrderRequest` would have
 * meant inventing both to fill the message template.
 */
export type BrokerAttempt =
  | OrderRequest
  | { replaceStopOrderId: string; stopPrice: number };

function describe(req: BrokerAttempt): string {
  return 'replaceStopOrderId' in req
    ? `stop move on order ${req.replaceStopOrderId} to ${req.stopPrice}`
    : `${req.side} ${req.qty} ${req.symbol}`;
}

export class BrokerRejection extends Error {
  constructor(
    readonly status: number | null,
    /** The venue's own explanation. Never paraphrase it — it is evidence. */
    readonly venueMessage: string,
    readonly venueCode: string | number | null,
    readonly request: BrokerAttempt,
  ) {
    super(`Broker rejected ${describe(request)}: ${status ?? '?'} ${venueMessage}`);
    this.name = 'BrokerRejection';
  }
}
