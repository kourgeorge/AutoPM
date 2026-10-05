const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const legacy = { paused: true, positionSnapshots: { AAPL: { symbol: 'AAPL', entryPrice: 100, stopLevel: 95 } } };

async function launch({ state = legacy, env = {}, invalidPolicy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-startup-test-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  if (invalidPolicy) {
    fs.mkdirSync(path.join(dir, 'policy'));
    fs.writeFileSync(path.join(dir, 'policy', 'policy.yaml'), 'version: 1\n');
  }
  const child = spawn(process.execPath, ['-r', 'ts-node/register', '-r', './tests/fixtures/startup-broker.cjs', 'src/daemon.ts'], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dir, HEADLESS: '0', TERM: 'xterm-256color',
      BROKER: 'alpaca', ACCOUNT_ID: '', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
      AI_MODEL: 'test', AI_BASE_URL: '', AI_MAX_TOKENS: '4096', AI_MAX_TOOL_ROUNDS: '10',
      ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
      IBKR_PORT: '7497', API_TOKEN: '', API_VIEWER_TOKEN: '', API_PORT: '8787',
      API_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', ALERT_WEBHOOK_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '', stderr = '', ready = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('message', message => {
    if (message.ready) {
      ready = true;
      // Let the real loops settle, then exercise graceful shutdown too.
      setTimeout(() => child.kill('SIGTERM'), 100);
    }
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
  let code, signal;
  try {
    [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });
  } finally { clearTimeout(deadline); }
  assert.equal(signal, null, stderr || stdout);
  const probe = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8'));
  assert.equal(probe.mutations, 0, 'Startup tests must never trade');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), state, 'Legacy source must stay intact');
  let saved;
  const dbPath = path.join(dir, 'autotrade.sqlite');
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key='state'").get();
    saved = row && JSON.parse(row.value);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='workerLease'").get()?.value ?? 'null'), null);
    db.close();
  }
  return { code, stderr, stdout, ready, saved, ...probe };
}

test('legacy startup leaves actionable account confirmation visible after closing the terminal', async () => {
  const result = await launch();
  assert.equal(result.code, 1);
  assert.equal(result.ready, false);
  assert.equal(result.accountReads, 1);
  assert.match(result.stderr, /AutoTrade startup failed: Legacy data has no account identity/);
  assert.match(result.stderr, /ACCOUNT_ID=startup-account/);
  assert.match(result.stderr, /No trading has started/);
  assert.equal(result.saved?.accountId ?? null, null);
});

test('confirmed legacy data boots, preserves saved protection, and restarts without reconfirmation', async () => {
  const result = await launch({ env: { ACCOUNT_ID: 'startup-account' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.ready, true);
  assert.equal(result.saved.accountId, 'alpaca:paper:startup-account');
  assert.deepEqual(result.saved.positionSnapshots, legacy.positionSnapshots);
  const restart = await launch({ state: result.saved });
  assert.equal(restart.code, 0, restart.stderr);
  assert.equal(restart.ready, true);
});

test('a fresh directory starts without legacy account confirmation', async () => {
  const result = await launch({ state: { paused: true } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.ready, true);
  assert.equal(result.saved.accountId, 'alpaca:paper:startup-account');
});

test('a mismatched configured account still prevents startup', async () => {
  const result = await launch({ env: { ACCOUNT_ID: 'another-account' } });
  assert.equal(result.code, 1);
  assert.equal(result.ready, false);
  assert.match(result.stderr, /ACCOUNT_ID does not match/);
});

test('binding to another account still prevents reuse of its data', async () => {
  const result = await launch({ state: { ...legacy, accountId: 'alpaca:paper:another-account' } });
  assert.equal(result.code, 1);
  assert.equal(result.ready, false);
  assert.match(result.stderr, /DATA_DIR belongs to another broker account or venue/);
});

test('configuration and policy errors before boot remain visible', async () => {
  const config = await launch({ env: { AI_MAX_TOOL_ROUNDS: '999' } });
  assert.equal(config.code, 1);
  assert.match(config.stderr, /AutoTrade startup failed: AI_MAX_TOOL_ROUNDS/);
  const policy = await launch({ invalidPolicy: true });
  assert.equal(policy.code, 1);
  assert.match(policy.stderr, /AutoTrade startup failed:/);
  assert.match(policy.stderr, /risk/);
  assert.equal(policy.accountReads, 0);
});

test('headless startup without access credentials reports the setup requirement', async () => {
  const result = await launch({ env: { HEADLESS: '1' } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Headless startup requires a provisioned user or valid API_TOKEN/);
  assert.equal(result.accountReads, 0);
});
