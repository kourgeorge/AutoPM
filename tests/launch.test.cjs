const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('ts-node/register');
const { runPair } = require('../src/launch');

test('closing the paired interface gracefully stops its engine', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-launch-')), 'engine-stopped');
  const env = { ...process.env, AUTOTRADE_TEST_MARKER: marker };
  const engine = ['-e', `const fs=require('fs');setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(process.env.AUTOTRADE_TEST_MARKER,'stopped');process.exit(0);});`];
  const ui = ['-e', 'setTimeout(()=>process.exit(0),300)'];
  assert.equal(await runPair(engine, ui, true, env), 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'stopped');
});

test('an engine failure closes the paired interface and preserves the failure status', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-launch-')), 'ui-stopped');
  const env = { ...process.env, AUTOTRADE_TEST_MARKER: marker };
  const engine = ['-e', 'setTimeout(()=>process.exit(7),300)'];
  const ui = ['-e', `const fs=require('fs');setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(process.env.AUTOTRADE_TEST_MARKER,'stopped');process.exit(0);});`];
  assert.equal(await runPair(engine, ui, true, env), 7);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'stopped');
});
