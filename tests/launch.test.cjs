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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-launch-'));
  const marker = path.join(dir, 'ui-stopped');
  const ready = path.join(dir, 'ui-ready');
  const env = { ...process.env, AUTOTRADE_TEST_MARKER: marker, AUTOTRADE_TEST_READY: ready };
  // The engine fails only once the interface has its SIGTERM handler in place
  // (it writes ui-ready right after), so a busy machine cannot kill the
  // interface before it can record that it was stopped.
  const engine = ['-e', `const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(process.env.AUTOTRADE_TEST_READY)){clearInterval(t);process.exit(7);}},10);`];
  const ui = ['-e', `const fs=require('fs');setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(process.env.AUTOTRADE_TEST_MARKER,'stopped');process.exit(0);});fs.writeFileSync(process.env.AUTOTRADE_TEST_READY,'ready');`];
  assert.equal(await runPair(engine, ui, true, env), 7);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'stopped');
});
