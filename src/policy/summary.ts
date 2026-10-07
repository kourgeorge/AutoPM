import type { Policy, AutomationLevel } from './types';
import { hasRiskProfile, riskProfileName } from './riskProfiles';

const clean = (value: number) => Number(value.toFixed(6));
const percent = (value: number | null, suffix = '') => value == null ? 'Not configured' : `${clean(value)}%${suffix}`;
const approval = (level: AutomationLevel) => level === 'auto' ? 'Automatic approval' : 'Human approval required';

/** A read-only, account-specific explanation. All displayed percentages use percentage points. */
export function summarizeStrategy(policy: Policy, strategyHash: string) {
  const { risk: r, strategy: s, automation: a, immutable: i } = policy;
  const name = riskProfileName(r);
  const profile = name[0].toUpperCase() + name.slice(1);
  const configured = hasRiskProfile(r);
  const risk = {
    riskPerTradePctOfEquity: r.riskPerTradePct,
    annualizedPortfolioVolatilityTargetPct: r.targetVolatilityPct,
    minimumPlannedRewardRisk: r.minRewardRisk,
  };
  const limits = {
    maximumPositions: r.maxPositions,
    maximumCapitalPerPositionPct: clean(r.positionSizePct * 100),
    grossExposurePct: clean(r.maxGrossExposurePct * 100),
    dailyLossEntryHaltPct: clean(r.maxDailyLossPct * 100),
    singleNamePct: r.maxSingleWeightPct,
    sectorPct: r.maxSectorWeightPct,
    concentrationEnforcement: configured ? 'Entry limits and alerts' : 'Alerts only; no risk profile configured',
  };
  const automation = {
    entries: approval(a.level.entry),
    exits: approval(a.level.exit),
    stopAdjustments: approval(a.level.stopAdjust),
    targetAdjustments: approval(a.level.targetAdjust),
    approvalTimeoutMinutes: clean(a.timeoutMs / 60000),
    unansweredApprovals: 'Expire without execution',
  };
  const riskLines = [
    `Risk per trade: ${percent(r.riskPerTradePct, ' of equity at the planned stop')}.`,
    `Portfolio volatility target: ${percent(r.targetVolatilityPct, ' per year (estimated)')}.`,
    `Minimum planned reward:risk: ${r.minRewardRisk == null ? 'Not configured' : `${clean(r.minRewardRisk)}:1`}.`,
  ];
  const summary = [
    `Saved strategy: ${profile} (revision ${policy.version}).`,
    ...riskLines,
    `Investment limits: ${limits.maximumPositions} positions; up to ${percent(limits.maximumCapitalPerPositionPct)} of equity invested per position and ${percent(limits.grossExposurePct)} total gross exposure.`,
    `Daily loss: at ${percent(limits.dailyLossEntryHaltPct)}, new entries halt for the rest of the trading day. This does not cap actual losses.`,
    `Concentration ${configured ? 'entry limits' : 'alerts only'}: ${percent(limits.singleNamePct)} in one name; ${percent(limits.sectorPct)} in one sector.`,
    `Approvals: entries — ${automation.entries.toLowerCase()}; exits — ${automation.exits.toLowerCase()}; stop adjustments — ${automation.stopAdjustments.toLowerCase()}; target adjustments — ${automation.targetAdjustments.toLowerCase()}.`,
    `Unanswered manual approvals expire after ${automation.approvalTimeoutMinutes} minutes.`,
    `Allowed symbols: ${s.watchlist.join(', ')}.`,
    'Risk per trade is planned loss, while position size is money invested. Stops can slip or gap; volatility is an estimate and reward:risk does not promise a return.',
    'To change these settings, save them in Strategy settings or ask in the account chat.',
  ].join('\n');

  return {
    source: 'Current saved account policy',
    version: policy.version,
    strategyHash,
    profile,
    riskControlsConfigured: configured,
    units: 'All percentage fields in this summary use percentage points: 0.5 means 0.5%, and 10 means 10%. Reward:risk is a ratio.',
    summary,
    risk,
    limits,
    automation,
    allowedSymbols: [...s.watchlist],
    entryRules: {
      stopDistanceGuideAtr: r.stopLossAtrMult,
      stopDistanceMeaning: 'ATR is average true range, a measure of recent price movement. This setting guides stop placement; it is not a fixed percentage loss or the enforced maximum stop distance.',
      maximumStopDistanceAtr: i.stopLossAtrMultCeiling,
      earningsBlackoutDays: r.earningsBlackoutDays,
      minimumSignalComposite: s.compositeMin,
      regimeOverrides: structuredClone(policy.regime),
      regimeMeaning: 'A cached market regime can raise the required signal strength and reduce quantity. These overrides do not increase a risk budget.',
    },
    monitoring: {
      pollIntervalSeconds: clean(policy.triggers.tickIntervalMs / 1000),
      portfolioDrawdownAlertPct: policy.triggers.portfolioDrawdownPct,
      drawdownMeaning: 'An alert from the equity peak; it is not an automatic liquidation threshold or a guaranteed maximum loss.',
    },
    platformCeilings: {
      maximumPositions: i.maxPositionsCeiling,
      maximumCapitalPerPositionPct: clean(i.positionSizePctCeiling * 100),
      maximumDailyLossEntryHaltPct: clean(i.maxDailyLossPctCeiling * 100),
      maximumGrossExposurePct: clean(i.maxGrossExposurePctCeiling * 100),
    },
    notes: [
      'These are saved settings, not a measurement of current holdings or confirmation that trading is running. Use get_state for pause status and get_exposure for current allocation.',
      'Not configured means that optional control is inactive, not zero risk. Each configured control still applies when the other controls are blank.',
      'Position sizing combines stop distance, capital and concentration limits, buying power and any configured volatility target. The trader uses get_entry_plan for a specific trade.',
      ...(r.targetVolatilityPct == null ? [] : ['Volatility targeting requires current daily history and Alpaca exchange-calendar access, including for IBKR accounts. Missing required data blocks new entries.']),
      'Saving a tighter profile affects future entries and invalidates older approvals. It does not automatically sell existing holdings.',
    ],
  };
}
