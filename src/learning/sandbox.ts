/**
 * Runs indicator code written by the model, kept away from the engine.
 *
 * The contract the model writes to:
 *
 *   function signal(o, h, l, c, v) { ...; return score; }
 *
 * The five arguments are plain number arrays for the last WINDOW daily bars, oldest first
 * (open, high, low, close, volume). It returns ONE number from -1 (bearish) to +1 (bullish)
 * for the newest bar, or null when it cannot say. Because it only ever receives bars up to the
 * day being scored, it cannot peek at the future.
 *
 * How it is kept apart:
 * - it runs in its own `vm` context with code-from-text (`eval`, `new Function`) switched off;
 * - nothing from the engine is passed in: data goes in as a JSON string and results come out
 *   as a JSON string, so the code never holds a single engine object;
 * - every run has a time limit;
 * - a word check refuses obvious ways out (`require`, `process`, `import`, `constructor`, …).
 * Node's `vm` is not a hard security wall against a determined attacker. The code here comes
 * only from our own model, prompted with nothing but signal statistics (no web text), so the
 * real risks are bugs — endless loops, nonsense numbers — and those are what this guards.
 *
 * During testing the windows of one stock are scored in a random order, so code that tries to
 * remember earlier calls gains nothing and cannot behave differently from a single live call.
 */
import vm from 'vm';

export const WINDOW = 60;  // the live tick's daily bar count (collect/index.ts barLimit)
const MAX_CODE = 6000;
const FORBIDDEN = /\b(require|import|process|globalThis|global|constructor|prototype|__proto__|Function|eval|this|Reflect|Proxy|WebAssembly|Atomics|SharedArrayBuffer|setTimeout|setInterval|queueMicrotask|Symbol|fetch)\b/;

export interface CompiledSignal { run(windows: BarArrays[], timeoutMs?: number): (number | null)[] }
export interface BarArrays { o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }

/** Throws a plain-English reason when the code is not acceptable. */
export function checkCode(code: string): void {
  if (typeof code !== 'string' || !code.trim()) throw new Error('No code given');
  if (code.length > MAX_CODE) throw new Error(`Code is longer than ${MAX_CODE} characters`);
  const bad = code.match(FORBIDDEN);
  if (bad) throw new Error(`Code uses "${bad[0]}", which is not allowed`);
  if (!/function\s+signal\s*\(/.test(code)) throw new Error('Code must define function signal(o, h, l, c, v)');
}

const RUNNER = `
(function (input) {
  'use strict';
  var data = JSON.parse(input), out = new Array(data.length);
  var order = []; for (var i = 0; i < data.length; i++) order.push(i);
  for (var k = order.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var t = order[k]; order[k] = order[j]; order[j] = t; }
  for (var n = 0; n < order.length; n++) {
    var w = data[order[n]], s;
    try { s = __signal(w.o.slice(), w.h.slice(), w.l.slice(), w.c.slice(), w.v.slice()); } catch (e) { s = 'error:' + String(e && e.message || e).slice(0, 200); }
    out[order[n]] = s;
  }
  return JSON.stringify(out);
})`;

export function compileSignal(code: string): CompiledSignal {
  checkCode(code);
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  // The user's function is wrapped so its own top-level names stay out of the runner's scope.
  new vm.Script(`var __signal = (function () { 'use strict';\n${code}\n;return signal; })();`, { filename: 'signal.js' })
    .runInContext(context, { timeout: 500 });
  if (vm.runInContext('typeof __signal', context) !== 'function') throw new Error('signal is not a function');
  const runner = new vm.Script(RUNNER).runInContext(context, { timeout: 500 }) as unknown;
  return {
    run(windows, timeoutMs = 5000) {
      const call = new vm.Script('__run(__input)');
      context.__run = runner; context.__input = JSON.stringify(windows);
      let text: unknown;
      try { text = call.runInContext(context, { timeout: timeoutMs }); }
      finally { delete context.__input; }
      if (typeof text !== 'string') throw new Error('Signal returned nothing readable');
      const raw = JSON.parse(text) as unknown[];
      return raw.map(v => {
        if (typeof v === 'string' && v.startsWith('error:')) throw new Error('Signal code failed: ' + v.slice(6));
        if (v === null || v === undefined) return null;
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        return Math.max(-1, Math.min(1, v));
      });
    },
  };
}

/** The window ending at index `i` (inclusive), as plain arrays. */
export function windowAt(bars: { o: number; h: number; l: number; c: number; v: number }[], i: number, size = WINDOW): BarArrays {
  const s = bars.slice(Math.max(0, i - size + 1), i + 1);
  return { o: s.map(b => b.o), h: s.map(b => b.h), l: s.map(b => b.l), c: s.map(b => b.c), v: s.map(b => b.v) };
}
