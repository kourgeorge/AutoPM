import { broker } from '../broker';
import { getState } from '../state/state';
import { sameSymbol } from '../core/symbols';
import { readDecision, recordDecisionOutcome } from './journal';

/** Refresh current protection facts without rewriting entry intent or management rationale. */
export async function refreshJournalProtection(): Promise<void> {
  const snapshots = Object.values(getState().positionSnapshots);
  if (!snapshots.length) return;
  const [orders, positions] = await Promise.all([broker.getOpenOrders(), broker.getPositions()]).catch(err => {
    for (const snap of snapshots) for (const id of [snap.entryDecisionId, snap.managementDecisionId]) {
      if (id && readDecision(id)) recordDecisionOutcome(id, { protectionStatus: 'unknown', venueStopMissing: 'Broker protection could not be read: ' + err.message });
    }
    throw err;
  });
  for (const snap of snapshots) {
    const held = positions.find(p => sameSymbol(p.symbol, snap.symbol));
    if (!held || held.qty <= 0) continue;
    const stop = orders.find(o => o.id === snap.stopOrderId && sameSymbol(o.symbol, snap.symbol) && o.side === 'sell' && ['stop','stop_limit'].includes(o.type)
      && o.stopPrice === snap.stopLevel && o.qty - o.filled >= held.qty);
    const target = snap.takeProfitLevel == null || orders.some(o => o.id === snap.takeProfitOrderId && sameSymbol(o.symbol, snap.symbol)
      && o.side === 'sell' && o.type === 'limit' && o.limitPrice === snap.takeProfitLevel && o.qty-o.filled >= held.qty);
    const confirmed = !!stop && target;
    for (const id of [snap.entryDecisionId, snap.managementDecisionId]) {
      if (!id) continue;
      if (!readDecision(id)) continue;
      const status = confirmed ? 'confirmed' : 'unknown';
      // Saves only a change: a check that found what was already recorded is not history.
      recordDecisionOutcome(id, { protectionStatus: status, venueStopId: stop?.id ?? null,
        protectionStopLevel: stop?.stopPrice ?? null,
        venueStopMissing: confirmed ? null : 'Current broker orders do not confirm full protection at the desired levels' });
    }
  }
}
