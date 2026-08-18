import axios, { AxiosInstance } from 'axios';
import { config } from '../core/config';
import type { IBroker, Position, AccountInfo, OrderRequest, OpenOrder, Fill } from './IBroker';
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

/**
 * Alpaca's `type` strings, which happen to be our names already. The lookup exists so an
 * unrecognised one falls to `'other'` rather than being asserted into a type it is not — the
 * bug this replaces was `o.type as 'market' | 'limit'`, under which a stop order read as a
 * limit order with no price.
 */
const ALPACA_ORDER_TYPES: Record<string, OpenOrder['type']> = {
  market:        'market',
  limit:         'limit',
  stop:          'stop',
  stop_limit:    'stop_limit',
  trailing_stop: 'trailing_stop',
};

/** Alpaca sends prices as strings and absent prices as `null`. Absent must stay absent. */
function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

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
    // `last_equity` is equity at the previous close and has always been in this payload.
    // Parsed defensively: a missing field must arrive as `null` (unknown), never as NaN
    // masquerading as a number the daily loss limit will be measured against.
    const lastEquity = parseFloat(d.last_equity);
    return {
      equity:       parseFloat(d.equity),
      cash:         parseFloat(d.cash),
      buyingPower:  parseFloat(d.buying_power),
      previousCloseEquity: Number.isFinite(lastEquity) && lastEquity > 0 ? lastEquity : null,
    };
  }

  /**
   * `nested` is deliberately not requested: bracket legs already arrive as their own top-level
   * rows, and asking for them nested would hide a resting stop inside a parent order.
   */
  async getOpenOrders(): Promise<OpenOrder[]> {
    const res = await trading.get('/v2/orders', { params: { status: 'open' } });
    return (res.data as any[]).map((o) => ({
      id:           o.id,
      symbol:       o.symbol,
      side:         o.side as 'buy' | 'sell',
      qty:          parseFloat(o.qty),
      filled:       parseFloat(o.filled_qty ?? '0'),
      type:         ALPACA_ORDER_TYPES[o.type] ?? 'other',
      rawType:      String(o.type),
      limitPrice:   num(o.limit_price),
      stopPrice:    num(o.stop_price),
      trailPercent: num(o.trail_percent),
      trailAmount:  num(o.trail_price),
      tif:          o.time_in_force ?? undefined,
      status:       o.status,
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
        time_in_force:  req.symbol.includes('/') ? 'gtc' : 'day',
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

  /**
   * FILL activities, oldest-first, following pagination to the end.
   *
   * `activity_type=FILL` covers both `fill` and `partial_fill` — Alpaca reports the type
   * per activity but emits one row per execution either way, so both are fills and both
   * are kept. Summing `qty` reconstructs the order; `cum_qty` would double-count.
   *
   * The page loop is bounded, not `while (true)`: an `after` filter Alpaca interprets
   * differently than we expect would otherwise spin forever on the same first page.
   */
  async getFills(since?: Date): Promise<Fill[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;

    const fills: Fill[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await trading.get('/v2/account/activities', {
        params: {
          activity_types: 'FILL',
          direction:      'asc',
          page_size:      PAGE_SIZE,
          after:          since?.toISOString(),
          page_token:     pageToken,
        },
      });
      const rows = res.data as any[];
      if (rows.length === 0) break;

      for (const a of rows) {
        fills.push({
          execId:  a.id,
          orderId: a.order_id,
          permId:  null,
          symbol:  a.symbol,
          side:    a.side === 'buy' ? 'buy' : 'sell',
          qty:     parseFloat(a.qty),
          price:   parseFloat(a.price),
          // Equity commissions are zero but regulatory fees (SEC, TAF) arrive as separate
          // FEE activities, so what this fill cost is not knowable from this row.
          fee:     null,
          at:      new Date(a.transaction_time).toISOString(),
        });
      }

      if (rows.length < PAGE_SIZE) break;
      pageToken = rows[rows.length - 1].id;
    }

    return fills;
  }

  async isMarketOpen(): Promise<boolean> {
    const res = await trading.get('/v2/clock');
    return res.data.is_open as boolean;
  }
}

