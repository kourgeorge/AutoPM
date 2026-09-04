import type { IBroker, Position, AccountInfo, OrderRequest, OpenOrder, Fill, OcoRequest } from './IBroker';
import { BrokerRejection } from './errors';
import { alpacaTimeToMs, alpacaTrading as trading } from '../core/alpacaHttp';
import { logger } from '../core/logger';
import { isCryptoSymbol } from '../core/symbols';

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

/**
 * Alpaca's fill side vocabulary. `sell_short` is a genuine Alpaca value and is a sell.
 * Absent from the table means unrecognised, which means dropped — see `getFills`.
 */
const ALPACA_SIDE = { buy: 'buy', sell: 'sell', sell_short: 'sell' } as const;

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
   * `nested` IS requested, and then flattened back out. This is the flip side of the asymmetry
   * documented on `placeOco`: for an `order_class: 'oco'` pair, the flat (non-nested) open-orders
   * list returns only the parent row — which is itself the take-profit leg — and never surfaces
   * the stop child as a row of its own. Without `nested`, the stop leg is invisible to this list
   * even though it is very much still resting at the venue, so `restingStop` reads a live pair as
   * absent and the sweep tears down and rebuilds a perfectly good stop every tick. Requesting
   * `nested` and re-emitting each leg as its own row restores the one-row-per-order-in-the-book
   * shape the rest of this file assumes.
   */
  async getOpenOrders(): Promise<OpenOrder[]> {
    const res = await trading.get('/v2/orders', { params: { status: 'open', nested: true } });
    const rows = (res.data as any[]).flatMap((o) => [o, ...((o.legs ?? []) as any[])]);
    return rows.map((o) => ({
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
        time_in_force:  this.tifFor(req),
        limit_price:    req.limitPrice,
        stop_price:     req.type === 'stop' ? req.stopPrice : undefined,
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

  /**
   * A STOP IS ALWAYS GTC. A `day` stop is cancelled at the close, and overnight-and-weekend is
   * the window a resting stop exists to cover — a stop that expires every afternoon protects the
   * position only while the process that could have watched it anyway was running.
   *
   * Crypto is `gtc` because Alpaca accepts nothing else for it (`day` is rejected outright);
   * everything else stays `day`, which is what a market entry wants.
   */
  private tifFor(req: OrderRequest): 'gtc' | 'day' {
    return req.type === 'stop' || isCryptoSymbol(req.symbol) ? 'gtc' : 'day';
  }

  /**
   * Place a linked stop + take-profit pair for the same shares.
   *
   * `order_class: 'oco'` on a plain `sell` order: the base leg carries no price of its own,
   * `take_profit`/`stop_loss` supply both. Always `gtc` for the same reason a lone stop is —
   * this is the overnight/weekend protection, and a `day` leg would evaporate at the close.
   *
   * The response is asymmetric, confirmed against a live order: the *parent* order returned by
   * this call IS the take-profit (limit) leg — it carries `limit_price` and its own `id` is the
   * take-profit order id — and `legs[]` holds only its stop sibling, one element, not both
   * children as two array entries. Building the candidate list from parent-plus-legs (rather
   * than assuming both live inside `legs[]`) is what makes this work regardless of which of the
   * two Alpaca happens to nest.
   */
  async placeOco(req: OcoRequest): Promise<{ stopOrderId: string; takeProfitOrderId: string }> {
    try {
      const res = await trading.post('/v2/orders', {
        symbol:        req.symbol,
        qty:           req.qty,
        side:          'sell',
        type:          'limit',
        time_in_force: 'gtc',
        order_class:   'oco',
        take_profit:   { limit_price: req.takeProfitPrice },
        stop_loss:     { stop_price: req.stopPrice },
      });
      const candidates = [res.data, ...((res.data.legs ?? []) as any[])];
      const stopLeg = candidates.find(l => num(l.stop_price) != null);
      const takeProfitLeg = candidates.find(l => l.id !== stopLeg?.id && num(l.limit_price) != null);
      if (!stopLeg || !takeProfitLeg) {
        throw new BrokerRejection(
          null, `OCO order ${res.data.id} did not return two distinguishable legs`, null, req,
        );
      }
      return { stopOrderId: stopLeg.id, takeProfitOrderId: takeProfitLeg.id };
    } catch (err: any) {
      if (err instanceof BrokerRejection) throw err;
      throw new BrokerRejection(
        err.response?.status ?? null,
        err.response?.data?.message ?? err.message,
        err.response?.data?.code ?? null,
        req,
      );
    }
  }

  /**
   * Same shape as `replaceStopOrder` — Alpaca mints a new id on every PATCH, this one for the
   * take-profit leg's limit price instead of the stop leg's trigger price.
   */
  async replaceTakeProfitOrder(id: string, limitPrice: number): Promise<{ id: string }> {
    try {
      const res = await trading.patch(`/v2/orders/${id}`, { limit_price: limitPrice });
      return { id: res.data.id };
    } catch (err: any) {
      throw new BrokerRejection(
        err.response?.status ?? null,
        err.response?.data?.message ?? err.message,
        err.response?.data?.code ?? null,
        { replaceTakeProfitOrderId: id, limitPrice },
      );
    }
  }

  async cancelOrder(id: string): Promise<void> {
    await trading.delete(`/v2/orders/${id}`);
  }

  /**
   * Alpaca replaces rather than amends: this returns a NEW order id and the one passed in is
   * dead afterwards. Hence the return value — see `IBroker.replaceStopOrder`.
   *
   * Two documented refusals reach the caller as a `BrokerRejection` rather than being swallowed,
   * because both mean the stop is not where the caller thinks it is and only the caller can
   * decide what to do about that:
   *  - the original already filled, so there is nothing left to move (and no position either);
   *  - the order is `accepted` / `pending_new` / `pending_cancel` / `pending_replace`, i.e. the
   *    venue is mid-transition and will not take a second instruction yet. A retry next sweep is
   *    the right response, and swallowing this would report a tighten that never happened.
   */
  async replaceStopOrder(id: string, stopPrice: number): Promise<{ id: string }> {
    try {
      const res = await trading.patch(`/v2/orders/${id}`, { stop_price: stopPrice });
      return { id: res.data.id };
    } catch (err: any) {
      throw new BrokerRejection(
        err.response?.status ?? null,
        err.response?.data?.message ?? err.message,
        err.response?.data?.code ?? null,
        { replaceStopOrderId: id, stopPrice },
      );
    }
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
    const ingestedAt = new Date().toISOString();

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
        // An unrecognised side is DROPPED, not guessed. `a.side === 'buy' ? 'buy' : 'sell'`
        // sent a blank, absent or renamed side down the sell branch, and a fabricated sell
        // against a real position fabricates an exit — a closed trade in the scorecard that
        // never closed. The vocabulary is a table (`ALPACA_SIDE`) so that "which strings are
        // sells" is stated once rather than spread across a ternary chain.
        const side = ALPACA_SIDE[a.side as keyof typeof ALPACA_SIDE];
        if (!side) {
          logger.warn(`[Alpaca] Fill ${a.id} has an unrecognised side "${a.side}" — skipped`);
          continue;
        }

        // Guarded, because `new Date(bad).toISOString()` THROWS `RangeError`, and this loop
        // sits inside `reconcileFills`'s try/catch — so one malformed row was discarding
        // every fill in the batch under the message "could not fetch fills". Falling back to
        // ingest time costs the holding period of one trade; the throw cost all of them.
        const stamped = alpacaTimeToMs(a.transaction_time);
        let at = ingestedAt;
        if (Number.isFinite(stamped)) {
          at = new Date(stamped).toISOString();
        } else {
          logger.warn(
            `[Alpaca] Fill ${a.id} has an unparseable transaction_time "${a.transaction_time}" — ` +
              `recorded at ingest time instead`,
          );
        }

        fills.push({
          execId:  a.id,
          orderId: a.order_id,
          permId:  null,
          symbol:  a.symbol,
          side,
          qty:     parseFloat(a.qty),
          price:   parseFloat(a.price),
          // Equity commissions are zero but regulatory fees (SEC, TAF) arrive as separate
          // FEE activities, so what this fill cost is not knowable from this row.
          fee:     null,
          at,
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

