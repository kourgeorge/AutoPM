/**
 * Read-only JSON bridge for the Hermes portfolio-health skill.
 * Connects to local TWS / IB Gateway. It does not submit, modify, or cancel orders.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { IBApiNext } from '@stoqey/ib';
import { firstValueFrom } from 'rxjs';

const host = process.env.IBKR_HOST ?? 'localhost';
const port = Number(process.env.IBKR_PORT ?? '7497');
const clientId = Number(process.env.IBKR_CLIENT_ID ?? '71');
const selectedAccount = process.env.IBKR_ACCOUNT ?? '';
const timeoutMs = Number(process.env.IBKR_API_TIMEOUT_MS ?? '30000');

function timed<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))]);
}
function number(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function tagsFor(summary: any, account: string): Map<string, any> {
  return (account && summary.all.has(account) ? summary.all.get(account) : summary.all.values().next().value) ?? new Map();
}
function usd(tags: Map<string, any>, tag: string): number | null {
  const cell = tags.get(tag);
  const value = cell?.get('USD')?.value ?? cell?.values?.().next?.().value?.value;
  return number(value);
}

async function main() {
  const api = new IBApiNext({ host, port, reconnectInterval: 5_000 });
  api.connect(clientId);
  try {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const [summary, positionUpdate, openOrders] = await Promise.all([
      timed(firstValueFrom(api.getAccountSummary('All', 'NetLiquidation,TotalCashValue,BuyingPower,PreviousDayEquityWithLoanValue')), 'account summary'),
      timed(firstValueFrom(api.getPositions()), 'positions'),
      timed(api.getAllOpenOrders(), 'open orders'),
    ]);
    const tags = tagsFor(summary, selectedAccount);
    const account = selectedAccount || String(summary.all.keys().next().value ?? '');
    const holdings = positionUpdate.all.get(account) ?? Array.from(positionUpdate.all.values()).flat();
    const positions = holdings.filter((p: any) => p.pos).map((p: any) => ({
      instrument_id: String(p.contract.conId ?? ''), symbol: p.contract.localSymbol ?? p.contract.symbol ?? '',
      sec_type: p.contract.secType ?? null, currency: p.contract.currency ?? null,
      qty: number(p.pos) ?? 0, avg_cost: number(p.avgCost), market_value: number(p.marketValue),
      unrealized_pnl: number(p.unrealizedPNL), market_price: number(p.marketPrice),
    }));
    const orders = openOrders.map((o: any) => ({
      id: String(o.order?.orderId ?? ''), instrument_id: String(o.contract?.conId ?? ''),
      symbol: o.contract?.localSymbol ?? o.contract?.symbol ?? '', side: o.order?.action ?? '',
      qty: number(o.order?.totalQuantity) ?? 0, filled_qty: number(o.orderStatus?.filled) ?? 0,
      order_type: o.order?.orderType ?? '', aux_price: number(o.order?.auxPrice), limit_price: number(o.order?.lmtPrice),
      trailing_percent: number(o.order?.trailingPercent), tif: o.order?.tif ?? null,
      status: o.orderStatus?.status ?? 'Unknown', parent_id: o.order?.parentId ?? null,
      oca_group: o.order?.ocaGroup ?? null, perm_id: o.order?.permId ?? null,
    }));
    console.log(JSON.stringify({ ok: true, broker: 'ibkr_tws_gateway', connection: { host, port }, account: {
      id: account, equity: usd(tags, 'NetLiquidation'), cash: usd(tags, 'TotalCashValue'),
      buying_power: usd(tags, 'BuyingPower'), previous_close_equity: usd(tags, 'PreviousDayEquityWithLoanValue'),
    }, positions, open_orders: orders }, null, 2));
  } finally {
    api.disconnect();
  }
}
main().catch(error => { console.log(JSON.stringify({ ok: false, broker: 'ibkr_tws_gateway', error: error?.message ?? String(error) })); process.exitCode = 1; });
