/**
 * A model-written signal, behind the same `Signal` interface as the built-ins.
 *
 * The code itself runs in the sandbox (`learning/sandbox.ts`): it receives plain price arrays
 * and returns one number. Compiling happens once per distinct code text and is shared.
 * A failing or silent reading is "no reading" (`null`), never a 0 that would drag the
 * composite toward neutral.
 */
import { compileSignal, windowAt, type CompiledSignal, type BarArrays } from '../learning/sandbox';
import { Signal, type SignalContext, type Reading, type NoReading, type SignalFamily } from './signal';

/** Learned signals carry this prefix so nobody mistakes one for a built-in. */
export const LEARNED_PREFIX = 'Learned: ';

const compiled = new Map<string, CompiledSignal | Error>();
function compiledFor(code: string): CompiledSignal {
  let c = compiled.get(code);
  if (!c) { try { c = compileSignal(code); } catch (err) { c = err instanceof Error ? err : new Error(String(err)); } compiled.set(code, c); }
  if (c instanceof Error) throw c;
  return c;
}

export class SandboxedSignal extends Signal {
  readonly name: string;
  readonly family: SignalFamily = 'trend';
  readonly minBars = 30;
  readonly origin = 'learned' as const;
  constructor(readonly id: string, readonly label: string, readonly code: string, readonly description: string, private readonly timeoutMs = 250) {
    super();
    this.name = LEARNED_PREFIX + label;
  }
  protected compute({ bars }: SignalContext): Reading | NoReading {
    const [v] = compiledFor(this.code).run([windowAt(bars as any, bars.length - 1)], this.timeoutMs);
    return v === null ? { score: null, detail: 'no reading' } : { score: v, detail: `model-written signal ${this.id}` };
  }
  /** Many windows in one sandbox call — what the learning layer uses over ten years of history. */
  runMany(windows: BarArrays[], timeoutMs = 20_000): (number | null)[] { return compiledFor(this.code).run(windows, timeoutMs); }
}
