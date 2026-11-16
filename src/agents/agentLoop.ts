import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ContentBlock } from '../core/types';
import type { ModelProvider } from '../core/modelProvider';
import { agentContext, type AgentContext } from '../core/agentContext';
import { readRecord, saveRecord } from '../core/storage';
import { saveContext } from './savedResults';
import type { ToolRegistry } from './toolRegistry';
import { logger } from '../core/logger';
import { REQUEST_CHAR_LIMIT } from '../core/modelBudget';

export type TurnStatus = 'completed' | 'waiting' | 'interrupted' | 'failed';
export interface Trajectory {
  id: string; messages: ChatMessage[]; rounds: number; status: TurnStatus | 'running';
  inTokens: number; outTokens: number; text: string; error?: string;
  revision?: string;
  responseStopReason?: string;
  /** Texts left out of the model's context, by id; get_saved_context reads them. */
  saved?: Record<string, string>;
  /** Set when the turn was stopped by its round or input-token limit (see `TurnLimits`). */
  endReason?: TurnEndReason;
  /** The "decide now" warning was already sent to the model in this turn. */
  limitWarned?: boolean;
}
export type TurnEndReason = 'round_limit' | 'token_limit';
/**
 * How far one turn may run. Without it a single trader turn once ran 24 hours (346 model round
 * trips, 414 tool calls). `warnRounds` rounds before the round limit (or at 80% of the token
 * limit) the model is told to decide with what it has; at the limit the turn ends cleanly
 * after its last tool batch has run, with `endReason` saved in the trajectory.
 */
export interface TurnLimits { maxRounds: number; maxInputTokens: number; warnRounds: number }
/** What the model reads when its turn is close to the limit. */
export const TURN_LIMIT_WARNING = 'TURN LIMIT: this turn is nearly out of rounds. Do not read or look up anything more. Decide now with the evidence you already have: record each open decision (trade or hold, with its reason), then call sleep.';

type ToolCall = Extract<ContentBlock, { type: 'tool_use' }>;
interface ToolCallRecord { name: string; input: unknown; result?: string }
/** What the operator reads instead of the platform's "The operation was aborted due to timeout". */
export const SLOW_MODEL_MESSAGE = 'The AI service is responding slowly right now and this request timed out. Please try again in a minute.';
/** What the operator reads instead of Node's bare "fetch failed" once every retry has dropped. */
export const UNREACHABLE_MODEL_MESSAGE = 'Could not reach the AI service — the connection kept dropping, even after retries. Please try again in a minute.';
/**
 * A turn has no overall deadline. It ends when the agent stops calling tools, the operator stops
 * it, or it reaches the caller's optional round/input-token limit (`TurnLimits`). A single hung
 * model request times out — the fetch deadline (DOMException TimeoutError) or the Anthropic SDK's own timeout error.
 */
function isTimeout(err: any): boolean {
  return err?.name === 'TimeoutError' || err instanceof Anthropic.APIConnectionTimeoutError;
}
const errorResult = (error: string) => JSON.stringify({ ok: false, error });
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function boundedResult(raw: string, receiptId?: string): string {
  return raw.length <= 10000 ? raw : JSON.stringify({ truncated: true, receiptId, totalCharacters: raw.length,
    note: receiptId ? 'Read get_tool_result(receiptId, offset, limit) for complete pages. No evidence was discarded.' : 'Legacy result is oversized; repeat a narrower query to retrieve complete evidence.' });
}

/**
 * A saved trajectory keeps each tool result as its receipt id, because the text already lives
 * in tool-calls. `readTrajectory` puts the text back exactly as the model saw it.
 */
const receiptMark = (receiptId: string) => `[Saved as receipt ${receiptId}; read it with get_tool_result.]`;
function withoutResults(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => ({ ...m, content: m.content.map(b => b.type === 'tool_result' && b.receiptId ? { ...b, content: receiptMark(b.receiptId) } : b) }));
}
function withResults(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => ({ ...m, content: m.content.map(b => {
    if (b.type !== 'tool_result' || !b.receiptId || b.content !== receiptMark(b.receiptId)) return b;
    const saved = readRecord<ToolCallRecord>('tool-calls', b.receiptId)?.result;
    return { ...b, content: saved === undefined ? errorResult('Saved tool receipt is unavailable') : boundedResult(saved, b.receiptId) };
  }) }));
}
export function readTrajectory(id: string): Trajectory | undefined {
  const run = readRecord<Trajectory>('trajectories', id);
  return run && { ...run, messages: withResults(run.messages) };
}

/**
 * How much of a turn's own conversation the model keeps, in characters, when no tool list is
 * known. It was 60,000: the cycle context plus five or six 8–10k tool results filled it, the
 * oldest reads were trimmed, the model was told "omitted evidence is unknown", and so it re-read
 * the same status/positions/orders/scan over and over (2026-11-09 IBM loop). Then it was raised
 * to 300,000, above the 200,000 whole-request cap in `withModelBudget`, so long trader reviews
 * failed with "Model context exceeds the account request limit" instead of being trimmed.
 * `runAgentLoop` now trims to whatever the cap leaves after its instructions and tool list
 * (`turnMessageLimit`), so the two limits cannot drift apart again.
 */
export const TURN_CONTEXT_LIMIT = REQUEST_CHAR_LIMIT;
/** Room for the request's other fields (maxTokens, signal) and JSON punctuation. */
const REQUEST_OVERHEAD_MARGIN = 2000;
/** Message room left in one model request once the instructions and tool list are counted. */
export function turnMessageLimit(systemPrompt: string, tools: unknown): number {
  return REQUEST_CHAR_LIMIT - JSON.stringify({ systemPrompt, tools }).length - REQUEST_OVERHEAD_MARGIN;
}

/**
 * The pinned blocks in messages[0]. Both are rebuilt in place, never appended: one trimming note
 * per turn used to be pushed on EVERY trim, and in the 2026-11-12 turns 217–294 of them filled
 * 55–75k of the ~100k left for the conversation, so the model saw only its last round, re-read
 * everything and failed at the request cap (docs/research/trader-token-use.md).
 */
const TRIM_MARK = 'TRIMMED: ';
const PROGRESS_MARK = 'TURN PROGRESS';
/** Room kept for the one trimming note; its text is a few hundred characters. */
const NOTE_ROOM = 700;
const isPinned = (b: ContentBlock) => b.type === 'text' && (b.text.startsWith(TRIM_MARK) || b.text.startsWith(PROGRESS_MARK));
function trimNote(count: number, id: string | null): ContentBlock {
  return { type: 'text', text: `${TRIM_MARK}${count} earlier messages of this conversation were left out to fit context.`
    + (id ? ` The latest left-out part is saved as ${id} ; each saved part names the part before it ("earlier"). Read them with get_saved_context.` : '')
    + ' Saved tool receiptIds retrieve full results with get_tool_result. Omitted evidence is unknown, not empty; the TURN PROGRESS block lists what this turn already read and recorded.' };
}
function parseNote(b: ContentBlock | undefined): { count: number; id: string | null } {
  const m = b?.type === 'text' ? /^TRIMMED: (\d+) earlier(?:[^]*?saved as (\S+) ;)?/.exec(b.text) : null;
  return { count: m ? Number(m[1]) : 0, id: m?.[2] ?? null };
}

/**
 * Repair legacy histories and trim whole exchanges, never leaving orphaned tool results.
 * `progress` (the TURN PROGRESS text) is pinned in messages[0] and never trimmed; it and the one
 * trimming note count toward `limit`.
 */
export function compactMessages(input: ChatMessage[], limit = TURN_CONTEXT_LIMIT, progress = ''): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let note: ContentBlock | undefined;
  for (let i = 0; i < input.length; i++) {
    const m = structuredClone(input[i]);
    note ??= m.content.find(b => b.type === 'text' && b.text.startsWith(TRIM_MARK));
    m.content = m.content.filter(b => !isPinned(b));
    if (m.role === 'user' && m.content.every(b => b.type === 'tool_result')) continue;
    messages.push(m);
    const calls = m.content.filter((b): b is ToolCall => b.type === 'tool_use');
    if (m.role === 'assistant' && calls.length) {
      const next = input[i+1];
      const results = next?.role === 'user' ? next.content.filter(b => b.type === 'tool_result') : [];
      const answered: ContentBlock[] = calls.map(call => {
        const result = results.find(b => b.type === 'tool_result' && b.tool_use_id === call.id);
        const receiptId = result?.type === 'tool_result' ? result.receiptId : undefined;
        return { type: 'tool_result', tool_use_id: call.id, receiptId, content: boundedResult(result?.type === 'tool_result' ? result.content : errorResult('Previous tool outcome unavailable. Inspect command/action status before retrying.'), receiptId) };
      });
      // A note sent with the results (the turn-limit warning) stays with them.
      messages.push({ role: 'user', content: [...answered, ...(results.length ? next.content.filter(b => b.type !== 'tool_result' && !isPinned(b)) : [])] });
      if (results.length) i++;
    }
  }
  const pinned: ContentBlock[] = progress ? [{ type: 'text', text: progress }] : [];
  const pinnedSize = JSON.stringify(pinned).length + NOTE_ROOM;
  const removed: ChatMessage[] = [];
  while (JSON.stringify(messages).length + pinnedSize > limit && messages.length > 3) {
    // Keep the latest user's request and the latest complete exchanges.
    const nextUser = messages.findIndex((m,i) => i > 0 && m.role === 'user' && m.content.some(b => b.type === 'text') && !m.content.some(b => b.type === 'tool_result'));
    if (nextUser > 0) removed.push(...messages.splice(0, nextUser));
    else removed.push(...messages.splice(1, messages[1]?.content.some(b => b.type === 'tool_use') ? 2 : 1));
  }
  if (removed.length) {
    // One note, replaced: it counts every left-out message and points at the newest saved part,
    // which names the one before it, so the note stays the same size however often it trims.
    const before = parseNote(note);
    const id = saveContext(JSON.stringify({ earlier: before.id, messages: withoutResults(removed) }));
    note = trimNote(before.count + removed.length, id ?? before.id);
  }
  const head = [...(note ? [note] : []), ...pinned];
  if (head.length) {
    if (messages[0]?.role === 'user' && !messages[0].content.some(b => b.type === 'tool_result')) messages[0].content.push(...head);
    else messages.unshift({ role: 'user', content: head });
  }
  return messages;
}

interface Receipt { id: string; round: number; name: string; input: Record<string, any>; value: any; finishedAt?: string }
const parseJson = (text?: string) => { try { return text === undefined ? undefined : JSON.parse(text); } catch { return undefined; } };
const succeeded = (v: any) => v != null && typeof v === 'object' && v.ok !== false && !v.error;
/** Input fields that say WHAT was read. Free-text fields (reasons, notes) are left out, not cut. */
const KEY_INPUTS = ['symbol', 'symbols', 'snapshotId', 'receiptId', 'id', 'offset', 'before', 'kind', 'timeframe', 'query'];
const keyInput = (input: Record<string, any>) => JSON.stringify(Object.fromEntries(KEY_INPUTS.filter(k => input?.[k] !== undefined).map(k => [k, input[k]])));
const REVIEW_TOOLS = ['record_candidate_review', 'record_position_review'];
const ORDER_TOOLS = ['execute_entry', 'execute_exit'];
/** Distinct reads listed; older ones are counted, not listed (fewer rows, never shorter text). */
const PROGRESS_READ_ROWS = 40;
const sameSym = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase();

/**
 * The TURN PROGRESS block: facts from this turn's receipts, so a trimmed round does not make the
 * model re-read what it already has, and a refused sleep's open list stays in view until each
 * item is resolved. It lists items only; it never quotes or shortens the model's reason text.
 */
export function turnProgress(receipts: Receipt[], now = Date.now()): string {
  if (!receipts.length) return '';
  const age = (at?: string) => {
    const ms = at ? now - Date.parse(at) : NaN;
    return !Number.isFinite(ms) ? 'age unknown' : ms < 60_000 ? 'under 1 min ago' : `${Math.round(ms / 60_000)} min ago`;
  };
  const reads = new Map<string, { r: Receipt; times: number }>();
  const reviews: string[] = [], acks: string[] = [], orders: string[] = [];
  let refusal: { index: number; r: Receipt } | undefined;
  receipts.forEach((r, index) => {
    const ok = succeeded(r.value);
    const symbol = r.input?.symbol ?? r.value?.symbol;
    if (r.name === 'sleep') { if (!ok) refusal = { index, r }; return; }
    if (!ok) return;
    if (REVIEW_TOOLS.includes(r.name)) reviews.push(`- ${r.name} ${symbol ?? ''} decision ${r.value?.review?.decision ?? 'recorded'} (receipt ${r.id})`);
    else if (r.name === 'ack_event') acks.push(`- ${r.input?.id} ${r.input?.disposition ?? ''} (receipt ${r.id})`);
    else if (ORDER_TOOLS.includes(r.name)) orders.push(`- ${r.name} ${symbol ?? ''}${r.value?.orderId ? ` order ${r.value.orderId}` : ''}${r.value?.status ? ` status ${r.value.status}` : ''} (receipt ${r.id})`);
    else {
      const key = `${r.name} ${keyInput(r.input)}`;
      const seen = reads.get(key);
      reads.delete(key); reads.set(key, { r, times: (seen?.times ?? 0) + 1 });
    }
  });
  const lines = [`${PROGRESS_MARK} (kept by the system and rebuilt every round from this turn's receipts; never trimmed). What this turn has already done:`];
  if (reads.size) {
    const all = [...reads.entries()], shown = all.slice(-PROGRESS_READ_ROWS);
    lines.push('Reads done (newest last; the age is when the read ran; re-read only when you need fresher data):');
    if (all.length > shown.length) lines.push(`- ${all.length - shown.length} older distinct reads are not listed here; their receipts still read with get_tool_result.`);
    for (const [key, { r, times }] of shown) lines.push(`- ${key} receipt ${r.id}, ${age(r.finishedAt)}${times > 1 ? `, read ${times} times` : ''}`);
  }
  if (reviews.length) lines.push('Reviews recorded:', ...reviews);
  if (acks.length) lines.push('Events acked:', ...acks);
  if (orders.length) lines.push('Orders sent:', ...orders);
  if (refusal) {
    const after = receipts.slice(refusal.index + 1).filter(r => succeeded(r.value));
    const open: { symbol: string | null; problem: string }[] = Array.isArray(refusal.r.value?.open) ? refusal.r.value.open : [];
    const resolved = (item: { symbol: string | null }) => after.some(r => {
      if (item.symbol == null) return r.name === 'get_watchlist_scan';
      if (!sameSym(r.input?.symbol ?? r.value?.symbol, item.symbol)) return false;
      if (ORDER_TOOLS.includes(r.name) || r.name === 'request_research') return true;
      return REVIEW_TOOLS.includes(r.name) && !['buy', 'reduce', 'exit'].includes(r.value?.review?.decision);
    });
    const still = open.filter(item => !resolved(item));
    if (still.length) lines.push(`Your sleep was refused (receipt ${refusal.r.id}). Still open:`, ...still.map(i => `- ${i.symbol ?? '(account)'}: ${i.problem}`));
    else if (open.length) lines.push(`Your sleep was refused (receipt ${refusal.r.id}); all open decisions are recorded, call sleep.`);
    else lines.push(`Your sleep was refused (receipt ${refusal.r.id}): ${refusal.r.value?.error ?? 'see the receipt'}`);
  }
  return lines.join('\n');
}

export async function runAgentLoop(opts: {
  context: AgentContext; provider: ModelProvider; registry: ToolRegistry; systemPrompt: string;
  messages: () => Promise<ChatMessage[]>; maxTokens: number;
  signal?: AbortSignal; beforeTool?: () => void;
  revision?: string;
  /** Optional cap on this turn's rounds and input tokens; none means no cap. */
  limits?: TurnLimits;
}): Promise<Trajectory> {
  const id = opts.context.requestId;
  let run = readTrajectory(id);
  if (run && ['completed','waiting','failed'].includes(run.status)) return run;
  const signal = opts.signal ?? new AbortController().signal;
  run ??= { id, messages: [], rounds: 0, status: 'running', inTokens: 0, outTokens: 0, text: '', revision: opts.revision };
  const current = run;
  const limit = turnMessageLimit(opts.systemPrompt, opts.registry.definitions);
  const context = { ...opts.context, signal, saved: current.saved ??= {} };
  const checkpoint = () => saveRecord('trajectories', id, { ...current, messages: withoutResults(current.messages) });
  // This turn's finished receipts, read once each, for the TURN PROGRESS block.
  const receipts = new Map<string, Receipt>();
  const progress = () => {
    for (let round = 1; round <= current.rounds; round++) for (let index = 0; ; index++) {
      const receiptId = `${id}:${round}:${index}`;
      if (receipts.has(receiptId)) continue;
      const rec = readRecord<ToolCallRecord & { finishedAt?: string }>('tool-calls', receiptId);
      if (!rec) break;
      if (rec.result === undefined) continue;
      receipts.set(receiptId, { id: receiptId, round, name: rec.name, input: (rec.input ?? {}) as Record<string, any>, value: parseJson(rec.result), finishedAt: rec.finishedAt });
    }
    return turnProgress([...receipts.values()].sort((a, b) => a.round - b.round || a.id.localeCompare(b.id, undefined, { numeric: true })));
  };
  return agentContext.run(context, async () => {
    try {
      signal.throwIfAborted();
      if (current.revision !== opts.revision) throw new Error('Strategy changed since this turn began; inspect linked actions and submit a fresh request');
      if (!current.messages.length) current.messages = compactMessages(await abortable(opts.messages(), signal), limit);
      current.status = 'running'; current.error = undefined; checkpoint();
      while (true) {
        signal.throwIfAborted();
        // A saved assistant batch is resumed using the same attempt identities.
        const last = current.messages.at(-1);
        const calls = last?.role === 'assistant' ? last.content.filter((b): b is ToolCall => b.type === 'tool_use') : [];
        if (last?.role === 'assistant' && current.responseStopReason === 'max_tokens') {
          current.messages = compactMessages(current.messages, limit);
          current.status = 'failed'; current.error = 'Model output was truncated; no truncated tool batch was executed'; break;
        }
        if (last?.role === 'assistant' && !calls.length && current.responseStopReason) {
          current.text = last.content.filter((b): b is Extract<ContentBlock,{type:'text'}> => b.type === 'text').map(b => b.text).join('\n');
          current.status = 'completed'; break;
        }
        if (calls.length) {
          const results: ContentBlock[] = [];
          let finish = false;
          for (const [index, call] of calls.entries()) {
            signal.throwIfAborted(); opts.beforeTool?.();
            const toolCallId = `${id}:${current.rounds}:${index}`;
            const saved = readRecord<ToolCallRecord>('tool-calls', toolCallId);
            if (saved?.name !== undefined && (saved.name !== call.name || JSON.stringify(saved.input) !== JSON.stringify(call.input))) throw new Error('Saved tool identity mismatch');
            let result = saved?.result;
            if (result === undefined) {
              const startedAt = new Date().toISOString();
              saveRecord('tool-calls', toolCallId, { requestId: id, role: context.role, actorId: context.actorId, name: call.name, kind: opts.registry.kind(call.name), input: call.input, startedAt });
              result = finish ? errorResult('Turn has ended; this call was not executed')
                : await abortable(agentContext.run({ ...context, toolCallId }, () => opts.registry.execute(call.name, call.input)), signal);
              // Keep the complete receipt; only the model's context is size-bounded below.
              // Merge: the tool may have attached a page snapshot to its own receipt.
              saveRecord('tool-calls', toolCallId, { ...readRecord<object>('tool-calls', toolCallId), requestId: id, role: context.role, actorId: context.actorId, name: call.name, kind: opts.registry.kind(call.name), input: call.input, result, startedAt, finishedAt: new Date().toISOString() });
              logger.tool(context.role, call.name, result, call.input, { id: toolCallId, requestId: id });
            }
            results.push({ type: 'tool_result', tool_use_id: call.id, receiptId: toolCallId, content: boundedResult(result, toolCallId) });
            if (call.name === 'sleep') {
              const value = JSON.parse(result);
              if (value.ok) finish = true;
            }
          }
          current.messages.push({ role: 'user', content: results }); checkpoint();
          if (finish) { current.status = 'completed'; break; }
        }
        const limits = opts.limits;
        if (limits) {
          const endReason: TurnEndReason | undefined = current.rounds >= limits.maxRounds ? 'round_limit'
            : current.inTokens >= limits.maxInputTokens ? 'token_limit' : undefined;
          if (endReason) {
            // The last tool batch has fully run; stop before asking the model again.
            current.endReason = endReason; current.status = 'completed';
            current.text = endReason === 'round_limit'
              ? `Turn stopped at its round limit (${current.rounds} of ${limits.maxRounds} rounds).`
              : `Turn stopped at its input-token limit (${current.inTokens} of ${limits.maxInputTokens} tokens).`;
            logger.warn(`[${context.role}] ${id}: ${current.text}`);
            break;
          }
          const lastMessage = current.messages.at(-1);
          if (!current.limitWarned && lastMessage?.role === 'user'
            && (current.rounds >= limits.maxRounds - limits.warnRounds || current.inTokens >= limits.maxInputTokens * 0.8)) {
            lastMessage.content.push({ type: 'text', text: TURN_LIMIT_WARNING });
            current.limitWarned = true; checkpoint();
            logger.warn(`[${context.role}] ${id}: turn near its limit (${current.rounds} rounds, ${current.inTokens} input tokens); told the model to decide now`);
          }
        }
        current.messages = compactMessages(current.messages, limit, progress());
        const response = await abortable(opts.provider.chat({ systemPrompt: opts.systemPrompt, messages: current.messages,
          tools: opts.registry.definitions, maxTokens: opts.maxTokens, signal }), signal);
        signal.throwIfAborted();
        current.rounds++; current.inTokens += response.usage.inputTokens; current.outTokens += response.usage.outputTokens;
        const ids = new Set<string>();
        const content = response.content.map(b => {
          if (b.type !== 'tool_use') return b;
          const id = b.id && !ids.has(b.id) ? b.id : crypto.randomUUID(); ids.add(id); return { ...b, id };
        });
        current.responseStopReason = response.stopReason;
        current.messages.push({ role: 'assistant', content }); checkpoint();
        if (response.stopReason === 'max_tokens') {
          current.messages = compactMessages(current.messages, limit); // Incomplete calls must never execute.
          current.status = 'failed'; current.error = 'Model output was truncated; no truncated tool batch was executed'; break;
        }
        if (content.some(b => b.type === 'tool_use')) continue;
        current.text = content.filter((b): b is Extract<ContentBlock,{type:'text'}> => b.type === 'text').map(b => b.text).join('\n');
        current.status = 'completed'; break;
      }
    } catch (err: any) {
      // Only the caller's own stop counts as an interruption: an interrupted request stays queued
      // and halts the assistant's queue, so a timeout marked that way would stall the chat and
      // later re-run a question the operator has already given up on.
      current.status = opts.signal?.aborted ? 'interrupted' : 'failed';
      current.error = isTimeout(err) ? SLOW_MODEL_MESSAGE
        : err instanceof TypeError && err.message === 'fetch failed' ? UNREACHABLE_MODEL_MESSAGE
        : err?.message ?? String(err);
    }
    checkpoint();
    return current;
  });
}
