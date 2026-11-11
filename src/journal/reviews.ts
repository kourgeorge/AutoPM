import { agentContext } from '../core/agentContext';
import { iterateRecords, readRecord, saveRecord } from '../core/storage';

/**
 * A review is the result of the tool call that recorded it: one copy, kept with the request,
 * agent and evidence it came from. Saved outside a tool call, it is a receipt of its own.
 */
export type ReviewTool = 'record_position_review' | 'record_candidate_review' | 'record_research_review';

export function saveReview<T extends { id: string; at: string }>(tool: ReviewTool, review: T, note: string) {
  const result = { ok: true, reviewId: review.id, note, review };
  const id = agentContext.getStore()?.toolCallId ?? review.id;
  saveRecord('tool-calls', id, { name: tool, input: {}, startedAt: review.at, ...readRecord<object>('tool-calls', id),
    kind: 'record', result: JSON.stringify(result), finishedAt: review.at });
  return result;
}

/** Saved reviews from one tool, newest first. `days`: how many recent day folders to read (storage default if unset). */
export function listReviews<T>(tool: ReviewTool, where: (review: T) => boolean = () => true, limit = Infinity, days?: number): T[] {
  const out: T[] = [];
  if (limit <= 0) return out;
  for (const { value } of iterateRecords<{ name: string; result?: string }>('tool-calls', { name: tool, desc: true, days })) {
    let parsed: any;
    try { parsed = JSON.parse(value.result ?? ''); } catch { continue; }
    if (parsed?.ok && parsed.review && where(parsed.review)) {
      out.push(parsed.review);
      if (out.length >= limit) break;
    }
  }
  return out;
}
