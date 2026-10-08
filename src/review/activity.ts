import { getAllActions } from '../core/actions';
import { readActionHistory } from '../core/actionHistory';
import { readDecisions } from '../journal/journal';
import { readFills } from './fills';
import { readAlertLog } from '../features/alertLog';
import type { TriggerEvent } from '../features/eventBus';
import { readValue } from '../core/storage';

/** A read-only view of decisions, broker fills and events, including their saved queue state. */
export function activityHistory(opts: { type: string; query: string; offset: number; limit: number }) {
  const actions = new Map(getAllActions().map(action => [action.id, action]));
  const brokerFills = readFills();
  const confirmedExits = new Set(brokerFills.filter(fill => fill.side === 'sell').map(fill => `${fill.orderId}:${fill.symbol}`));
  const transitions = new Map<string, ReturnType<typeof readActionHistory>>();
  for (const event of readActionHistory()) {
    const list = transitions.get(event.action.id) ?? [];
    list.push(event);
    transitions.set(event.action.id, list);
  }
  const decisions = readDecisions().map(record => ({
    id: `decision:${record.id}`, type: 'decision', at: record.at,
    symbol: record.symbol, kind: record.kind,
    status: record.orderStatus ?? (record.executed
      ? record.actor === 'broker' && record.kind === 'exit' && confirmedExits.has(`${record.orderId}:${record.symbol}`) ? 'reconciled fill' : 'recorded outcome'
      : record.kind === 'hold' ? 'no action' : 'recorded'),
    reason: record.rationale, record,
    action: record.actionId ? actions.get(record.actionId) ?? null : null,
    transitions: record.actionId ? transitions.get(record.actionId) ?? [] : [],
  }));
  const fills = brokerFills.map(record => ({
    id: `fill:${record.execId}`, type: 'fill', at: record.at,
    symbol: record.symbol, kind: record.side, status: 'filled', reason: 'Confirmed broker execution', record,
  }));
  // Escalations reuse the event ID. Show the latest report once, including events no longer queued.
  const latestEvents = new Map<string, TriggerEvent>();
  for (const event of readAlertLog()) {
    const previous = latestEvents.get(event.id);
    if (!previous || event.wakeCount >= previous.wakeCount) latestEvents.set(event.id, event);
  }
  // Do not call getPendingEvents here: it can reconcile actions and mutate event handling.
  const pending = readValue<{ pending: TriggerEvent[] }>('eventRegistry')?.pending ?? [];
  for (const event of pending) latestEvents.set(event.id, event);
  const queued = new Set(pending.map(event => event.id));
  const events = [...latestEvents.values()].map(record => ({
    id: `event:${record.id}`, type: 'event', at: record.firedAt,
    symbol: record.symbol, kind: record.kind,
    status: record.handling?.replaceAll('_', ' ') ?? (record.ackDisposition === 'ignoring' ? 'declined'
      : record.ackDisposition === 'acting' ? 'action pending'
      : record.ackDisposition === 'acknowledged' ? 'observed' : record.ackedAt ? 'handled' : 'unreviewed'),
    queued: queued.has(record.id), reason: record.headline, record,
  }));
  const query = opts.query.trim().toLowerCase();
  const entries = [...decisions, ...fills, ...events]
    .filter(entry => (opts.type === 'all' || entry.type === opts.type) && (!query || JSON.stringify(entry).toLowerCase().includes(query)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  return {
    entries: entries.slice(opts.offset, opts.offset + opts.limit), total: entries.length,
    decisions: decisions.length, fills: fills.length, events: events.length,
    offset: opts.offset, limit: opts.limit,
  };
}
