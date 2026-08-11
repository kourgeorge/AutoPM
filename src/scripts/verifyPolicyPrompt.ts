/**
 * Policy render smoke test.
 *
 * Until step 2 this script proved `renderPolicy()` reproduced the hardcoded
 * `buildSystemPrompt()` byte for byte. That prompt is now deleted — POLICY.md IS the
 * system prompt — so byte-equality has nothing left to compare against. What byte-
 * equality was really buying was a guarantee that the rendered text is a valid prompt,
 * and that is what is checked here instead:
 *
 *  1. the render does not throw (unknown key, unknown filter, unfiltered mapping);
 *  2. no literal `{{` survives — a placeholder leaking into the system prompt is the
 *     loudest possible failure and byte-equality was the only thing catching it;
 *  3. the sections that carry risk rules are present;
 *  4. no reference to a tool that no longer exists.
 *
 * There is deliberately no checked-in golden file: it would make every intentional
 * prose edit a two-file edit and be deleted out of annoyance within a week, taking
 * the `{{` check with it.
 *
 *   npm run verify:policy
 */

import { loadPolicy } from '../policy/load';
import { renderPolicy } from '../policy/render';

/** Prose the prompt must contain. Each entry is a rule whose absence changes behaviour. */
const REQUIRED = [
  'ROLE',
  'MACHINE EVENTS',
  'CYCLE FRAMEWORK',
  'RISK RULES',
  'SLEEP CADENCE',
  'CORE WATCHLIST',
  'sleep()',
  'execute_entry',
  'execute_exit',
  'ack_event',
  'get_journal',
];

/**
 * Tool names the trader cannot call. A reference here costs a wasted round and an
 * `{error: 'Unknown tool'}` every cycle, which nothing else catches — the prompt is prose.
 *
 * Grow this list as tools are deleted, at the moment they are deleted.
 */
const FORBIDDEN = [
  // Belonged to the deleted sub-agents' toolset, never the trader's.
  'get_bars',
  'get_indicators',
  'get_earnings_calendar',
  'get_macro_indicators',
  'get_sec_filing_summary',
  // The sub-agents themselves.
  'run_monitor_agent',
  'run_research_agent',
  'run_idea_agent',
  // The prose knowledge store, replaced by the journal.
  'get_knowledge',
  'add_note',
];

function main(): void {
  const policy = loadPolicy();

  let prompt: string;
  try {
    prompt = renderPolicy(policy);
  } catch (err: any) {
    console.error(`FAIL — renderPolicy() threw: ${err.message}`);
    process.exit(1);
  }

  const failures: string[] = [];

  if (prompt.includes('{{')) {
    const leaked = prompt.match(/\{\{[^}]*\}?\}?/g) ?? [];
    failures.push(`unrendered placeholder(s) in the prompt: ${leaked.join(', ')}`);
  }

  for (const needle of REQUIRED) {
    if (!prompt.includes(needle)) failures.push(`missing required text: ${JSON.stringify(needle)}`);
  }

  for (const needle of FORBIDDEN) {
    if (prompt.includes(needle)) failures.push(`references deleted tool: ${JSON.stringify(needle)}`);
  }

  const lines = prompt.split('\n').length;

  if (failures.length > 0) {
    console.error(`FAIL — policy v${policy.version} (${lines} lines, ${prompt.length} bytes)`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log(`PASS — policy v${policy.version} renders cleanly (${lines} lines, ${prompt.length} bytes).`);
}

main();
