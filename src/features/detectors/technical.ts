/**
 * Indicator detectors — two exit-side, one entry-side.
 *
 * `ema_cross_down` is a LEVEL detector on the EMA spread rather than a call to
 * `crossedBelow`: the bus already owns edge detection, so re-deriving an edge inside a
 * detector would mean two mechanisms disagreeing about what a crossing is. A spread has no
 * magnitude of its own at the threshold (zero), so its band is scaled off the slow EMA.
 *
 * `entry_signal` arms on three conditions at once (`crossed up AND rsi >= min AND composite >=
 * min`) with no single scalar to compare, so it uses `boolCrossing`. It must not be a bare
 * one-shot: `crossedAbove` stays true for the whole life of the latest bar, so a cooldown-only
 * version would re-fire all day on daily bars.
 *
 * The composite belongs in that condition and not merely in the headline. It is the threshold
 * `enterPosition` refuses on (`low_composite`) and the one PLAYBOOK.md renders into the prompt, and
 * while it was carried as text only, this detector woke the trader for crosses the next layer was
 * going to decline. Waking a cycle costs a model call and a cooldown slot; spending both to be
 * told no is the one outcome worth designing out.
 */

import { boolCrossing, type Detector, type DetectorHit } from '../eventBus';
import { getCachedRegime } from '../../macro/regime';
import { signalTally } from '../../strategy/signals';
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

    // Regime-conditioned thresholds (Ang et al. 2026: regime as first-class pipeline stage).
    // Falls back to the strategy block if the regime has not been fetched yet.
    //
    // Resolved from the CACHE, exactly as `enterPosition`'s gate resolves it, and that agreement
    // is the point: if attention read a live regime and permission read a cached one, the two
    // could hold different thresholds for the same instant and be back to disagreeing.
    const regime = getCachedRegime();
    const effectiveRsiMin = regime
      ? policy.regime[regime.regime].rsiEntryMin
      : policy.strategy.rsiEntryMin;
    const effectiveCompositeMin = regime
      ? policy.regime[regime.regime].compositeMin
      : policy.strategy.compositeMin;

    for (const f of Object.values(data.watchlist)) {
      // No entry off a stale price, and none at all until the series is long enough to say
      // whether a cross happened.
      if (f.price === null || f.stale || f.emaCrossedUp === null || f.rsi === null) continue;

      // Null when nothing was scored, and null does NOT arm. Same reading as the guard's
      // `signals_unavailable`: an unscoreable name is not a weak setup, but it is not a wake
      // either — there is nothing for the model to judge and nothing that would pass at L4.
      const composite = signalTally(f.signals).composite;

      const armed = f.emaCrossedUp
        && f.rsi >= effectiveRsiMin
        && composite !== null
        && composite >= effectiveCompositeMin;

      // Multi-signal summary for the headline (paper: "LLM-as-judge" pattern). `signalSummary`
      // leads with the composite, so the headline carries the magnitude of the five scores and
      // not just how many cleared the dead band.
      const signalNote = f.signals.length > 0 ? ` (${f.signalSummary})` : '';

      // The one part of the reversal filter that belongs in a headline: a cross into a name
      // that has already run is the case where the five correlated trend signals are most
      // likely to be agreeing about something that is nearly over.
      const chaseNote = f.reversal.chasing
        ? ` — already ${f.reversal.oneMonthReturnPct! >= 0 ? '+' : ''}${f.reversal.oneMonthReturnPct!.toFixed(1)}% in 21 bars, don't chase`
        : '';

      hits.push({
        symbol: f.symbol,
        cooldownKey: `entry_signal:${f.symbol}`,
        severity: 'urgent',
        headline: `${f.symbol} entry signal — EMA${policy.strategy.emaFast} crossed above EMA${policy.strategy.emaSlow}, RSI ${f.rsi.toFixed(1)} at ${f.price.toFixed(2)}${signalNote}${chaseNote}`,
        evidence: {
          price: f.price,
          emaFast: f.emaFast ?? 'n/a',
          emaSlow: f.emaSlow ?? 'n/a',
          rsi: f.rsi,
          rsiEntryMin: effectiveRsiMin,
          // Both sides of the gate that fired, so a reader of the journal can see what the
          // threshold was at the time without having to reconstruct the policy version.
          composite: composite ?? 'n/a',
          compositeMin: effectiveCompositeMin,
          regime: regime?.regime ?? 'unknown',
          atr: f.atr ?? 'n/a',
          // Multi-signal evidence for the trader LLM to judge (Ang et al. 2026 pattern)
          signals: f.signals as any,
          signalSummary: f.signalSummary,
          // Carried whole, and deliberately not folded into `signalSummary`: it is the one
          // reading here that can contradict the five, and a filter averaged into what it is
          // meant to filter stops being a filter.
          reversal: f.reversal as any,
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
