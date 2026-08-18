/** Read-only IBKR open-order probe; never submits, modifies, or cancels orders. */
import * as dotenv from 'dotenv';
dotenv.config();
import { IBApiNext } from '@stoqey/ib';

const host = process.env.IBKR_HOST ?? '127.0.0.1';
const port = Number(process.env.IBKR_PORT ?? '4001');
const clientId = Number(process.env.IBKR_CLIENT_ID ?? '75');
const api = new IBApiNext({ host, port });

function timed<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('open-order read timed out')), 30_000))]);
}

async function main() {
  api.connect(clientId);
  try {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const orders = await timed(api.getAllOpenOrders());
    console.log(JSON.stringify({ ok: true, orders: orders.map((o: any) => ({
      id: o.order?.orderId, symbol: o.contract?.symbol, side: o.order?.action,
      qty: o.order?.totalQuantity, type: o.order?.orderType, trailing_percent: o.order?.trailingPercent,
      tif: o.order?.tif, status: o.orderStatus?.status,
    })) }, null, 2));
  } finally { api.disconnect(); }
}
main().catch(error => { console.log(JSON.stringify({ ok: false, error: error?.message ?? String(error) })); process.exitCode = 1; });
