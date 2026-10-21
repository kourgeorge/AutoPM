import type { OpenOrder } from '../broker/IBroker';
import type { PositionData } from '../features/compute';
import type { Order, PositionSnapshot } from '../state/state';
import type { DecisionRecord } from '../journal/types';
import { canonicalSymbol } from '../core/symbols';

/**
 * The broker's resting orders, each joined to what this system knows about it: which holding it
 * belongs to, whether this system placed it and why, and what happens if it fires.
 *
 * Pure: the caller supplies the last tick's orders and positions plus saved state, so the page
 * costs no broker calls. The broker's own fields are passed through untouched; everything added
 * here is labelled as this system's reading of them.
 */
export type BrokerOrderRole = 'stop' | 'target' | 'entry' | 'exit' | 'protection' | 'external';

export interface BrokerBookInput {
  orders: OpenOrder[];
  positions: PositionData[];
  snapshots: Record<string, PositionSnapshot>;
  agentOrders: Order[];
  protection: Record<string, { id: string; status: string; at: string; stop: number; target?: number; error?: string }>;
  decision: (id: string) => DecisionRecord | undefined;
}

export function brokerBook(input: BrokerBookInput) {
  const { orders, positions, snapshots, agentOrders, protection, decision } = input;
  const holding = (symbol: string) => positions.find(p => canonicalSymbol(p.symbol) === canonicalSymbol(symbol));
  const snapshotFor = (symbol: string) => snapshots[canonicalSymbol(symbol)];

  const rows = orders.map(o => {
    const snap = snapshotFor(o.symbol), held = holding(o.symbol);
    const agentOrder = agentOrders.find(a => (a.result?.brokerOrderId && a.result.brokerOrderId === o.id)
      || (a.clientOrderId && a.clientOrderId === o.clientOrderId));
    const intent = protection[canonicalSymbol(o.symbol)];
    const role: BrokerOrderRole = snap?.stopOrderId === o.id ? 'stop'
      : snap?.takeProfitOrderId === o.id ? 'target'
      : agentOrder ? (agentOrder.kind === 'entry' ? 'entry' : agentOrder.kind === 'exit' ? 'exit' : 'protection')
      : (o.clientOrderId && intent && o.clientOrderId === intent.id) || o.clientOrderId?.startsWith('atp-') ? 'protection'
      : 'external';
    const remaining = Math.max(0, o.qty - o.filled);
    const trigger = o.type === 'stop' || o.type === 'stop_limit' ? o.stopPrice ?? null : o.type === 'limit' ? o.limitPrice ?? null : null;
    const price = held?.price ?? null;
    // Only a sell against a long holding has a "result if it fires" this system can state.
    const entryPrice = held && held.entryPrice > 0 ? held.entryPrice : null;
    const resultIfFilled = o.side === 'sell' && trigger != null && entryPrice != null ? (trigger - entryPrice) * remaining : null;
    const recordedLevel = role === 'stop' ? snap?.stopLevel ?? null : role === 'target' ? snap?.takeProfitLevel ?? null : null;
    const entry = snap?.entryDecisionId ? decision(snap.entryDecisionId) : undefined;
    const management = snap?.managementDecisionId ? decision(snap.managementDecisionId) : undefined;
    const pair = o.groupId ? orders.find(other => other.groupId === o.groupId && other.id !== o.id) : undefined;
    return {
      ...o,
      remaining,
      role,
      placedByThisSystem: role !== 'external',
      triggerPrice: trigger,
      currentPrice: price,
      priceStale: held?.stale ?? null,
      // Positive = price must fall to reach the level, negative = must rise.
      distancePct: trigger != null && price != null && price > 0 ? (price - trigger) / price * 100 : null,
      notional: trigger != null ? trigger * remaining : null,
      resultIfFilled,
      recordedLevel,
      levelMismatch: recordedLevel != null && trigger != null && Math.abs(recordedLevel - trigger) > 0.01,
      pairedWith: pair ? { id: pair.id, type: pair.type, price: pair.stopPrice ?? pair.limitPrice ?? null } : null,
      position: held ? { qty: held.qty, entryPrice, price, pnlPct: held.pnlPct, covers: remaining >= held.qty } : null,
      agentOrder: agentOrder ? { id: agentOrder.id, kind: agentOrder.kind, status: agentOrder.status, reason: agentOrder.reason,
        createdAt: agentOrder.createdAt, decidedBy: agentOrder.decidedBy, automatic: !!agentOrder.automatic } : null,
      entryDecision: entry ? { id: entry.id, at: entry.at, rationale: entry.rationale, intendedStop: entry.intendedStop,
        intendedTarget: entry.intendedTarget, invalidation: (entry as any).thesis?.invalidation ?? null } : null,
      managementDecision: management ? { id: management.id, at: management.at, rationale: management.rationale } : null,
      protectionRequest: intent && (role === 'stop' || role === 'target' || role === 'protection')
        ? { id: intent.id, status: intent.status, at: intent.at, error: intent.error ?? null } : null,
    };
  });

  // Per holding: is it covered at the broker, and by whom.
  const coverage = positions.map(p => {
    const mine = rows.filter(r => canonicalSymbol(r.symbol) === canonicalSymbol(p.symbol) && r.side === 'sell');
    const stops = mine.filter(r => r.type === 'stop' || r.type === 'stop_limit' || r.type === 'trailing_stop');
    const covered = stops.reduce((sum, r) => sum + r.remaining, 0);
    const snap = snapshotFor(p.symbol);
    return {
      symbol: p.symbol, qty: p.qty, managed: !!snap,
      stopShares: covered,
      status: covered >= p.qty ? 'protected' : covered > 0 ? 'partial' : 'none',
      recordedStop: snap?.stopLevel ?? null, recordedTarget: snap?.takeProfitLevel ?? null,
      // The highest stop fires first.
      firstStop: stops.some(r => r.triggerPrice != null) ? Math.max(...stops.flatMap(r => r.triggerPrice ?? [])) : null,
    };
  });

  return {
    orders: rows,
    coverage,
    summary: {
      count: rows.length,
      byThisSystem: rows.filter(r => r.placedByThisSystem).length,
      external: rows.filter(r => !r.placedByThisSystem).length,
      withoutPosition: rows.filter(r => !r.position).length,
      unprotected: coverage.filter(c => c.status !== 'protected').map(c => c.symbol),
      mismatches: rows.filter(r => r.levelMismatch).map(r => r.symbol),
    },
  };
}
