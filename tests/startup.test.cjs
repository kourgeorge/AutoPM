const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const legacy = { paused: true, positionSnapshots: { AAPL: { symbol: 'AAPL', entryPrice: 100, stopLevel: 95 } } };

async function launch({ state = legacy, env = {}, invalidPolicy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-startup-test-'));
  fs.mkdirSync(path.join(dir, 'db'));
  const { accountId, ...rest } = state;
  fs.writeFileSync(path.join(dir, 'db', 'state.json'), JSON.stringify({ state: rest }));
  if (accountId) fs.writeFileSync(path.join(dir, 'db', 'settings.json'), JSON.stringify({ account: { id: accountId } }));
  if (invalidPolicy) {
    fs.mkdirSync(path.join(dir, 'policy'));
    fs.writeFileSync(path.join(dir, 'policy', 'policy.yaml'), 'version: 1\n');
  }
  const child = spawn(process.execPath, ['-r', 'ts-node/register', '-r', './tests/fixtures/startup-broker.cjs', 'src/daemon.ts'], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dir, HEADLESS: '0', TERM: 'xterm-256color',
      BROKER: 'alpaca', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
      AI_MODEL: 'test', AI_BASE_URL: '', AI_MAX_TOKENS: '4096', AI_MAX_TOOL_ROUNDS: '10',
      ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
      IBKR_PORT: '7497', ENGINE_PORT: '18787', ALERT_WEBHOOK_URL: '', ...env },
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
  assert.equal(fs.existsSync(path.join(dir, '.engine-lock')), false, 'normal exit releases engine ownership');
  const probe = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8'));
  assert.equal(probe.mutations, 0, 'Startup tests must never trade');
  const read = name => { const file = path.join(dir, 'db', name); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; };
  const saved = read('state.json').state && { ...read('state.json').state, accountId: read('settings.json').account?.id ?? null };
  return { code, stderr, stdout, ready, saved, ...probe };
}

test('saved positions bind to the connected account on first start and survive a restart', async () => {
  const result = await launch();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.ready, true);
  assert.equal(result.saved.accountId, 'alpaca:paper:startup-account');
  assert.deepEqual(result.saved.positionSnapshots, legacy.positionSnapshots);
  const restart = await launch({ state: result.saved });
  assert.equal(restart.code, 0, restart.stderr);
  assert.equal(restart.ready, true);
});

test('data saved for another account prevents startup', async () => {
  const result = await launch({ state: { ...legacy, accountId: 'alpaca:paper:another-account' } });
  assert.equal(result.code, 1);
  assert.equal(result.ready, false);
  assert.match(result.stderr, /data\/ belongs to alpaca:paper:another-account/);
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

test('engine startup works without a terminal or login setup', async () => {
  const result = await launch({ state: { paused: true }, env: { HEADLESS: '1' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.ready, true);
});
