import { broker } from '../broker';
import { BrokerRejection } from '../broker/errors';
import { logger } from '../core/logger';
import { getPolicyHash } from '../policy/load';
import { pendingOrders, getOrder, transitionOrder, ensureOrderDecision } from '../core/orders';
import { getState, getPositionSnapshot, openPositionSnapshot, removePositionSnapshot, type Order } from '../state/state';
import type { SignalResult } from '../core/types';
import type { ExecutionOrder } from '../broker/IBroker';
import { GuardRejection, validateEntry, actEntry, validateExit, actExit, EXTENDED_ORDER_TTL_MS } from './orderManager';
import { validateAnnotation, actAnnotation, type AnnotateInput } from './annotation';
import { decision, recordDecision, recordDecisionOutcome } from '../journal/journal';
import { readFills } from '../review/fills';
import { transaction } from '../core/storage';
import { sameSymbol } from '../core/symbols';
import { assertExecutionOwner } from '../core/runtime';

let sweep: Promise<void> | null = null;

/** No side effect is retried without a broker read establishing its outcome. */
async function reconcile(p: Order): Promise<void> {
  ensureOrderDecision(p);
  if (p.kind !== 'entry' && p.kind !== 'exit') {
    const snap = getPositionSnapshot(p.symbol);
    const [orders, positions] = await Promise.all([broker.getOpenOrders(), broker.getPositions()]);
    const held = positions.find(pos => sameSymbol(pos.symbol, p.symbol));
    const stop = orders.find(o => o.id === snap?.stopOrderId && sameSymbol(o.symbol, p.symbol) && o.side === 'sell' && o.type === 'stop');
    const target = orders.find(o => o.id === snap?.takeProfitOrderId && sameSymbol(o.symbol, p.symbol) && o.side === 'sell' && o.type === 'limit');
    if (held && held.qty > 0 && stop && stop.qty-stop.filled >= held.qty && stop.stopPrice === p.params.stopLoss &&
        (snap?.takeProfitLevel == null || (target && target.qty-target.filled >= held.qty && target.limitPrice === snap.takeProfitLevel))) {
      recordDecisionOutcome('order-' + p.id, { executed: true, orderStatus: 'executed', protectionStatus: 'confirmed', venueStopId: stop.id, venueStopMissing: null });
      transitionOrder(p.id, 'executed', { result: {} }); return;
    }
    if (p.status === 'executing') transitionOrder(p.id, 'unknown', { result: { error: 'Adjustment interrupted; review broker protection before retrying' } });
    return;
  }
  let order = p.result?.brokerOrderId ? await broker.getOrder(p.result.brokerOrderId)
    : p.clientOrderId ? await broker.findOrder(p.clientOrderId) : null;
  const expectedQty = p.result?.qty;
  if (!order && p.result?.brokerOrderId && expectedQty) {
    const fills = readFills().filter(f => f.brokerOrderId === p.result?.brokerOrderId && sameSymbol(f.symbol, p.symbol)
      && f.side === (p.kind === 'entry' ? 'buy' : 'sell') && Date.parse(f.at) >= p.createdAt);
    const qty = fills.reduce((sum, f) => sum + f.qty, 0);
    if (qty >= expectedQty) order = { id: p.result.brokerOrderId, symbol: p.symbol,
      side: p.kind === 'entry' ? 'buy' : 'sell', qty: expectedQty, filledQty: qty,
      filledPrice: fills.reduce((sum, f) => sum + f.price * f.qty, 0) / qty, status: 'filled' };
  }
  if (!order) {
    if (p.status !== 'unknown') transitionOrder(p.id, 'unknown', { result: { ...p.result, error: 'Broker outcome is unknown; this action will not be resubmitted' } });
    return;
  }
  if ((p.result?.qty != null && order.qty !== p.result.qty) || !sameSymbol(order.symbol, p.symbol) || order.side !== (p.kind === 'entry' ? 'buy' : 'sell')) {
    throw new Error('Broker order identity does not match the saved action');
  }
  if (!Number.isFinite(order.qty) || order.qty <= 0 || !Number.isFinite(order.filledQty) || order.filledQty < 0 || order.filledQty > order.qty ||
      (order.filledQty > 0 && (order.filledPrice == null || !Number.isFinite(order.filledPrice) || order.filledPrice <= 0))) {
    throw new Error('Broker execution quantities or fill price are incomplete; inspect the broker outcome');
  }
  // An extended-hours limit cannot be IOC, so it rests; past its time limit it is cancelled
  // here and the read below records the outcome — filled, partly filled, or nothing.
  if (p.result?.extendedHours && ['open', 'partial'].includes(order.status) && Date.now() - (p.result.submittedAt ?? 0) >= EXTENDED_ORDER_TTL_MS) {
    try {
      await broker.cancelOrder(order.id);
      logger.trade(`[Execution] ${p.kind} ${p.symbol}: extended-hours limit did not fill within ${EXTENDED_ORDER_TTL_MS / 60_000} min — cancelled`);
    } catch (err: any) {
      // A fill racing the cancel is an outcome, not a failure: re-read it.
      logger.warn(`[Execution] ${p.id}: cancelling the resting extended-hours order failed — ${err?.message ?? err}`);
    }
    const reread = await broker.getOrder(order.id);
    if (reread) order = reread;
  }
  const extended = p.result?.extendedHours ? { extendedHours: true, submittedAt: p.result.submittedAt } : {};
  const result = { brokerOrderId: order.id, qty: order.qty, filledQty: order.filledQty,
    ...(order.filledPrice != null ? { filledPrice: order.filledPrice } : {}), ...extended };
  const terminal = ['filled', 'cancelled', 'rejected'].includes(order.status);
  const status = order.status === 'filled' || (terminal && order.filledQty > 0) ? 'executed' : terminal ? 'failed' : order.filledQty > 0 ? 'partial' : 'submitted';
  const positions = p.kind === 'exit' && terminal ? await broker.getPositions() : null;
  transaction(() => {
    const signal = p.params.signal as SignalResult | undefined;
    recordDecision(decision(p.kind as 'entry' | 'exit', 'trader', {
      symbol: p.symbol, rationale: p.reason, triggerEventId: p.eventId, orderId: p.id,
      policyHash: p.policyHash, executed: order!.filledQty > 0, orderStatus: order!.status,
      qty: order!.qty, price: signal?.price ?? null, intendedPrice: signal?.price ?? null, brokerOrderId: order!.id,
      intendedStop: signal?.stopLoss ?? null, intendedTarget: signal?.takeProfit ?? null, atrAtEntry: signal?.atr ?? null,
    }), 'order-' + p.id);
    recordDecisionOutcome('order-' + p.id, {
      orderStatus: order!.status, executed: order!.filledQty > 0, requestedQty: order!.qty, filledQty: order!.filledQty, fillPrice: order!.filledPrice ?? null,
      qty: order!.filledQty, price: order!.filledQty > 0 ? order!.filledPrice : null,
    });
    if (p.kind === 'entry' && order!.filledQty > 0 && order!.filledPrice != null) {
      const signal = p.params.signal as SignalResult;
      const stored = getPositionSnapshot(p.symbol);
      const old = stored?.entryDecisionId === 'order-' + p.id ? stored : undefined;
      openPositionSnapshot({ ...old, symbol: p.symbol, entryPrice: order!.filledPrice,
        sessionHigh: Math.max(old?.sessionHigh ?? order!.filledPrice, order!.filledPrice),
        sessionLow: Math.min(old?.sessionLow ?? order!.filledPrice, order!.filledPrice),
        stopLevel: old?.stopLevel ?? signal.stopLoss, takeProfitLevel: old?.takeProfitLevel ?? signal.takeProfit,
        openedAt: old?.openedAt ?? new Date().toISOString(), entryDecisionId: 'order-' + p.id });
    }
    if (positions && !positions.some(pos => sameSymbol(pos.symbol, p.symbol) && pos.qty !== 0)) removePositionSnapshot(p.symbol);
    const current = getOrder(p.id)!;
    if (current.status !== status || current.result?.filledQty !== result.filledQty) {
      if (current.status === 'executing' && status === 'partial') transitionOrder(p.id, 'partial', { result });
      else if (current.status !== status || status === 'partial') transitionOrder(p.id, status, { result: {
        ...result, ...(terminal && status === 'failed' ? { error: 'Broker order ' + order!.status } : {}),
      } });
    }
  });
}

async function execute(p: Order): Promise<void> {
  if (p.policyHash !== getPolicyHash()) {
    transitionOrder(p.id, 'failed', { result: { error: 'Strategy changed; request a fresh action' } });
    return;
  }
  if (Date.now() >= p.expiresAt) { transitionOrder(p.id, 'expired', { decidedBy: 'timeout' }); return; }
  if (getState().paused) return;
  // Only one account-changing order may be outstanding. This reserves exposure without
  // another independent accounting model for pending capital.
  if (pendingOrders().some(other => other.id !== p.id && ['executing','submitted','partial','unknown'].includes(other.status))) return;
  try {
    const entry = p.kind === 'entry' ? await validateEntry((p.params as any).signal, Number(p.params.qty), Number(p.params.maxQty ?? p.params.qty)) : null;
    const exit = p.kind === 'exit' ? await validateExit(p.symbol, Number(p.params.qty)) : null;
    const annotation = !entry && !exit ? await validateAnnotation(p.params as unknown as AnnotateInput) : null;
    if (annotation && !annotation.ok) throw new Error(JSON.parse(annotation.response).error);
    // Re-check after network waits: a user may have paused or changed policy meanwhile.
    if (getState().paused) return;
    if (p.policyHash !== getPolicyHash() || Date.now() >= p.expiresAt) {
      transitionOrder(p.id, 'expired', { result: { error: 'Order changed or expired during validation' } }); return;
    }
    assertExecutionOwner();
    transitionOrder(p.id, 'executing', { result: { qty: entry?.regimeQty ?? exit?.sellQty } });
    if (entry || exit) {
      const result = entry ? await actEntry(entry, p.clientOrderId) : await actExit(p.symbol, p.reason, exit!, p.clientOrderId);
      transaction(() => {
        recordDecision(decision(p.kind as 'entry' | 'exit', 'trader', {
          symbol: p.symbol, rationale: p.reason, triggerEventId: p.eventId, orderId: p.id,
          policyHash: p.policyHash, executed: false, orderStatus: 'submitted', requestedQty: result.qty, filledQty: 0,
          qty: result.qty, price: entry?.price ?? exit?.price ?? null, intendedPrice: entry?.price ?? exit?.price ?? null, brokerOrderId: result.brokerOrderId,
          intendedStop: entry?.stopLoss ?? null, intendedTarget: entry?.takeProfit ?? null, atrAtEntry: entry?.atr ?? null,
        }), 'order-' + p.id);
        recordDecisionOutcome('order-' + p.id, { orderStatus: 'submitted', brokerOrderId: result.brokerOrderId, requestedQty: result.qty, filledQty: 0, qty: 0, price: null });
        transitionOrder(p.id, 'submitted', { result: { brokerOrderId: result.brokerOrderId, qty: result.qty,
          ...(result.extendedHours ? { extendedHours: true, submittedAt: Date.now() } : {}) } });
      });
      await reconcile(getOrder(p.id)!);
    } else if (annotation?.ok) {
      const result = JSON.parse(await actAnnotation(annotation, p));
      const unconfirmed = result.error || result.venueOco?.stopOrderId === null || result.venueStop?.brokerOrderId === null;
      transitionOrder(p.id, unconfirmed ? 'unknown' : 'executed', { result: unconfirmed ? { error: result.error ?? 'Protection update is not confirmed at the broker' } : {} });
    }
  } catch (err: any) {
    const current = getOrder(p.id)!;
    const message = err?.message ?? String(err);
    if (current.status === 'approved') transitionOrder(p.id, 'failed', { result: { error: message } });
    else if (current.status === 'executing') transitionOrder(p.id, (err instanceof GuardRejection && ['paused_before_submission','position_changed','external_order','quote_unavailable'].includes(err.rule)) || err instanceof BrokerRejection && err.status != null && err.status >= 400 && err.status < 500 && ![408,409,429].includes(err.status) ? 'failed' : 'unknown', { result: { ...current.result, error: message } });
    recordDecisionOutcome('order-' + p.id, { orderStatus: getOrder(p.id)?.status, vetoRule: err instanceof GuardRejection ? err.rule : null, venueMessage: err instanceof BrokerRejection ? err.venueMessage : null });
    logger.warn('[Execution] ' + p.id + ': ' + message);
  }
}

async function runSweep(): Promise<void> {
  for (const p of pendingOrders()) {
    if (p.status === 'pending' && Date.now() >= p.expiresAt) transitionOrder(p.id, 'expired', { decidedBy: 'timeout' });
    if (['executing','submitted','partial','unknown'].includes(p.status)) {
      try { await reconcile(p); } catch (err: any) {
        if (getOrder(p.id)?.status !== 'unknown') transitionOrder(p.id, 'unknown', { result: { ...p.result, error: err.message } });
        logger.warn('[Reconcile] ' + p.id + ': ' + err.message);
      }
    }
  }
  const next = pendingOrders().find(p => p.status === 'approved');
  if (next) await execute(next);
}
export function sweepOrders(): Promise<void> {
  if (!sweep) sweep = runSweep().finally(() => { sweep = null; });
  return sweep;
}
