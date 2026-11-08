/**
 * Daily price history for the learning layer.
 *
 * Kept apart from `backtest/barCache.ts` on purpose: that cache stores RAW prices, where a
 * 4-for-1 split looks like a 75% crash, and it never refreshes. Signals are scored live on
 * split-adjusted bars (collect/barSource.ts), so they are measured here on split-adjusted
 * bars too. A split re-adjusts all past prices, so each refresh re-fetches the whole series
 * rather than appending to it.
 *
 * Saved under DATA_DIR/learning/bars/<SYMBOL>.json, refreshed at most once per ET day.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR, ensureDataDir } from '../core/paths';
import { writeFileAtomic } from '../core/fsAtomic';
import { alpacaData } from '../core/alpacaHttp';
import { logger } from '../core/logger';
import { etDate } from '../core/time';
import type { Bar } from '../core/types';

const DIR = path.join(DATA_DIR, 'learning', 'bars');
const YEARS = 10;

/**
 * Large, heavily traded US stocks and ETFs with long histories, added to the watchlist so a
 * signal is judged on a few dozen stocks rather than the handful the trader happens to watch.
 * A signal that only works on 18 hand-picked names is more likely luck.
 */
export const LEARNING_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU',
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'NFLX', 'INTC', 'CSCO', 'QCOM',
  'JPM', 'BAC', 'GS', 'V', 'MA', 'BRK.B', 'UNH', 'JNJ', 'LLY', 'PFE', 'MRK', 'ABBV',
  'XOM', 'CVX', 'KO', 'PEP', 'WMT', 'COST', 'HD', 'MCD', 'NKE', 'DIS', 'CAT', 'BA', 'GE',
];

interface Saved { fetchedOn: string; bars: Bar[] }

const file = (symbol: string) => path.join(DIR, symbol.replace(/[^A-Z0-9.-]/gi, '_') + '.json');

function read(symbol: string): Saved | null {
  try { return JSON.parse(fs.readFileSync(file(symbol), 'utf8')) as Saved; } catch { return null; }
}

async function fetchAll(symbol: string, start: string, end: string): Promise<Bar[]> {
  const out: Bar[] = [];
  let pageToken: string | undefined;
  do {
    let resp: any;
    for (let attempt = 0; ; attempt++) {
      try {
        resp = await alpacaData.get('/v2/stocks/bars', { params: {
          symbols: symbol, timeframe: '1Day', start, end, limit: 10000, adjustment: 'split', sort: 'asc', page_token: pageToken } });
        break;
      } catch (err: any) {
        const status = err?.response?.status;
        if ((status === 429 || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(err?.code)) && attempt < 4) {
          await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue;
        }
        // Plain message only: the raw axios error carries the API key headers.
        const e = new Error(`Price history for ${symbol} failed${status ? ` (${status})` : ''}: ${err?.response?.data?.message ?? err?.message ?? 'unknown error'}`);
        (e as any).status = status;
        throw e;
      }
    }
    for (const b of resp.data?.bars?.[symbol] ?? []) out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    pageToken = resp.data?.next_page_token ?? undefined;
  } while (pageToken);
  return out;
}

/** Re-fetch one symbol unless it was already fetched today (ET). Never throws; keeps the old copy on failure. */
export async function refreshHistory(symbol: string, now = new Date()): Promise<Bar[]> {
  const today = etDate(now);
  const saved = read(symbol);
  if (saved?.fetchedOn === today && saved.bars.length) return saved.bars;
  const start = new Date(now.getTime() - YEARS * 365.25 * 86_400_000).toISOString().slice(0, 10);
  try {
    let bars: Bar[];
    // Free data plans refuse the most recent days; fall back to a series ending 5 days ago.
    try { bars = await fetchAll(symbol, start, new Date(now.getTime() - 16 * 60_000).toISOString()); }
    catch (err: any) {
      if (err.status !== 403) throw err;
      bars = await fetchAll(symbol, start, new Date(now.getTime() - 5 * 86_400_000).toISOString().slice(0, 10));
    }
    // Only completed sessions: today's bar is still forming during the day.
    bars = bars.filter(b => b.t.slice(0, 10) < today || now.getUTCHours() >= 21);
    if (bars.length) { ensureDataDir(DIR); writeFileAtomic(file(symbol), JSON.stringify({ fetchedOn: today, bars })); }
    return bars.length ? bars : saved?.bars ?? [];
  } catch (err: any) {
    logger.warn(`[Learning] ${err.message}`);
    return saved?.bars ?? [];
  }
}

/** Saved history only, no network. */
export function savedHistory(symbol: string): Bar[] { return read(symbol)?.bars ?? []; }

export async function loadUniverse(symbols: string[], refresh = true): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  for (const s of [...new Set(symbols.map(x => x.toUpperCase()))]) {
    if (s.includes('/') ) continue;   // crypto pairs are not part of this study
    const bars = refresh ? await refreshHistory(s) : savedHistory(s);
    if (bars.length > 300) out.set(s, bars);
  }
  return out;
}
