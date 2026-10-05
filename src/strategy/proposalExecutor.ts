import { broker } from '../broker';
import { BrokerRejection } from '../broker/errors';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { getPolicyHash } from '../policy/load';
import { getOpenProposals, getProposal, transitionProposal, ensureProposalDecision } from '../core/proposals';
import { getState, getPositionSnapshot, openPositionSnapshot, removePositionSnapshot, type Proposal } from '../state/state';
import type { SignalResult } from '../core/types';
import type { ExecutionOrder } from '../broker/IBroker';
import { GuardRejection, validateEntry, actEntry, validateExit, actExit } from './orderManager';
import { validateAnnotation, actAnnotation, type AnnotateInput } from './annotation';
import { decision, recordDecision, recordDecisionOutcome } from '../journal/journal';
import { readFills } from '../review/fillsLedger';
import { transaction } from '../core/storage';
import { sameSymbol } from '../core/symbols';
import { assertExecutionOwner } from '../core/runtime';

let sweep: Promise<void> | null = null;

function validScope(p: Proposal): boolean {
  return !!p.accountId && p.accountId === getState().accountId && p.venue === config.venue;
}

/** No side effect is retried without a broker read establishing its outcome. */
async function reconcile(p: Proposal): Promise<void> {
  ensureProposalDecision(p);
  if (p.kind !== 'entry' && p.kind !== 'exit') {
    const snap = getPositionSnapshot(p.symbol);
    const [orders, positions] = await Promise.all([broker.getOpenOrders(), broker.getPositions()]);
    const held = positions.find(pos => sameSymbol(pos.symbol, p.symbol));
    const stop = orders.find(o => o.id === snap?.stopOrderId && sameSymbol(o.symbol, p.symbol) && o.side === 'sell' && o.type === 'stop');
    const target = orders.find(o => o.id === snap?.takeProfitOrderId && sameSymbol(o.symbol, p.symbol) && o.side === 'sell' && o.type === 'limit');
    if (held && held.qty > 0 && stop && stop.qty-stop.filled >= held.qty && stop.stopPrice === p.params.stopLoss &&
        (snap?.takeProfitLevel == null || (target && target.qty-target.filled >= held.qty && target.limitPrice === snap.takeProfitLevel))) {
      recordDecisionOutcome('action-' + p.id, { executed: true, orderStatus: 'executed', protectionStatus: 'confirmed', venueStopId: stop.id, venueStopMissing: null });
      transitionProposal(p.id, 'executed', { result: {} }); return;
    }
    if (p.status === 'executing') transitionProposal(p.id, 'unknown', { result: { error: 'Adjustment interrupted; review broker protection before retrying' } });
    return;
  }
  let order = p.result?.orderId ? await broker.getOrder(p.result.orderId)
    : p.clientOrderId ? await broker.findOrder(p.clientOrderId) : null;
  const expectedQty = p.result?.qty;
  if (!order && p.result?.orderId && expectedQty) {
    const fills = readFills().filter(f => f.orderId === p.result?.orderId && sameSymbol(f.symbol, p.symbol)
      && f.side === (p.kind === 'entry' ? 'buy' : 'sell') && Date.parse(f.at) >= p.createdAt);
    const qty = fills.reduce((sum, f) => sum + f.qty, 0);
    if (qty >= expectedQty) order = { id: p.result.orderId, symbol: p.symbol,
      side: p.kind === 'entry' ? 'buy' : 'sell', qty: expectedQty, filledQty: qty,
      filledPrice: fills.reduce((sum, f) => sum + f.price * f.qty, 0) / qty, status: 'filled' };
  }
  if (!order) {
    if (p.status !== 'unknown') transitionProposal(p.id, 'unknown', { result: { ...p.result, error: 'Broker outcome is unknown; this action will not be resubmitted' } });
    return;
  }
  if ((p.result?.qty != null && order.qty !== p.result.qty) || !sameSymbol(order.symbol, p.symbol) || order.side !== (p.kind === 'entry' ? 'buy' : 'sell')) {
    throw new Error('Broker order identity does not match the saved action');
  }
  if (!Number.isFinite(order.qty) || order.qty <= 0 || !Number.isFinite(order.filledQty) || order.filledQty < 0 || order.filledQty > order.qty ||
      (order.filledQty > 0 && (order.filledPrice == null || !Number.isFinite(order.filledPrice) || order.filledPrice <= 0))) {
    throw new Error('Broker execution quantities or fill price are incomplete; inspect the broker outcome');
  }
  const result = { orderId: order.id, qty: order.qty, filledQty: order.filledQty,
    ...(order.filledPrice != null ? { filledPrice: order.filledPrice } : {}) };
  const terminal = ['filled', 'cancelled', 'rejected'].includes(order.status);
  const status = order.status === 'filled' || (terminal && order.filledQty > 0) ? 'executed' : terminal ? 'failed' : order.filledQty > 0 ? 'partial' : 'submitted';
  const positions = p.kind === 'exit' && terminal ? await broker.getPositions() : null;
  transaction(() => {
    const signal = p.params.signal as SignalResult | undefined;
    recordDecision(decision(p.kind as 'entry' | 'exit', 'trader', {
      symbol: p.symbol, rationale: p.reason, triggerEventId: p.eventId, proposalId: p.id,
      accountId: p.accountId, policyHash: p.policyHash, executed: order!.filledQty > 0, orderStatus: order!.status,
      qty: order!.qty, price: signal?.price ?? null, orderId: order!.id,
      intendedStop: signal?.stopLoss ?? null, intendedTarget: signal?.takeProfit ?? null, atrAtEntry: signal?.atr ?? null,
    }), 'action-' + p.id);
    recordDecisionOutcome('action-' + p.id, {
      orderStatus: order!.status, executed: order!.filledQty > 0, requestedQty: order!.qty, filledQty: order!.filledQty, fillPrice: order!.filledPrice ?? null,
      qty: order!.filledQty, price: order!.filledQty > 0 ? order!.filledPrice : null,
    });
    if (p.kind === 'entry' && order!.filledQty > 0 && order!.filledPrice != null) {
      const signal = p.params.signal as SignalResult;
      const stored = getPositionSnapshot(p.symbol);
      const old = stored?.entryDecisionId === 'action-' + p.id ? stored : undefined;
      openPositionSnapshot({ ...old, symbol: p.symbol, entryPrice: order!.filledPrice,
        sessionHigh: Math.max(old?.sessionHigh ?? order!.filledPrice, order!.filledPrice),
        sessionLow: Math.min(old?.sessionLow ?? order!.filledPrice, order!.filledPrice),
        stopLevel: old?.stopLevel ?? signal.stopLoss, takeProfitLevel: old?.takeProfitLevel ?? signal.takeProfit,
        openedAt: old?.openedAt ?? new Date().toISOString(), entryDecisionId: 'action-' + p.id });
    }
    if (positions && !positions.some(pos => sameSymbol(pos.symbol, p.symbol) && pos.qty !== 0)) removePositionSnapshot(p.symbol);
    const current = getProposal(p.id)!;
    if (current.status !== status || current.result?.filledQty !== result.filledQty) {
      if (current.status === 'executing' && status === 'partial') transitionProposal(p.id, 'partial', { result });
      else if (current.status !== status || status === 'partial') transitionProposal(p.id, status, { result: {
        ...result, ...(terminal && status === 'failed' ? { error: 'Broker order ' + order!.status } : {}),
      } });
    }
  });
}

async function execute(p: Proposal): Promise<void> {
  if (!validScope(p) || p.policyHash !== getPolicyHash()) {
    transitionProposal(p.id, 'failed', { result: { error: 'Account, venue, or strategy revision changed; request a fresh action' } });
    return;
  }
  if (Date.now() >= p.expiresAt) { transitionProposal(p.id, 'expired', { decidedBy: 'timeout' }); return; }
  if (getState().paused) return;
  // Only one account-changing order may be outstanding. This reserves exposure without
  // another independent accounting model for pending capital.
  if (getOpenProposals().some(other => other.id !== p.id && ['executing','submitted','partial','unknown'].includes(other.status))) return;
  try {
    const entry = p.kind === 'entry' ? await validateEntry((p.params as any).signal, Number(p.params.qty), Number(p.params.maxQty ?? p.params.qty)) : null;
    const exit = p.kind === 'exit' ? await validateExit(p.symbol, Number(p.params.qty)) : null;
    const annotation = !entry && !exit ? await validateAnnotation(p.params as unknown as AnnotateInput) : null;
    if (annotation && !annotation.ok) throw new Error(JSON.parse(annotation.response).error);
    // Re-check after network waits: a user may have paused or changed policy meanwhile.
    if (getState().paused) return;
    if (!validScope(p) || p.policyHash !== getPolicyHash() || Date.now() >= p.expiresAt) {
      transitionProposal(p.id, 'expired', { result: { error: 'Action changed or expired during validation' } }); return;
    }
    assertExecutionOwner();
    transitionProposal(p.id, 'executing', { result: { qty: entry?.regimeQty ?? exit?.sellQty } });
    if (entry || exit) {
      const result = entry ? await actEntry(entry, p.clientOrderId) : await actExit(p.symbol, p.reason, exit!, p.clientOrderId);
      transaction(() => {
        recordDecision(decision(p.kind as 'entry' | 'exit', 'trader', {
          symbol: p.symbol, rationale: p.reason, triggerEventId: p.eventId, proposalId: p.id,
          accountId: p.accountId, policyHash: p.policyHash, executed: false, orderStatus: 'submitted', requestedQty: result.qty, filledQty: 0,
          qty: result.qty, price: entry?.price ?? exit?.price ?? null, orderId: result.orderId,
          intendedStop: entry?.stopLoss ?? null, intendedTarget: entry?.takeProfit ?? null, atrAtEntry: entry?.atr ?? null,
        }), 'action-' + p.id);
        recordDecisionOutcome('action-' + p.id, { orderStatus: 'submitted', orderId: result.orderId, requestedQty: result.qty, filledQty: 0, qty: 0, price: null });
        transitionProposal(p.id, 'submitted', { result: { orderId: result.orderId, qty: result.qty } });
      });
      await reconcile(getProposal(p.id)!);
    } else if (annotation?.ok) {
      const result = JSON.parse(await actAnnotation(annotation, p));
      const unconfirmed = result.error || result.venueOco?.stopOrderId === null || result.venueStop?.orderId === null;
      transitionProposal(p.id, unconfirmed ? 'unknown' : 'executed', { result: unconfirmed ? { error: result.error ?? 'Protection update is not confirmed at the broker' } : {} });
    }
  } catch (err: any) {
    const current = getProposal(p.id)!;
    const message = err?.message ?? String(err);
    if (current.status === 'approved') transitionProposal(p.id, 'failed', { result: { error: message } });
    else if (current.status === 'executing') transitionProposal(p.id, (err instanceof GuardRejection && ['paused_before_submission','position_changed','external_order'].includes(err.rule)) || err instanceof BrokerRejection && err.status != null && err.status >= 400 && err.status < 500 && ![408,409,429].includes(err.status) ? 'failed' : 'unknown', { result: { ...current.result, error: message } });
    recordDecisionOutcome('action-' + p.id, { orderStatus: getProposal(p.id)?.status, vetoRule: err instanceof GuardRejection ? err.rule : null, venueMessage: err instanceof BrokerRejection ? err.venueMessage : null });
    logger.warn('[Execution] ' + p.id + ': ' + message);
  }
}

async function runSweep(): Promise<void> {
  for (const p of getOpenProposals()) {
    if (p.status === 'pending' && Date.now() >= p.expiresAt) transitionProposal(p.id, 'expired', { decidedBy: 'timeout' });
    if (['executing','submitted','partial','unknown'].includes(p.status) && validScope(p)) {
      try { await reconcile(p); } catch (err: any) {
        if (getProposal(p.id)?.status !== 'unknown') transitionProposal(p.id, 'unknown', { result: { ...p.result, error: err.message } });
        logger.warn('[Reconcile] ' + p.id + ': ' + err.message);
      }
    }
  }
  const next = getOpenProposals().find(p => p.status === 'approved');
  if (next) await execute(next);
}
export function sweepProposals(): Promise<void> {
  if (!sweep) sweep = runSweep().finally(() => { sweep = null; });
  return sweep;
}
