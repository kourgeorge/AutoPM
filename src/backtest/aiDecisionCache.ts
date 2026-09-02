/**
 * L1.5 — decision cache for the AI backtest: one JSON map keyed by a hash of the exact input
 * sent to the model. Same pattern as `src/collect/sectorCache.ts`: tolerant load, atomic write,
 * no TTL — a closed trading day's decision never changes, so deleting the file is the only
 * invalidation.
 *
 * This does NOT give a "pay once, sweep mechanical params for free" story: changing
 * `maxPositions` or the safety-net stop settings changes which positions are open on a given
 * day, which changes that day's dossier text, which busts the cache key from that point
 * forward. It only guarantees a free repeat run of the exact same backtest.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeFileAtomic } from '../core/fsAtomic';
import { DATA_DIR, ensureDataDir } from '../core/paths';
import { logger } from '../core/logger';
import type { Decision } from './aiDecision';

const CACHE_FILE = path.join(DATA_DIR, 'aiDecisionCache.json');

interface CacheEntry {
  model: string;
  decisions: Decision[];
}

let _cache: Record<string, CacheEntry> | null = null;

function load(): Record<string, CacheEntry> {
  if (_cache) return _cache;
  let loaded: Record<string, CacheEntry> = {};
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) loaded = parsed;
    }
  } catch (err: any) {
    logger.warn(`[AiDecisionCache] Unreadable cache — starting empty: ${err.message}`);
  }
  _cache = loaded;
  return _cache;
}

function save(): void {
  try {
    ensureDataDir();
    writeFileAtomic(CACHE_FILE, JSON.stringify(_cache, null, 2));
  } catch (err: any) {
    logger.warn(`[AiDecisionCache] Write failed — in-memory cache still valid: ${err.message}`);
  }
}

/** Hash of the exact rendered model input — model + system prompt + tool schema + dossier text. */
export function decisionCacheKey(model: string, systemPrompt: string, toolSchemaJson: string, dossierText: string): string {
  return crypto
    .createHash('sha256')
    .update(model).update('\0')
    .update(systemPrompt).update('\0')
    .update(toolSchemaJson).update('\0')
    .update(dossierText)
    .digest('hex');
}

export function getCachedDecision(key: string): Decision[] | null {
  return load()[key]?.decisions ?? null;
}

export function cacheDecision(key: string, decisions: Decision[], model: string): void {
  load()[key] = { model, decisions };
  save();
}
