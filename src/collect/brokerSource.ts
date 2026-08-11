/**
 * L1 — broker state, provenance-stamped.
 *
 * The broker is authoritative and has no data timestamp of its own, so `asOf` is
 * the fetch time. It can still go `Missing` when the API is unreachable, and that
 * distinction is what keeps L2 from reading an empty book as "flat".
 */

import { broker } from '../broker';
import type { AccountInfo, OpenOrder, Position } from '../broker/IBroker';
import { Maybe, missingFrom, observe, SourceId } from './types';

/** Which broker implementation is wired up, for the provenance stamp. */
export const BROKER_SOURCE: SourceId =
  broker.constructor.name.toLowerCase().includes('ibkr') ? 'ibkr' : 'alpaca';

// Broker reads are point-in-time truth: fresh the moment they return.
const FRESH_MS = Number.POSITIVE_INFINITY;

export async function collectPositions(): Promise<Maybe<Position[]>> {
  try {
    const positions = await broker.getPositions();
    return observe(positions, BROKER_SOURCE, new Date().toISOString(), FRESH_MS);
  } catch (err) {
    return missingFrom(BROKER_SOURCE, err);
  }
}

export async function collectAccount(): Promise<Maybe<AccountInfo>> {
  try {
    const account = await broker.getAccountInfo();
    return observe(account, BROKER_SOURCE, new Date().toISOString(), FRESH_MS);
  } catch (err) {
    return missingFrom(BROKER_SOURCE, err);
  }
}

export async function collectOpenOrders(): Promise<Maybe<OpenOrder[]>> {
  try {
    const orders = await broker.getOpenOrders();
    return observe(orders, BROKER_SOURCE, new Date().toISOString(), FRESH_MS);
  } catch (err) {
    return missingFrom(BROKER_SOURCE, err);
  }
}

export async function collectMarketOpen(): Promise<Maybe<boolean>> {
  try {
    const open = await broker.isMarketOpen();
    return observe(open, BROKER_SOURCE, new Date().toISOString(), FRESH_MS);
  } catch (err) {
    return missingFrom(BROKER_SOURCE, err);
  }
}
