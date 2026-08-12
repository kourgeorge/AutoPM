import { IBApiNext } from '@stoqey/ib';
import { firstValueFrom } from 'rxjs';
import { config } from '../core/config';
import { etNow } from '../core/time';
import type { IBroker, Position, AccountInfo, OrderRequest, OpenOrder } from './IBroker';
import { BrokerRejection } from './errors';

const API_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`IBKR ${label} timed out after ${API_TIMEOUT_MS}ms`)), API_TIMEOUT_MS),
    ),
  ]);
}

export class IBKRBroker implements IBroker {
  private readonly api: IBApiNext;
  private readonly account: string;

  constructor() {
    const { host, port, clientId, account } = config.ibkr;
    this.account = account;
    this.api = new IBApiNext({ host, port, reconnectInterval: 5_000 });
    this.api.connect(clientId);
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const update = await withTimeout(
      firstValueFrom(
        this.api.getAccountSummary('All', 'NetLiquidation,TotalCashValue,BuyingPower'),
      ),
      'getAccountInfo',
    );

    // Pick the configured account or fall back to the first available one.
    const tagValues =
      (this.account && update.all.has(this.account)
        ? update.all.get(this.account)
        : update.all.values().next().value) ?? new Map();

    const usd = (tag: string): number => {
      const v = (tagValues as Map<string, any>).get(tag)?.get('USD')?.value;
      return v != null ? parseFloat(v) : 0;
    };

    return {
      equity:      usd('NetLiquidation'),
      cash:        usd('TotalCashValue'),
      buyingPower: usd('BuyingPower'),
    };
  }

  async getPositions(): Promise<Position[]> {
    const update = await withTimeout(
      firstValueFrom(this.api.getPositions()),
      'getPositions',
    );

    const result: Position[] = [];
    for (const acctPositions of update.all.values()) {
      for (const p of acctPositions) {
        if (!p.pos) continue;
        result.push({
          symbol:        p.contract.symbol ?? '',
          qty:           p.pos,
          avgCost:       p.avgCost ?? 0,
          marketValue:   p.marketValue ?? undefined,
          unrealizedPnL: p.unrealizedPNL ?? undefined,
        });
      }
    }
    return result;
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    const orders = await withTimeout(this.api.getAllOpenOrders(), 'getOpenOrders');
    return orders.map(o => ({
      id:         String(o.orderId),
      symbol:     o.contract.symbol ?? '',
      side:       o.order.action === 'BUY' ? 'buy' : 'sell',
      qty:        o.order.totalQuantity ?? 0,
      filled:     o.orderStatus?.filled ?? 0,
      type:       o.order.orderType === 'MKT' ? 'market' : 'limit',
      limitPrice: o.order.lmtPrice ?? undefined,
      status:     String(o.orderStatus?.status ?? 'Unknown'),
    }));
  }

  async placeOrder(req: OrderRequest): Promise<{ id: string }> {
    const contract = {
      symbol:   req.symbol,
      secType:  'STK',
      exchange: 'SMART',
      currency: 'USD',
    };
    const order = {
      action:        req.side === 'buy' ? 'BUY' : 'SELL',
      totalQuantity: req.qty,
      orderType:     req.type === 'market' ? 'MKT' : 'LMT',
      lmtPrice:      req.limitPrice,
      // Crypto symbols contain '/' (e.g. BTC/USD); everything else is DAY.
      tif:           req.symbol.includes('/') ? 'GTC' : 'DAY',
    };

    let orderId: number;
    try {
      orderId = await withTimeout(
        this.api.placeNewOrder(contract as any, order as any),
        'placeOrder',
      );
    } catch (err: any) {
      // IBApiNext wraps errors as { error: Error, reqId: number }
      const inner: Error = err?.error ?? err;
      throw new BrokerRejection(null, inner.message, null, req);
    }

    return { id: String(orderId) };
  }

  async cancelOrder(id: string): Promise<void> {
    this.api.cancelOrder(parseInt(id, 10));
  }

  /** US market hours only; does not account for early closes. */
  async isMarketOpen(): Promise<boolean> {
    const { day, hours, minutes } = etNow();
    if (day === 0 || day === 6) return false;
    const etMin = hours * 60 + minutes;
    return etMin >= 9 * 60 + 30 && etMin < 16 * 60;
  }

  disconnect(): void {
    this.api.disconnect();
  }
}
