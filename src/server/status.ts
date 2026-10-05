import { runtimeStatus } from '../core/runtime';
import { getLastTick } from '../features/lastTick';
import { getOpenProposals } from '../core/proposals';
import { getState } from '../state/state';
import { protectionIntents } from '../strategy/protectionIntent';
import { sameSymbol } from '../core/symbols';

export function serviceStatus() {
  const runtime = runtimeStatus(), tick = getLastTick(), state = getState();
  const issues: string[] = [];
  const ageMs = tick ? Date.now() - Date.parse(tick.tickAt) : null;
  if (!runtime.ready) issues.push(runtime.error ?? 'Account worker is starting');
  if (!runtime.lastExecutionAt || Date.now() - Date.parse(runtime.lastExecutionAt) > 30_000) issues.push('Execution checks are overdue');
  if (ageMs == null || ageMs > 180_000) issues.push('Account data is unavailable or stale');
  if (tick?.positionsStale) issues.push('Holdings could not be refreshed');
  if (tick?.ordersStale) issues.push('Broker orders could not be refreshed');
  if (tick?.account.equity == null) issues.push('Account equity is unavailable');
  const unresolved = getOpenProposals().filter(p => p.status === 'unknown');
  if (unresolved.length) issues.push(`${unresolved.length} broker action(s) need reconciliation`);
  const protection = Object.values(protectionIntents()).filter(p => p.status !== 'confirmed');
  if (protection.length) issues.push(`${protection.length} protection request(s) need review`);
  const unprotected = !tick || tick.positionsStale || tick.ordersStale ? [] : Object.values(tick.positions).filter(p => {
    const snap = state.positionSnapshots[p.symbol];
    return snap && !tick.orders?.some(o => o.id === snap.stopOrderId && sameSymbol(o.symbol, p.symbol) && o.type === 'stop' && o.side === 'sell' && o.qty - o.filled >= p.qty);
  }).map(p => p.symbol);
  if (unprotected.length) issues.push('Managed positions without confirmed full stop coverage: ' + unprotected.join(', '));
  return { ready: issues.length === 0, runtime, paused: state.paused, dailyLossHalted: state.dailyLossHalted,
    ageMs, issues, unresolved, protection, unprotected };
}
