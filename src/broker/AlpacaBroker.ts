import axios, { AxiosInstance } from 'axios';
import { config } from '../core/config';
import type { IBroker, Position, AccountInfo, OrderRequest, OpenOrder } from './IBroker';
import { BrokerRejection } from './errors';

function makeClient(baseURL: string): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      'APCA-API-KEY-ID': config.alpaca.keyId,
      'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    },
  });
}

const trading = makeClient(config.alpaca.baseUrl);
const data    = makeClient(config.alpaca.dataUrl);

export class AlpacaBroker implements IBroker {
  async getPositions(): Promise<Position[]> {
    const res = await trading.get('/v2/positions');
    return (res.data as any[]).map((p) => ({
      symbol:        p.symbol,
      qty:           parseFloat(p.qty),
      avgCost:       parseFloat(p.avg_entry_price),
      marketValue:   parseFloat(p.market_value),
      unrealizedPnL: parseFloat(p.unrealized_pl),
    }));
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const d = (await trading.get('/v2/account')).data;
    return {
      equity:       parseFloat(d.equity),
      cash:         parseFloat(d.cash),
      buyingPower:  parseFloat(d.buying_power),
    };
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    const res = await trading.get('/v2/orders', { params: { status: 'open' } });
    return (res.data as any[]).map((o) => ({
      id:         o.id,
      symbol:     o.symbol,
      side:       o.side as 'buy' | 'sell',
      qty:        parseFloat(o.qty),
      filled:     parseFloat(o.filled_qty ?? '0'),
      type:       o.type as 'market' | 'limit',
      limitPrice: o.limit_price ? parseFloat(o.limit_price) : undefined,
      status:     o.status,
    }));
  }

  /**
   * The one method that can be refused by something outside this process, so the only
   * one that translates its failure. `err.response.data` is where Alpaca puts the reason
   * — reading it is the difference between "403" and "403 account is not authorized to
   * trade this asset", and the model will invent the difference if we do not supply it.
   */
  async placeOrder(req: OrderRequest): Promise<{ id: string }> {
    try {
      const res = await trading.post('/v2/orders', {
        symbol:         req.symbol,
        qty:            req.qty,
        side:           req.side,
        type:           req.type,
        time_in_force:  'day',
        limit_price:    req.limitPrice,
      });
      return { id: res.data.id };
    } catch (err: any) {
      throw new BrokerRejection(
        err.response?.status ?? null,
        err.response?.data?.message ?? err.message,
        err.response?.data?.code ?? null,
        req,
      );
    }
  }

  async cancelOrder(id: string): Promise<void> {
    await trading.delete(`/v2/orders/${id}`);
  }

  async isMarketOpen(): Promise<boolean> {
    const res = await trading.get('/v2/clock');
    return res.data.is_open as boolean;
  }
}

