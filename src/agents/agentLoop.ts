import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ContentBlock } from '../core/types';
import type { ModelProvider } from '../core/modelProvider';
import { agentContext, type AgentContext } from '../core/agentContext';
import { readRecord, saveRecord } from '../core/storage';
import type { ToolRegistry } from './toolRegistry';
import { logger } from '../core/logger';

export type TurnStatus = 'completed' | 'waiting' | 'interrupted' | 'failed';
export interface Transcript {
  id: string; messages: ChatMessage[]; rounds: number; status: TurnStatus | 'running';
  inTokens: number; outTokens: number; text: string; error?: string; sleepMs?: number;
  revision?: string;
  responseStopReason?: string;
}
type ToolCall = Extract<ContentBlock, { type: 'tool_use' }>;
interface ToolCallRecord { name: string; input: unknown; result?: string }
/** Room for a few full-length model requests plus tools — must stay well above MODEL_CALL_TIMEOUT_MS. */
const TURN_TIMEOUT_MS = 300_000;
/** What the operator reads instead of the platform's "The operation was aborted due to timeout". */
export const SLOW_MODEL_MESSAGE = 'The AI service is responding slowly right now and this request timed out. Please try again in a minute.';
/** Both the fetch/turn deadline (DOMException TimeoutError) and the Anthropic SDK's own timeout error. */
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
function boundedResult(raw: string): string {
  return raw.length <= 10000 ? raw : JSON.stringify({ truncated: true, preview: raw.slice(0,8000), note: 'Narrow the query to retrieve a complete result.' });
}

/** Repair legacy histories and trim whole exchanges, never leaving orphaned tool results. */
export function compactMessages(input: ChatMessage[], limit = 60000): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < input.length; i++) {
    const m = structuredClone(input[i]);
    if (m.role === 'user' && m.content.every(b => b.type === 'tool_result')) continue;
    m.content = m.content.map(b => b.type === 'text' ? { ...b, text: b.text.slice(0,24000) } : b);
    messages.push(m);
    const calls = m.content.filter((b): b is ToolCall => b.type === 'tool_use');
    if (m.role === 'assistant' && calls.length) {
      const next = input[i+1];
      const results = next?.role === 'user' ? next.content.filter(b => b.type === 'tool_result') : [];
      messages.push({ role: 'user', content: calls.map(call => {
        const result = results.find(b => b.type === 'tool_result' && b.tool_use_id === call.id);
        return { type: 'tool_result', tool_use_id: call.id, content: boundedResult(result?.type === 'tool_result' ? result.content : errorResult('Previous tool outcome unavailable. Inspect command/action status before retrying.')) };
      }) });
      if (next?.content.every(b => b.type === 'tool_result')) i++;
    }
  }
  while (JSON.stringify(messages).length > limit && messages.length > 3) {
    // Keep the latest user's request and the latest complete exchanges.
    const nextUser = messages.findIndex((m,i) => i > 0 && m.role === 'user' && m.content.some(b => b.type === 'text'));
    if (nextUser > 0) messages.splice(0, nextUser);
    else messages.splice(1, messages[1]?.content.some(b => b.type === 'tool_use') ? 2 : 1);
  }
  return messages;
}

export async function runAgentLoop(opts: {
  context: AgentContext; provider: ModelProvider; registry: ToolRegistry; systemPrompt: string;
  messages: () => Promise<ChatMessage[]>; maxRounds: number; maxTokens: number;
  signal?: AbortSignal; beforeTool?: () => void;
  revision?: string;
}): Promise<Transcript> {
  const id = opts.context.requestId;
  let run = readRecord<Transcript>('transcripts', id);
  if (run && ['completed','waiting','failed'].includes(run.status)) return run;
  const signal = AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]);
  const context = { ...opts.context, signal };
  run ??= { id, messages: [], rounds: 0, status: 'running', inTokens: 0, outTokens: 0, text: '', revision: opts.revision };
  const current = run;
  const checkpoint = () => saveRecord('transcripts', id, current);
  return agentContext.run(context, async () => {
    try {
      signal.throwIfAborted();
      if (current.revision !== opts.revision) throw new Error('Strategy changed since this turn began; inspect linked actions and submit a fresh request');
      if (!current.messages.length) current.messages = compactMessages(await abortable(opts.messages(), signal));
      current.status = 'running'; current.error = undefined; checkpoint();
      while (true) {
        signal.throwIfAborted();
        // A saved assistant batch is resumed using the same attempt identities.
        const last = current.messages.at(-1);
        const calls = last?.role === 'assistant' ? last.content.filter((b): b is ToolCall => b.type === 'tool_use') : [];
        if (last?.role === 'assistant' && current.responseStopReason === 'max_tokens') {
          current.messages = compactMessages(current.messages);
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
              saveRecord('tool-calls', toolCallId, { requestId: id, role: context.role, actorId: context.actorId, name: call.name, input: call.input, startedAt });
              result = finish ? errorResult('Turn has ended; this call was not executed')
                : await abortable(agentContext.run({ ...context, toolCallId }, () => opts.registry.execute(call.name, call.input)), signal);
              // Keep the complete receipt; only the model's context is size-bounded below.
              saveRecord('tool-calls', toolCallId, { requestId: id, role: context.role, actorId: context.actorId, name: call.name, input: call.input, result, startedAt, finishedAt: new Date().toISOString() });
              logger.tool(context.role, call.name, result, call.input, { id: toolCallId, requestId: id });
            }
            results.push({ type: 'tool_result', tool_use_id: call.id, content: boundedResult(result) });
            if (call.name === 'sleep') {
              const value = JSON.parse(result);
              if (value.ok) { finish = true; current.sleepMs = value.sleepMs; }
            }
          }
          current.messages.push({ role: 'user', content: results }); checkpoint();
          if (finish) { current.status = 'completed'; break; }
        }
        if (current.rounds >= opts.maxRounds) { current.status = 'failed'; current.error = 'Turn reached its tool-round limit; review saved actions before retrying'; break; }
        current.messages = compactMessages(current.messages);
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
          current.messages = compactMessages(current.messages); // Incomplete calls must never execute.
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
      current.error = isTimeout(err) ? SLOW_MODEL_MESSAGE : err?.message ?? String(err);
    }
    checkpoint();
    return current;
  });
}
