import { listRecords, readRecord } from '../core/storage';
import type { ModelCall } from '../core/modelBudget';

/**
 * Model usage for every day the account has run.
 *
 * Exact days come from `model-calls` (one row per call, recorded since 2026-10-16). Earlier days
 * are estimated from saved agent runs: each trajectory keeps its total tokens, so the day and the
 * agent are right but the call count is the number of runs, not of calls. A request is counted
 * from its calls when it has any and from its run otherwise, so the day recording began is
 * neither doubled nor short. Each day says which source it used.
 */

interface Totals { calls: number; inputTokens: number; outputTokens: number; failed: number }
const empty = (): Totals => ({ calls: 0, inputTokens: 0, outputTokens: 0, failed: 0 });
function add(t: Totals, input: number, output: number, failed = false) {
  t.calls++; t.inputTokens += input; t.outputTokens += output; if (failed) t.failed++;
}

export interface UsageDay extends Totals {
  day: string;
  /** `calls`: counted per model call. `runs`: estimated from saved agent runs, so `calls` counts runs. `mixed`: both. */
  source: 'calls' | 'runs' | 'mixed';
  byAgent: Record<string, Totals>;
  byModel: Record<string, Totals>;
}

interface Trajectory { inTokens?: number; outTokens?: number }
interface RequestRow { role?: string; text?: string; createdAt?: string; status?: string; actorId?: string }

/** One entry per model call or, before calls were recorded, per agent run. */
function usageRows(): Array<{ at: string; day: string; role: string; requestId: string | null; model: string | null; inputTokens: number; outputTokens: number; failed: boolean; source: 'calls' | 'runs' }> {
  const calls = listRecords<ModelCall>('model-calls').map(r => ({ ...r.value, failed: !!r.value.error, source: 'calls' as const }));
  const counted = new Set(calls.map(c => c.requestId));
  const runs = listRecords<Trajectory>('trajectories').flatMap(r => {
    const day = r.at.slice(0, 10);
    if (counted.has(r.id)) return [];
    const request = readRecord<RequestRow>('requests', r.id);
    return [{ at: r.at, day, role: request?.role ?? 'unassigned', requestId: r.id, model: null,
      inputTokens: r.value.inTokens ?? 0, outputTokens: r.value.outTokens ?? 0, failed: false, source: 'runs' as const }];
  });
  return [...runs, ...calls];
}

export function llmUsage(opts: { days?: number } = {}) {
  const since = opts.days ? new Date(Date.now() - (opts.days - 1) * 86_400_000).toISOString().slice(0, 10) : '';
  const byDay = new Map<string, UsageDay>();
  const total = empty(), byAgent: Record<string, Totals> = {}, byModel: Record<string, Totals> = {};
  for (const row of usageRows()) {
    if (row.day < since) continue;
    let day = byDay.get(row.day);
    if (!day) byDay.set(row.day, day = { day: row.day, source: row.source, ...empty(), byAgent: {}, byModel: {} });
    else if (day.source !== row.source) day.source = 'mixed';
    add(day, row.inputTokens, row.outputTokens, row.failed);
    add(day.byAgent[row.role] ??= empty(), row.inputTokens, row.outputTokens, row.failed);
    add(total, row.inputTokens, row.outputTokens, row.failed);
    add(byAgent[row.role] ??= empty(), row.inputTokens, row.outputTokens, row.failed);
    if (row.model) {
      add(day.byModel[row.model] ??= empty(), row.inputTokens, row.outputTokens, row.failed);
      add(byModel[row.model] ??= empty(), row.inputTokens, row.outputTokens, row.failed);
    }
  }
  const days = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
  return { days, total, byAgent, byModel,
    caveats: days.some(d => d.source !== 'calls')
      ? ['Days marked "estimated" (fully or partly) come from saved agent runs: tokens and agents are right, but the count is runs, not individual model calls, and the model is not known.']
      : [] };
}

/** The requests that used the most tokens on one day, largest first. */
export function llmUsageForDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
  const byRequest = new Map<string, Totals & { requestId: string | null; role: string; firstAt: string; lastAt: string; source: string }>();
  for (const row of usageRows()) {
    if (row.day !== day) continue;
    const key = row.requestId ?? 'none:' + row.role;
    let r = byRequest.get(key);
    if (!r) byRequest.set(key, r = { ...empty(), requestId: row.requestId, role: row.role, firstAt: row.at, lastAt: row.at, source: row.source });
    add(r, row.inputTokens, row.outputTokens, row.failed);
    if (row.at < r.firstAt) r.firstAt = row.at;
    if (row.at > r.lastAt) r.lastAt = row.at;
  }
  const requests = [...byRequest.values()].map(r => {
    const request = r.requestId ? readRecord<RequestRow>('requests', r.requestId) : undefined;
    return { ...r, task: request?.text ?? null, status: request?.status ?? null, startedBy: request?.actorId ?? null };
  }).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  return { day, requests };
}
