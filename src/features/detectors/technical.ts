/**
 * Indicator detectors — two exit-side, one entry-side.
 *
 * `ema_cross_down` is a LEVEL detector on the EMA spread rather than a call to
 * `crossedBelow`: the bus already owns edge detection, so re-deriving an edge inside a
 * detector would mean two mechanisms disagreeing about what a crossing is. A spread has no
 * magnitude of its own at the threshold (zero), so its band is scaled off the slow EMA.
 *
 * `entry_signal` is a composite (`crossed up AND rsi >= min`) with no single scalar to
 * compare, so it uses `boolCrossing`. It must not be a bare one-shot: `crossedAbove` stays
 * true for the whole life of the latest bar, so a cooldown-only version would re-fire all
 * day on daily bars.
 */

import { boolCrossing, type Detector, type DetectorHit } from '../eventBus';
import { getCachedRegime } from '../../macro/regime';
import { bandOf, pctText } from './util';

export const emaCrossDownDetector: Detector = {
  kind: 'ema_cross_down',
  evaluate(data, policy) {
    const hits: DetectorHit[] = [];

    for (const f of Object.values(data.positions)) {
      if (f.emaFast === null || f.emaSlow === null) continue;
      const spread = f.emaFast - f.emaSlow;

      hits.push({
        symbol: f.symbol,
        cooldownKey: `ema_cross_down:${f.symbol}`,
        severity: 'urgent',
        headline: `${f.symbol} momentum lost — EMA${policy.strategy.emaFast} ${f.emaFast.toFixed(2)} below EMA${policy.strategy.emaSlow} ${f.emaSlow.toFixed(2)} (${pctText(f.pnlPct)})`,
        evidence: {
          emaFast: f.emaFast,
          emaSlow: f.emaSlow,
          spread,
          pnlPct: f.pnlPct ?? 'n/a',
          heldForMs: f.heldForMs,
        },
        suggestedAction: 'review',
        crossing: {
          level: spread,
          threshold: 0,
          direction: 'below',
          band: bandOf(f.emaSlow, policy),
        },
      });
    }

    return hits;
  },
};

export const rsiExitZoneDetector: Detector = {
  kind: 'rsi_exit_zone',
  evaluate(data, policy) {
    const hits: DetectorHit[] = [];

    for (const f of Object.values(data.positions)) {
      if (f.rsi === null) continue;

      hits.push({
        symbol: f.symbol,
        cooldownKey: `rsi_exit_zone:${f.symbol}`,
        severity: 'urgent',
        headline: `${f.symbol} RSI ${f.rsi.toFixed(1)} entered the exit zone (below ${policy.strategy.rsiExitMax}) — ${pctText(f.pnlPct)}`,
        evidence: {
          rsi: f.rsi,
          rsiExitMax: policy.strategy.rsiExitMax,
          pnlPct: f.pnlPct ?? 'n/a',
          heldForMs: f.heldForMs,
        },
        suggestedAction: 'review',
        crossing: {
          level: f.rsi,
          threshold: policy.strategy.rsiExitMax,
          direction: 'below',
          band: bandOf(policy.strategy.rsiExitMax, policy),
        },
      });
    }

    return hits;
  },
};

export const entrySignalDetector: Detector = {
  kind: 'entry_signal',
  evaluate(data, policy) {
    const hits: DetectorHit[] = [];

    // Regime-conditioned RSI minimum (Ang et al. 2026: regime as first-class pipeline stage).
    // Falls back to policy.strategy.rsiEntryMin if regime not yet fetched.
    const regime = getCachedRegime();
    const effectiveRsiMin = regime
      ? policy.regime[regime.regime].rsiEntryMin
      : policy.strategy.rsiEntryMin;

    for (const f of Object.values(data.watchlist)) {
      // No entry off a stale price, and none at all until the series is long enough to say
      // whether a cross happened.
      if (f.price === null || f.stale || f.emaCrossedUp === null || f.rsi === null) continue;

      const armed = f.emaCrossedUp && f.rsi >= effectiveRsiMin;

      // Multi-signal summary for the headline (paper: "LLM-as-judge" pattern)
      const signalNote = f.signals.length > 0 ? ` (${f.signalSummary})` : '';

      hits.push({
        symbol: f.symbol,
        cooldownKey: `entry_signal:${f.symbol}`,
        severity: 'urgent',
        headline: `${f.symbol} entry signal — EMA${policy.strategy.emaFast} crossed above EMA${policy.strategy.emaSlow}, RSI ${f.rsi.toFixed(1)} at ${f.price.toFixed(2)}${signalNote}`,
        evidence: {
          price: f.price,
          emaFast: f.emaFast ?? 'n/a',
          emaSlow: f.emaSlow ?? 'n/a',
          rsi: f.rsi,
          rsiEntryMin: effectiveRsiMin,
          regime: regime?.regime ?? 'unknown',
          atr: f.atr ?? 'n/a',
          // Multi-signal evidence for the trader LLM to judge (Ang et al. 2026 pattern)
          signals: f.signals as any,
          signalSummary: f.signalSummary,
        },
        // Research, not entry: position limits and daily-loss halts are L4's to enforce,
        // and this detector deliberately knows nothing about them.
        suggestedAction: 'research',
        crossing: boolCrossing(armed),
      });
    }

    return hits;
  },
};
