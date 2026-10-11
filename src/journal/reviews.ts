import { agentContext } from '../core/agentContext';
import { listRecords, readRecord, saveRecord } from '../core/storage';

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

/** Saved reviews from one tool, newest first. */
export function listReviews<T>(tool: ReviewTool, where: (review: T) => boolean = () => true, limit = Infinity): T[] {
  const out: T[] = [];
  for (const { value } of listRecords<{ name: string; result?: string }>('tool-calls', { where: r => r.name === tool, desc: true })) {
    if (out.length >= limit) break;
    let parsed: any;
    try { parsed = JSON.parse(value.result ?? ''); } catch { continue; }
    if (parsed?.ok && parsed.review && where(parsed.review)) out.push(parsed.review);
  }
  return out;
}
