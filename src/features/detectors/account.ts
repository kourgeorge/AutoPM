/**
 * Account-level risk: the daily loss halt.
 *
 * `riskManager.isDailyLossBreached` computes the same predicate today but takes an
 * `AccountInfo` and reads `config.risk`, and nothing runs it on a clock — so the halt only
 * happens if the LLM happens to ask. This detector puts the same arithmetic on the tick
 * loop, reading the threshold from policy so there is one source for it.
 *
 * UNIT TRAP: `policy.risk.maxDailyLossPct` is a FRACTION (0.03) while
 * `AccountData.dayPnLPct` is PERCENTAGE POINTS (-3.0). Hence the `* 100`.
 */

import type { Detector, DetectorHit } from '../eventBus';
import { pctText } from './util';

export const dailyLossDetector: Detector = {
  kind: 'daily_loss_breach',
  evaluate(data, policy) {
    const a = data.account;
    if (a.dayPnLPct === null) return [];

    const threshold = -policy.risk.maxDailyLossPct * 100;

    const hit: DetectorHit = {
      symbol: null,
      cooldownKey: 'daily_loss_breach',
      severity: 'critical',
      headline: `Daily loss ${pctText(a.dayPnLPct)} against the ${Math.abs(threshold).toFixed(2)}% limit — entries must halt for the day`,
      evidence: {
        dayPnLPct: a.dayPnLPct,
        threshold,
        startOfDayEquity: a.startOfDayEquity,
        equity: a.equity ?? 'n/a',
        positionCount: a.positionCount,
      },
      suggestedAction: 'review',
      crossing: {
        level: a.dayPnLPct,
        threshold,
        direction: 'below',
        band: policy.triggers.hysteresisPct,
      },
    };

    return [hit];
  },
};
