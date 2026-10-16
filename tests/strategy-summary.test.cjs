const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node/register');
const { load } = require('js-yaml');
const { summarizeStrategy } = require('../src/policy/summary');
const { RISK_PROFILES } = require('../src/policy/riskProfiles');
const base = load(fs.readFileSync(path.join(__dirname, '../policy/default.yaml'), 'utf8'));

test('strategy summary distinguishes planned loss, invested capital, volatility and reward:risk with correct units', () => {
  const summary = summarizeStrategy(base, 'saved-hash');
  assert.equal(summary.profile, 'Balanced');
  assert.equal(summary.strategyHash, 'saved-hash');
  assert.equal(summary.risk.riskPerTradePctOfEquity, 0.5);
  assert.equal(summary.risk.annualizedPortfolioVolatilityTargetPct, 12);
  assert.equal(summary.risk.minimumPlannedRewardRisk, 2);
  assert.equal(summary.limits.maximumCapitalPerPositionPct, 10);
  assert.equal(summary.limits.dailyLossEntryHaltPct, 2);
  assert.equal(summary.limits.grossExposurePct, 80);
  assert.match(summary.summary, /0.5% of equity at the planned stop/);
  assert.match(summary.summary, /12% per year \(estimated\)/);
  assert.match(summary.summary, /reward:risk: 2:1/);
  assert.match(summary.summary, /10% of equity invested per position/);
  assert.match(summary.summary, /new entries halt/);
  assert.match(summary.summary, /does not cap actual losses/);
  assert.equal(summary.automation.entries, 'Human approval required');
  assert.equal(summary.automation.stopAdjustments, 'Automatic approval');
  assert.equal(summary.automation.approvalTimeoutMinutes, 10);
  assert.match(summary.summary, /expire after 10 minutes/);
});

test('profiles are derived from actual saved values; explanations update after customization', () => {
  for (const [name, preset] of Object.entries(RISK_PROFILES)) {
    const policy = { ...base, risk: { ...base.risk, ...preset } };
    assert.equal(summarizeStrategy(policy, '').profile.toLowerCase(), name);
  }
  const policy = structuredClone(base);
  Object.assign(policy.risk, { riskPerTradePct: 0.37, maxDailyLossPct: 0.015, maxGrossExposurePct: 0.65 });
  policy.automation.level.entry = 'auto';
  policy.automation.level.stopAdjust = 'manual';
  policy.automation.timeoutMs = 90000;
  const summary = summarizeStrategy(policy, 'custom-revision');
  assert.equal(summary.profile, 'Custom');
  assert.match(summary.summary, /0.37% of equity/);
  assert.match(summary.summary, /Daily loss: at 1.5%/);
  assert.match(summary.summary, /65% total gross exposure/);
  assert.equal(summary.automation.entries, 'Automatic approval');
  assert.equal(summary.automation.stopAdjustments, 'Human approval required');
  assert.equal(summary.automation.approvalTimeoutMinutes, 1.5);
});

test('legacy and partially configured profiles report missing controls without claiming zero risk', () => {
  const policy = structuredClone(base);
  Object.assign(policy.risk, { riskPerTradePct: null, targetVolatilityPct: null, minRewardRisk: null });
  const legacy = summarizeStrategy(policy, 'legacy');
  assert.equal(legacy.profile, 'Custom');
  assert.equal(legacy.riskControlsConfigured, false);
  assert.equal(legacy.summary.match(/Not configured/g).length, 3);
  assert.equal(legacy.risk.riskPerTradePctOfEquity, null);
  assert.match(legacy.summary, /Concentration alerts only/);
  assert.doesNotMatch(legacy.summary, /0% of equity at the planned stop/);
  policy.risk.minRewardRisk = 3;
  const partial = summarizeStrategy(policy, 'partial');
  assert.equal(partial.riskControlsConfigured, true);
  assert.match(partial.summary, /Concentration entry limits/);
  assert.match(partial.summary, /reward:risk: 3:1/);
  assert.equal(partial.summary.match(/Not configured/g).length, 2);
});

test('stop guidance and drawdown alarms do not masquerade as hard loss guarantees', () => {
  const summary = summarizeStrategy(base, 'saved');
  assert.equal(summary.entryRules.stopDistanceGuideAtr, 2);
  assert.equal(summary.entryRules.maximumStopDistanceAtr, 4);
  assert.match(summary.entryRules.stopDistanceMeaning, /not a fixed percentage loss/);
  assert.equal(summary.monitoring.portfolioDrawdownAlertPct, 6);
  assert.match(summary.monitoring.drawdownMeaning, /not an automatic liquidation/);
  assert.ok(summary.notes.some(note => /not a measurement of current holdings/.test(note)));
  assert.ok(summary.notes.some(note => /does not automatically sell/.test(note)));
});

test('the full summary fits the tool budget even with 100 allowed symbols', () => {
  const policy = structuredClone(base);
  policy.strategy.watchlist = Array.from({ length: 100 }, (_, i) => 'SYMBOL' + String(i).padStart(4, 'A'));
  const summary = summarizeStrategy(policy, 'h'.repeat(64));
  assert.ok(JSON.stringify(summary).length < 10000, 'do not truncate the only settings response');
  summary.allowedSymbols.push('EXTRA');
  summary.entryRules.regimeOverrides.recession.sizeMult = 999;
  assert.equal(policy.strategy.watchlist.length, 100);
  assert.notEqual(policy.regime.recession.sizeMult, 999);
});

test('the playbook is prose only; numbers reach the prompt as structured data with units', () => {
  const { assertProsePlaybook, policyFields, renderPolicyBlock } = require('../src/policy/render');
  const playbook = fs.readFileSync(path.join(__dirname, '../policy/PLAYBOOK.md'), 'utf8');
  assert.doesNotMatch(playbook, /\{\{/);
  assert.doesNotThrow(() => assertProsePlaybook(playbook, base));
  assert.throws(() => assertProsePlaybook('Max {{risk.maxPositions}} positions', base), /prose only/);
  assert.throws(() => assertProsePlaybook('No more than `risk.maxPostions` positions', base), /not a setting/);
  assert.doesNotThrow(() => assertProsePlaybook('Size from `regime.late_cycle`, cap `risk.positionSizePct`', base));
  const fields = policyFields(base);
  assert.deepEqual(fields['risk.positionSizePct'], { value: base.risk.positionSizePct, unit: 'fraction of equity (0.1 = 10%), capital cap per position' });
  assert.match(fields['risk.maxSingleWeightPct'].unit, /^percentage points/);
  assert.equal(fields['triggers.tickIntervalMs'].unit, 'milliseconds');
  assert.match(fields['regime.recession.sizeMult'].unit, /multiplier/);
  assert.deepEqual(fields['strategy.watchlist'], base.strategy.watchlist);
  const block = JSON.parse(renderPolicyBlock(base).replace(/^.*\n/, ''));
  assert.equal(block.profile, 'balanced');
  assert.equal(block.fields['risk.maxPositions'], base.risk.maxPositions);
});

test('investment target and floor load as percentage points, validate against each other, and keep profile names', () => {
  const loader = require('../src/policy/load'), yaml = require('js-yaml'), { riskProfileName } = require('../src/policy/riskProfiles');
  const withRisk = risk => loader.parsePolicy(yaml.dump({ ...base, risk: { ...base.risk, ...risk } }));
  const ok = withRisk({});
  assert.equal(ok.ok, true); assert.equal(ok.policy.risk.targetInvestedPct, 60); assert.equal(ok.policy.risk.minInvestedPct, 40);
  assert.equal(riskProfileName(ok.policy.risk), 'balanced');
  assert.match(withRisk({ minInvestedPct: 70 }).errors.join(), /minInvestedPct must not exceed/);
  assert.match(withRisk({ targetInvestedPct: 90 }).errors.join(), /gross exposure limit/);
  const legacy = withRisk({ targetInvestedPct: null, minInvestedPct: null });
  assert.equal(legacy.ok, true); assert.equal(legacy.policy.risk.targetInvestedPct, null);
  assert.equal(riskProfileName({ ...ok.policy.risk, ...RISK_PROFILES.aggressive }), 'aggressive');
  assert.match(summarizeStrategy(ok.policy, 'h').summary, /Investment target: 60% of equity invested; floor: 40%/);
});
