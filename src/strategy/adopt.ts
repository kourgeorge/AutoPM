import crypto from 'crypto';
import { broker } from '../broker';
import { canonicalSymbol, isCryptoSymbol, sameSymbol } from '../core/symbols';
import { assertExecutionOwner } from '../core/runtime';
import { appendRecord, transaction } from '../core/storage';
import { getState, openPositionSnapshot } from '../state/state';

/**
 * Why an adoption was refused. `invalid` is a bad request (prices malformed); `conflict` is a
 * request that is well-formed but the book does not allow (no mark, stop above the price,
 * already managed, external orders resting). The HTTP route maps these to 400 and 409.
 */
export class AdoptRefused extends Error {
  constructor(readonly kind: 'invalid' | 'conflict', message: string) { super(message); }
}

/**
 * Hand an existing holding to the bot: record a managed snapshot with the operator's stop and
 * optional target. The venue protection itself is placed by `sweepStops` on its next pass —
 * this only records the intent, so it returns before any order exists at the broker.
 *
 * One function for both the browser dashboard and the terminal `/adopt` command, so the
 * checks cannot drift apart between them.
 */
export async function adoptHolding(rawSymbol: string, stop: number, target: number | undefined, actorId: string): Promise<{ symbol: string; qty: number; mark: number }> {
  const symbol = canonicalSymbol(rawSymbol);
  if ([stop, target].some(level => level != null && Math.abs(level * 100 - Math.round(level * 100)) > 1e-8)) throw new AdoptRefused('invalid', 'Stop and target prices must use whole cents');
  if (isCryptoSymbol(symbol) || !(stop > 0) || !Number.isFinite(stop) || (target != null && (!Number.isFinite(target) || target <= stop))) throw new AdoptRefused('invalid', 'Provide valid equity stop and target prices');
  const positions = await broker.getPositions();
  const held = positions.find(p => sameSymbol(p.symbol, symbol));
  const mark = held?.marketValue != null && held.qty > 0 ? held.marketValue / held.qty : null;
  if (!held || held.qty <= 0) throw new AdoptRefused('conflict', `No long holding of ${symbol} at the broker`);
  if (held.assetClass === 'other') throw new AdoptRefused('conflict', `${symbol} is not a US-dollar stock, so it cannot be managed`);
  if (!Number.isInteger(held.qty)) throw new AdoptRefused('conflict', `${symbol} is a fractional holding (${held.qty} shares); only whole shares can be managed`);
  if (mark == null) throw new AdoptRefused('conflict', `The broker has not reported a current price for ${symbol} yet; try again shortly`);
  if (stop >= mark) throw new AdoptRefused('conflict', `Stop ${stop.toFixed(2)} must be below the current price ${mark.toFixed(2)}`);
  if (target != null && target <= mark) throw new AdoptRefused('conflict', `Target ${target.toFixed(2)} must be above the current price ${mark.toFixed(2)}`);
  if (getState().positionSnapshots[symbol]) throw new AdoptRefused('conflict', 'Position is already managed');
  if ((await broker.getOpenOrders()).some(o => sameSymbol(o.symbol, symbol))) throw new AdoptRefused('conflict', 'Review existing broker orders before adopting this holding');
  assertExecutionOwner();
  transaction(() => {
    openPositionSnapshot({ symbol, entryPrice: held.avgCost, stopLevel: stop, takeProfitLevel: target });
    appendRecord('operator-commands', crypto.randomUUID(), new Date().toISOString(), { actorId, action: 'adopt', symbol, stop, target, qty: held.qty });
  });
  return { symbol, qty: held.qty, mark };
}
