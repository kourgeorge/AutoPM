/**
 * The mean-reversion family's entry point. The signals are classes in
 * `signals/builtin/meanReversion.ts`; this keeps the function the engine has always called.
 *
 * Sign convention matches the rest of the codebase: positive = favourable for a long entry,
 * so a stock stretched below its recent history scores bullish here.
 */
import type { Bar } from '../core/types';
import type { Policy } from '../policy/types';
import type { SignalScore } from '../signals/signal';
import { scoreAll, signalsIn } from '../signals/registry';

export function computeMeanReversionSignals(bars: Bar[], policy: Policy): SignalScore[] {
  return scoreAll(signalsIn('meanReversion'), bars, policy);
}
