/**
 * One learning pass by hand: measure every signal, update weights, test pending ideas.
 *
 *   npm run learn              measure and test
 *   npm run learn -- --propose also ask the model for new indicator ideas
 *
 * Writes to the account's DATA_DIR like the engine does. Exits when done.
 */
import { runLearning } from '../learning/loop';

(async () => {
  const r = await runLearning({ propose: process.argv.includes('--propose') });
  const f = (p: { meanIC: number | null; tStat: number | null }) => p.meanIC === null ? '—' : `${p.meanIC >= 0 ? '+' : ''}${p.meanIC.toFixed(3)} (t ${p.tStat?.toFixed(1)})`;
  console.log(`\n${r.stocks} stocks, ${r.firstDay} → ${r.lastDay}; last two years from ${r.examStart}\n`);
  console.log('signal'.padEnd(26) + 'weight  older years       last two years');
  for (const s of r.builtIns) console.log(s.name.padEnd(26) + r.weights[s.name].toFixed(2).padEnd(8) + f(s.periods.learn).padEnd(18) + f(s.periods.exam));
  for (const c of r.learned) console.log(`\n[${c.status}] ${c.name}: ${c.reason}`);
  if (r.changes.length) console.log('\nChanges:\n- ' + r.changes.join('\n- '));
  process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
