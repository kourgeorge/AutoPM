/**
 * L1 — the sector cache.
 *
 * `data/sectors.json` as `{ [symbol]: string }`. A sector does not change, so there is no
 * TTL and no invalidation: an operator deleting the file IS the invalidation. That is what
 * separates this from `data/calendar.json` (P5), where dates move and a TTL is mandatory.
 *
 * Two readers, deliberately different:
 *  - `getSectors` may hit Yahoo, so it belongs to on-demand paths (`get_exposure`, the
 *    trader context builder) where one HTTP call per new symbol is affordable.
 *  - `getCachedSectors` is PURE — no network, no promise. The 60s tick reads sectors
 *    through it and must never block on Yahoo; a miss there is `null` until an on-demand
 *    path warms it.
 *
 * A miss is `null`, never a guess from the ticker. ETFs legitimately have no sector.
 */

import fs from 'fs';
import { writeFileAtomic } from '../core/fsAtomic';
import path from 'path';
import { logger } from '../core/logger';
import { getSectorRaw } from './yahoo';

const DATA_DIR = path.join(process.cwd(), 'data');
const SECTORS_FILE = path.join(DATA_DIR, 'sectors.json');

/** Loaded once on first read, then authoritative in memory. */
let _cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (_cache) return _cache;
  let loaded: Record<string, string> = {};
  try {
    if (fs.existsSync(SECTORS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SECTORS_FILE, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) loaded = parsed;
    }
  } catch (err: any) {
    logger.warn(`[SectorCache] Unreadable cache — starting empty: ${err.message}`);
  }
  return (_cache = loaded);
}

/**
 * Synchronous, like the journal's: a cache is worthless if the process dies with the
 * fetch still in a timer, and repeating a Yahoo call is the cost of getting it wrong.
 * A write failure logs and continues — this must never take down a trading cycle.
 */
function save(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(SECTORS_FILE, JSON.stringify(_cache, null, 2));
  } catch (err: any) {
    logger.warn(`[SectorCache] Write failed — in-memory cache still valid: ${err.message}`);
  }
}

/**
 * Cache-only lookup. Pure: no network, no writes, safe on the 60s tick.
 * Symbols not yet fetched read as `null`.
 */
export function getCachedSectors(symbols: string[]): Record<string, string | null> {
  const cache = load();
  const out: Record<string, string | null> = {};
  for (const s of symbols) out[s] = cache[s] ?? null;
  return out;
}

/**
 * Resolve sectors, fetching only the symbols the cache has never seen.
 *
 * A symbol that resolves to `null` is NOT cached: `null` means "Yahoo told us nothing",
 * which for an ETF is permanent but for a transient failure is not, and a cached `null`
 * would be indistinguishable from the two. The retry cost is one call per cycle.
 */
export async function getSectors(symbols: string[]): Promise<Record<string, string | null>> {
  const cache = load();
  const misses = [...new Set(symbols)].filter(s => !(s in cache));

  if (misses.length > 0) {
    const fetched = await Promise.all(
      misses.map(async s => ({ symbol: s, sector: await getSectorRaw(s) })),
    );
    let dirty = false;
    for (const { symbol, sector } of fetched) {
      if (sector !== null) {
        cache[symbol] = sector;
        dirty = true;
      }
    }
    if (dirty) save();
  }

  return getCachedSectors(symbols);
}
