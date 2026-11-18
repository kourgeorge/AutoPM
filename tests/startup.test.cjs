const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const legacy = { paused: true, positionSnapshots: { AAPL: { symbol: 'AAPL', entryPrice: 100, stopLevel: 95 } } };
// Generous upper limit for one engine start. Under a loaded machine (several test
// suites at once) ts-node start-up alone can take well over the old 20 s.
const STARTUP_LIMIT_MS = 90000;

// Ask the OS for a free port, so two suites running at the same time never share one.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Waits for the child to exit. It is sent SIGTERM once it reports ready (graceful
// shutdown is part of what is checked). If it neither exits nor becomes ready within
// `limitMs`, it is killed and the promise fails with a clear message. The child is
// killed on every path out of this function, so a failing test never leaves it running.
async function runUntilExit(child, { limitMs = STARTUP_LIMIT_MS, output = () => '' } = {}) {
  const started = Date.now();
  let readyAfterMs = null, timedOut = false;
  child.on('message', message => {
    if (message && message.ready && readyAfterMs === null) {
      readyAfterMs = Date.now() - started;
      // Let the real loops settle, then exercise graceful shutdown too.
      setTimeout(() => child.kill('SIGTERM'), 100);
    }
  });
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limitMs);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });
    if (timedOut) throw new Error(`engine did not exit within ${limitMs} ms (ready: ${readyAfterMs !== null})\n${output()}`);
    return { code, signal, ready: readyAfterMs !== null, readyAfterMs, totalMs: Date.now() - started };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function launch({ state = legacy, env = {}, invalidPolicy = false, label = 'launch' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-startup-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'db'));
    const { accountId, ...rest } = state;
    fs.writeFileSync(path.join(dir, 'db', 'state.json'), JSON.stringify({ state: rest }));
    if (accountId) fs.writeFileSync(path.join(dir, 'db', 'settings.json'), JSON.stringify({ account: { id: accountId } }));
    if (invalidPolicy) {
      fs.mkdirSync(path.join(dir, 'policy'));
      fs.writeFileSync(path.join(dir, 'policy', 'policy.yaml'), 'version: 1\n');
    }
    const port = await freePort();
    const child = spawn(process.execPath, ['-r', 'ts-node/register', '-r', './tests/fixtures/startup-broker.cjs', 'src/daemon.ts'], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dir, HEADLESS: '0', TERM: 'xterm-256color',
        // Type checking is `npx tsc --noEmit`'s job; skipping it here keeps start-up fast under load.
        TS_NODE_TRANSPILE_ONLY: 'true',
        BROKER: 'alpaca', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
        AI_MODEL: 'test', AI_BASE_URL: '', AI_MAX_TOKENS: '4096',
        ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
        IBKR_PORT: '7497', ENGINE_PORT: String(port), ALERT_WEBHOOK_URL: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const { code, signal, ready, readyAfterMs, totalMs } = await runUntilExit(child, { output: () => stderr || stdout });
    console.log(`# startup timing [${label}]: ready ${ready ? `after ${readyAfterMs} ms` : 'never'}, exit after ${totalMs} ms`);
    assert.equal(signal, null, stderr || stdout);
    assert.equal(fs.existsSync(path.join(dir, '.engine-lock')), false, 'normal exit releases engine ownership');
    const probe = JSON.parse(fs.readFileSync(path.join(dir, 'probe.json'), 'utf8'));
    assert.equal(probe.mutations, 0, 'Startup tests must never trade');
    const read = name => { const file = path.join(dir, 'db', name); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; };
    const saved = read('state.json').state && { ...read('state.json').state, accountId: read('settings.json').account?.id ?? null };
    return { code, stderr, stdout, ready, readyAfterMs, saved, ...probe };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('saved positions bind to the connected account on first start and survive a restart', async () => {
  const result = await launch({ label: 'first start' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.ready, true);
  assert.equal(result.saved.accountId, 'alpaca:paper:startup-account');
  assert.deepEqual(result.saved.positionSnapshots, legacy.positionSnapshots);
  const restart = await launch({ state: result.saved, label: 'restart' });
  assert.equal(restart.code, 0, restart.stderr);
  assert.equal(restart.ready, true);
});

test('data saved for another account prevents startup', async () => {
  const result = await launch({ state: { ...legacy, accountId: 'alpaca:paper:another-account' }, label: 'other account' });
  assert.equal(result.code, 1);
  assert.equal(result.ready, false);
  assert.match(result.stderr, /data\/ belongs to alpaca:paper:another-account/);
});

test('configuration and policy errors before boot remain visible', async () => {
  const config = await launch({ env: { AI_MAX_TOKENS: '99999' }, label: 'bad config' });
  assert.equal(config.code, 1);
  assert.match(config.stderr, /AutoTrade startup failed: AI_MAX_TOKENS/);
  const policy = await launch({ invalidPolicy: true, label: 'bad policy' });
  assert.equal(policy.code, 1);
  assert.match(policy.stderr, /AutoTrade startup failed:/);
  assert.match(policy.stderr, /risk/);
  assert.equal(policy.accountReads, 0);
});

test('engine startup works without a terminal or login setup', async () => {
  const result = await launch({ state: { paused: true }, env: { HEADLESS: '1' }, label: 'headless' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.ready, true);
});

test('a child that never becomes ready is killed at the limit with a clear error', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await assert.rejects(runUntilExit(child, { limitMs: 300, output: () => 'no output' }), /did not exit within 300 ms \(ready: false\)/);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('a child that reports ready is stopped gracefully and its ready time is measured', async () => {
  const child = spawn(process.execPath, ['-e', "process.send({ ready: true }); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const result = await runUntilExit(child, { limitMs: STARTUP_LIMIT_MS });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.ready, true);
  assert.equal(typeof result.readyAfterMs, 'number');
});

test('every launch gets its own free port', async () => {
  const [a, b] = await Promise.all([freePort(), freePort()]);
  assert.ok(Number.isInteger(a) && a > 0 && a < 65536);
  assert.ok(Number.isInteger(b) && b > 0 && b < 65536);
});
