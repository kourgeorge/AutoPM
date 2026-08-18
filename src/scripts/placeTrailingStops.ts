/**
 * Submit exactly five user-confirmed IBKR trailing SELL stops, then read them back.
 * Purpose-built for account U23364714; no retries and no cancellation/modification behavior.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { IBApiNext } from '@stoqey/ib';
import { firstValueFrom } from 'rxjs';

const host = process.env.IBKR_HOST ?? '127.0.0.1';
const port = Number(process.env.IBKR_PORT ?? '4001');
const clientId = Number(process.env.IBKR_CLIENT_ID ?? '73');
const account = process.env.IBKR_ACCOUNT ?? 'U23364714';
const trailingPercent = 8;
const requested: Record<string, number> = { IBM: 34, VT: 10, SOXX: 18, SPCX: 27, QQQ: 3 };
const timeoutMs = 30_000;

function timed<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs))]);
}

async function main() {
  const api = new IBApiNext({ host, port, reconnectInterval: 5_000 });
  api.connect(clientId);
  try {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const update = await timed(firstValueFrom(api.getPositions()), 'position read');
    const positions = update.all.get(account) ?? [];
    const selected = positions.filter((p: any) => requested[p.contract.symbol ?? ''] !== undefined);
    if (selected.length !== Object.keys(requested).length) throw new Error(`Expected ${Object.keys(requested).length} confirmed positions, found ${selected.length}`);
    for (const p of selected) {
      const symbol = p.contract.symbol ?? '';
      if (p.pos !== requested[symbol]) throw new Error(`${symbol} quantity changed: expected ${requested[symbol]}, broker reports ${p.pos}; no orders submitted`);
      if (p.pos <= 0) throw new Error(`${symbol} is not a long position; no orders submitted`);
    }

    const created: Array<{ symbol: string; orderId: number }> = [];
    for (const p of selected) {
      const symbol = p.contract.symbol ?? '';
      // IBKR API: TRAIL uses trailingPercent for a percentage trail. Explicitly GTC.
      const order = { action: 'SELL', totalQuantity: p.pos, orderType: 'TRAIL', trailingPercent, tif: 'GTC', transmit: true };
      const orderId = await timed(api.placeNewOrder(p.contract as any, order as any), `submit ${symbol}`);
      created.push({ symbol, orderId });
    }

    await new Promise(resolve => setTimeout(resolve, 1_500));
    const open = await timed(api.getAllOpenOrders(), 'open-order verification');
    const verified = created.map(createdOrder => {
      const order = open.find((o: any) => Number(o.order?.orderId) === createdOrder.orderId);
      return {
        symbol: createdOrder.symbol, order_id: createdOrder.orderId,
        returned: Boolean(order), status: order?.orderStatus?.status ?? null,
        order_type: order?.order?.orderType ?? null, quantity: order?.order?.totalQuantity ?? null,
        trailing_percent: order?.order?.trailingPercent ?? null, tif: order?.order?.tif ?? null,
      };
    });
    console.log(JSON.stringify({ ok: true, account, host, port, submitted: created, verified }, null, 2));
  } finally {
    api.disconnect();
  }
}
main().catch(error => { console.log(JSON.stringify({ ok: false, error: error?.message ?? String(error) }, null, 2)); process.exitCode = 1; });
