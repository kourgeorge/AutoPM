import { IBApiNext } from '@stoqey/ib';
import { firstValueFrom } from 'rxjs';
import { config } from '../core/config';
import { etNow } from '../core/time';
import type { IBroker, Position, AccountInfo, OrderRequest, OpenOrder, Fill } from './IBroker';
import { BrokerRejection } from './errors';
import { logger } from '../core/logger';
import { isCryptoSymbol } from '../core/symbols';

const API_TIMEOUT_MS = parseInt(process.env.IBKR_API_TIMEOUT_MS ?? '10000');

/**
 * TWS order types this system can name. Everything else reports as `'other'` with `rawType`
 * carrying TWS's own string: the mapping this replaces was `orderType === 'MKT' ? 'market' :
 * 'limit'`, under which a live TRAIL order read as a limit order with no limit price.
 */
const IB_ORDER_TYPES: Record<string, OpenOrder['type']> = {
  'MKT':      'market',
  'LMT':      'limit',
  'STP':      'stop',
  'STP LMT':  'stop_limit',
  'TRAIL':    'trailing_stop',
  'TRAIL LIMIT': 'trailing_stop',
};

/**
 * The same mapping outbound. Separate from `IB_ORDER_TYPES` because it is not its inverse:
 * two TWS strings read back as `trailing_stop`, and this system places only three of them.
 */
const IB_TYPE_OUT: Record<OrderRequest['type'], string> = {
  market: 'MKT',
  limit:  'LMT',
  stop:   'STP',
};

/**
 * What UTC instant a wall-clock reading in `timeZone` corresponds to.
 *
 * Two passes: the first offset is measured at the wrong instant (we guessed UTC), which is
 * only wrong across a DST boundary — the second pass, measured at the corrected instant,
 * lands on the right side of it.
 */
function zonedToUtc(parts: number[], timeZone: string): number {
  const [y, mo, d, h, mi, s] = parts;
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);

  let guess = naive;
  for (let pass = 0; pass < 2; pass++) {
    const seen = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess));

    const f = (type: string) => parseInt(seen.find(p => p.type === type)!.value, 10);
    // `hour12: false` renders midnight as hour 24 in some ICU versions.
    const asUtc = Date.UTC(f('year'), f('month') - 1, f('day'), f('hour') % 24, f('minute'), f('second'));
    guess = naive - (asUtc - guess);
  }
  return guess;
}

/**
 * TWS execution timestamps, in the three shapes the API has used.
 *
 * The stakes are silent rather than loud: an unparsed or mis-zoned timestamp does not
 * throw, it produces a holding period wrong by hours, which then reads as a strategy
 * finding. So an unrecognised shape is logged and reported as unknown rather than guessed.
 *
 * - `1755106176`                        — epoch seconds (TWS 10.2+ for some fields)
 * - `20260813  15:29:36 US/Eastern`     — wall clock plus IANA zone (v10.10+)
 * - `20260813  15:29:36`                — wall clock in the account's DISPLAY timezone,
 *                                         which this process has no way to know; the local
 *                                         zone is the only available reading of it.
 */
function parseIbTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();

  if (/^\d{9,11}$/.test(t)) return new Date(parseInt(t, 10) * 1000).toISOString();

  const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+(\S+))?$/.exec(t);
  if (!m) {
    logger.warn(`[IBKR] Unrecognised execution timestamp "${raw}" — fill time recorded as unknown`);
    return null;
  }

  const parts = m.slice(1, 7).map(Number);
  const zone = m[7];

  if (zone) {
    try {
      return new Date(zonedToUtc(parts, zone)).toISOString();
    } catch {
      logger.warn(`[IBKR] Unknown timezone "${zone}" in execution timestamp "${raw}" — falling back to local time`);
    }
  }

  const [y, mo, d, h, mi, s] = parts;
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`IBKR ${label} timed out after ${API_TIMEOUT_MS}ms`)), API_TIMEOUT_MS),
    ),
  ]);
}

/**
 * IBKR's fill side vocabulary. `BOT`/`SLD` are what TWS reports; `BUY`/`SELL` appear from
 * some gateway versions. Absent from the table means unrecognised, which means dropped.
 */
const IB_SIDE: Record<string, 'buy' | 'sell'> = {
  BOT: 'buy', BUY: 'buy', SLD: 'sell', SELL: 'sell',
};

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
      // Not reported. `PreviousDayEquityWithLoanValue` is a different quantity, and `usd()`
      // returns 0 for a missing tag — a zero here would be read as a real previous close and
      // silently become the baseline the daily loss limit measures against.
      previousCloseEquity: null,
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
    return orders.map(o => {
      const rawType = String(o.order.orderType ?? '');
      const type = IB_ORDER_TYPES[rawType] ?? 'other';
      // TWS overloads one field: `auxPrice` is the trigger on a stop and the trail distance
      // on a TRAIL. Reading it as one or the other is what makes a trailing stop legible.
      const aux = typeof o.order.auxPrice === 'number' ? o.order.auxPrice : undefined;
      return {
        id:           String(o.orderId),
        symbol:       o.contract.symbol ?? '',
        side:         (o.order.action === 'BUY' ? 'buy' : 'sell') as 'buy' | 'sell',
        qty:          Number(o.order.totalQuantity ?? 0),
        filled:       o.orderStatus?.filled ?? 0,
        type,
        rawType,
        limitPrice:   o.order.lmtPrice ?? undefined,
        stopPrice:    type === 'stop' || type === 'stop_limit' ? aux : undefined,
        trailPercent: o.order.trailingPercent ?? undefined,
        trailAmount:  type === 'trailing_stop' ? aux : undefined,
        tif:          o.order.tif ? String(o.order.tif) : undefined,
        status:       String(o.orderStatus?.status ?? 'Unknown'),
      };
    });
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
      orderType:     IB_TYPE_OUT[req.type],
      lmtPrice:      req.limitPrice,
      // TWS overloads `auxPrice`: it is the trigger on STP and the trail distance on TRAIL.
      // Only meaningful for a stop, so only sent for one.
      auxPrice:      req.type === 'stop' ? req.stopPrice : undefined,
      // A STOP IS ALWAYS GTC — DAY would cancel the protection at every close, which is the
      // window it exists to cover. Crypto is GTC because that is all the venue accepts for it.
      tif:           req.type === 'stop' || isCryptoSymbol(req.symbol) ? 'GTC' : 'DAY',
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

  /**
   * TWS amends in place, so the id is unchanged — unlike Alpaca, which mints a new one. The
   * return value exists for that difference (see `IBroker.replaceStopOrder`), not for this side.
   *
   * `modifyOrder` takes a WHOLE order, not a patch: anything omitted is not "left alone", it is
   * changed to the default. So the resting order is read back from the venue and re-sent with one
   * field moved. Reconstructing it from our own records instead would quietly rewrite the qty or
   * the TIF of an order we may not have placed.
   *
   * CAVEAT, and it is the same one `orderManager.ts` documents for `cancelOrder`: this is void
   * and fire-and-forget. TWS confirms asynchronously, so a resolved promise here means the
   * request was handed over, NOT that the stop moved. Alpaca's is a round trip that either
   * returns the new order or throws.
   */
  async replaceStopOrder(id: string, stopPrice: number): Promise<{ id: string }> {
    const orderId = parseInt(id, 10);
    const open = await withTimeout(this.api.getAllOpenOrders(), 'getAllOpenOrders');
    const existing = open.find(o => o.orderId === orderId);

    if (!existing) {
      // Not found means filled, cancelled, or placed by another client id. All three mean the
      // stop is not where the caller believes it is, and only the caller can decide about that.
      throw new BrokerRejection(
        null,
        `order ${id} is not resting at the venue — it filled, was cancelled, or belongs to another client id`,
        null,
        { replaceStopOrderId: id, stopPrice },
      );
    }

    try {
      this.api.modifyOrder(orderId, existing.contract, {
        ...existing.order,
        auxPrice: stopPrice,
      } as any);
    } catch (err: any) {
      const inner: Error = err?.error ?? err;
      throw new BrokerRejection(null, inner.message, null, { replaceStopOrderId: id, stopPrice });
    }

    return { id };
  }

  /**
   * Executions TWS still holds, which is the CURRENT TRADING DAY ONLY.
   *
   * That is the reason `data/fills.jsonl` exists. This method is a tap on a window that
   * closes every evening, not a history endpoint, and `since` is therefore ignored: the
   * filter takes `yyyymmdd hh:mm:ss` in the account's display timezone, so passing a
   * boundary we cannot express correctly could silently drop fills inside the window —
   * whereas over-fetching the whole day costs one call and is deduped by the ledger.
   *
   * Commissions arrive on a separate stream keyed by `execId` and are the only place the
   * fee is stated; a missing report leaves `fee` null rather than zero.
   */
  async getFills(_since?: Date): Promise<Fill[]> {
    const filter = this.account ? { acctCode: this.account } : {};

    const [details, commissions] = await Promise.all([
      withTimeout(this.api.getExecutionDetails(filter), 'getExecutionDetails'),
      // Fees are a nice-to-have; a fill with an unknown fee is still a fill, and losing
      // the whole reconciliation because the commission stream stalled would be worse.
      withTimeout(this.api.getCommissionReport(filter), 'getCommissionReport')
        .catch((err: any) => {
          logger.warn(`[IBKR] Commission report unavailable — fees recorded as unknown: ${err?.error?.message ?? err.message}`);
          return [];
        }),
    ]);

    const feeByExecId = new Map<string, number>();
    for (const c of commissions) {
      if (c.execId != null && c.commission != null) feeByExecId.set(c.execId, c.commission);
    }

    const ingestedAt = new Date().toISOString();

    return details
      .filter(d => d.execution.execId != null)
      // An unrecognised side is DROPPED, not guessed. The old ternary sent everything that
      // was not BOT/BUY down the `sell` branch, so a blank or renamed side became a sell —
      // and a fabricated sell against a real position fabricates an EXIT, which enters the
      // scorecard as a closed trade with real prices attached to a trade that never closed.
      // A dropped fill is recoverable from the venue on the next reconciliation; an invented
      // one is not recoverable at all.
      //
      // One `flatMap` rather than a filter that enumerates the vocabulary and a map that
      // re-tests half of it: `IB_SIDE` is the only place the venue's spelling is
      // adjudicated, so there is no second list to drift out of step with it, and `side` is
      // typed by the lookup instead of asserted with `as`.
      .flatMap(({ contract, execution: e }) => {
        const side = IB_SIDE[(e.side ?? '').toUpperCase()];
        if (!side) {
          logger.warn(`[IBKR] Fill ${e.execId} has an unrecognised side "${e.side}" — skipped`);
          return [];
        }
        return [{
          execId:  e.execId!,
          // Non-durable across client sessions, which is why `permId` is carried too.
          orderId: e.orderId != null ? String(e.orderId) : '',
          // 0 means the trade originated outside IB and has no TWS id.
          permId:  e.permId ? String(e.permId) : null,
          symbol:  contract.symbol ?? '',
          side,
          qty:     e.shares ?? 0,
          price:   e.price ?? 0,
          fee:     feeByExecId.get(e.execId!) ?? null,
          // Ingest time on a parse failure, not a dropped fill: a fill missing from the
          // ledger corrupts every FIFO match after it, while a wrong timestamp only
          // corrupts the holding period of one — and `parseIbTime` has already warned.
          at:      parseIbTime(e.time) ?? ingestedAt,
        }];
      });
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
