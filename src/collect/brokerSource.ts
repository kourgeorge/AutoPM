/**
 * L1 — broker state, provenance-stamped.
 *
 * The broker is authoritative and has no data timestamp of its own, so `asOf` is
 * the fetch time. It can still go `Missing` when the API is unreachable, and that
 * distinction is what keeps L2 from reading an empty book as "flat".
 */

import { broker } from '../broker';
import type { AccountInfo, OpenOrder, Position } from '../broker/IBroker';
import { config } from '../core/config';
import { Maybe, missingFrom, observe, SourceId } from './types';

// Broker reads are point-in-time truth: fresh the moment they return.
const FRESH_MS = Number.POSITIVE_INFINITY;

/**
 * Which venue these reads came from.
 *
 * Read from the config, which is the same value `src/broker/index.ts` selected the
 * implementation with, so provenance cannot disagree with the broker that produced it.
 * This used to sniff `broker.constructor.name` for "ibkr", which is a leak of the
 * concrete class through the `IBroker` seam and, worse, fails SILENTLY: a class rename
 * or a third implementation stamps every L1 observation `alpaca`. The annotation is
 * load-bearing — a broker added to the config union without a matching `SourceId` is a
 * compile error here rather than a mislabel at runtime.
 */
const SOURCE: SourceId = config.broker;

export async function collectPositions(): Promise<Maybe<Position[]>> {
  try {
    const positions = await broker.getPositions();
    return observe(positions, SOURCE, new Date().toISOString(), FRESH_MS);
  } catch (err) {
    return missingFrom(SOURCE, err);
  }
}

export async function collectAccount(): Promise<Maybe<AccountInfo>> {
  try {
    const account = await broker.getAccountInfo();
    return observe(account, SOURCE, new Date().toISOString(), FRESH_MS);
  } catch (err) {
    return missingFrom(SOURCE, err);
  }
}

export async function collectOpenOrders(): Promise<Maybe<OpenOrder[]>> {
  try {
    const orders = await broker.getOpenOrders();
    return observe(orders, SOURCE, new Date().toISOString(), FRESH_MS);
  } catch (err) {
    return missingFrom(SOURCE, err);
  }
}
