const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { stripVTControlCharacters } = require('node:util');
Object.assign(process.stdout, { columns: 100, rows: 28 });
const { ui } = require('../../src/ui/ui');
const { registerOperatorCommands } = require('../../src/core/operatorCommands');

async function run() {
  ui.onMessage(() => assert.fail('Slash commands must not reach the concierge'));
  registerOperatorCommands({ status: { paused: true } });
  const type = async bytes => { process.stdin.emit('data', Buffer.from(bytes)); await nextTurn(); };
  const capture = () => stripVTControlCharacters(ui.screen.screenshot(0, 100, 0, 28));
  await type('/');
  assert.match(capture(), /Commands 1\/17/);
  assert.match(capture(), /\/help/);
  fs.writeFileSync(process.env.DATA_DIR + '/terminal-menu.txt', capture());
  await type('sta');
  assert.match(capture(), /\/status — Account/);
  await type('\t');
  assert.equal(ui.input.value, '/status ');
  await type('\x15'); // Ctrl+U: discard; never run a broker/account command in this probe.
  await type('/he');
  await type('\r');
  assert.equal(ui.input.value, '/help ');
  await type('\r');
  assert.equal(ui.input.value, '');
  assert.match(capture(), /Commands \(anything not starting/);
  assert.match(capture(), /with \/ goes to the concierge/);
}

run().then(() => { ui.close(); process.exit(0); }, error => {
  ui.close(); console.error(error); process.exit(1);
});
