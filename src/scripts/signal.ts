/**
 * Grade signals on ten years of daily prices — the same test the learning layer runs.
 *
 *   npm run signal -- <id or name>   one signal, e.g.  npm run signal -- breakout
 *   npm run signal -- --all          every registered signal
 *   npm run signal -- --list         what is registered
 *
 * For each signal: the shared rules (signals/testkit.ts), then how well its score ranked ~56
 * large US stocks by their next five trading days, for the older years and the last two years.
 * Reads saved history when present; fetches it otherwise. Changes nothing.
 */
import { getPolicy } from '../policy/load';
import { BUILT_IN_SIGNALS, findSignal, learnedSignals } from '../signals/registry';
import { checkSignal } from '../signals/testkit';
import type { Signal } from '../signals/signal';
import { LEARNING_ETFS, LEARNING_UNIVERSE, loadUniverse, savedHistory } from '../learning/history';
import { buildUniverse, report, scoreSignals, requiredT } from '../learning/evaluate';

const fmt = (p: { meanIC: number | null; tStat: number | null; hitRate: number | null }) =>
  p.meanIC === null ? '—' : `IC ${p.meanIC >= 0 ? '+' : ''}${p.meanIC.toFixed(3)}  t ${(p.tStat ?? 0).toFixed(1).padStart(5)}  right ${Math.round((p.hitRate ?? 0) * 100)}%`;

(async () => {
  const args = process.argv.slice(2), policy = getPolicy();
  const all = [...BUILT_IN_SIGNALS, ...learnedSignals()];
  if (!args.length || args.includes('--list')) {
    for (const s of all) console.log(`${s.id.padEnd(22)} ${s.family.padEnd(14)} ${s.name} — ${s.description}`);
    if (!args.length) console.log('\nUsage: npm run signal -- <id> | --all');
    process.exit(0);
  }
  const picked: Signal[] = args.includes('--all') ? all : args.map(a => findSignal(a) ?? (() => { throw new Error(`No signal "${a}". Try --list.`); })());

  let rulesOk = true;
  for (const s of picked) {
    const { failures } = checkSignal(s, policy);
    if (failures.length) { rulesOk = false; console.log(`✗ ${s.name} breaks the signal rules:\n  - ` + failures.join('\n  - ')); }
  }
  if (!rulesOk) process.exit(1);
  console.log(`✓ ${picked.length} signal(s) pass the signal rules`);

  const symbols = [...LEARNING_UNIVERSE, ...policy.strategy.watchlist];
  const haveSaved = symbols.filter(s => savedHistory(s).length > 300).length >= 10;
  const bars = await loadUniverse(symbols, !haveSaved);
  const u = buildUniverse(bars);
  const sc = scoreSignals(u, picked, policy);
  // The ETFs alone: no survivor problem, so a signal that only works on today's big winners shows here.
  const etfBars = new Map([...bars].filter(([s]) => LEARNING_ETFS.includes(s)));
  const etfU = etfBars.size >= 10 ? buildUniverse(etfBars) : null;
  const etfSc = etfU ? scoreSignals(etfU, picked, policy) : null;
  console.log(`\n${u.symbols.length} stocks, ${u.dates[0]} → ${u.dates.at(-1)}. Next 5 trading days. t ≥ 2 is unlikely to be luck for ONE idea; trying many needs more (20 ideas: ${requiredT(20)}).\n`);
  console.log('signal'.padEnd(26) + 'older years'.padEnd(36) + 'last two years'.padEnd(36) + `ETFs only, last two years (${etfU ? etfU.symbols.length : 0} ETFs)`);
  picked.forEach((s, k) => {
    const r = report(u, sc, k, '9999-12-31');
    const e = etfU && etfSc ? fmt(report(etfU, etfSc, k, '9999-12-31').periods.exam) : 'not enough ETF history';
    console.log(s.name.padEnd(26) + fmt(r.periods.learn).padEnd(36) + fmt(r.periods.exam).padEnd(36) + e);
  });
  process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
