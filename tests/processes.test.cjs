const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const baseEnv = { ...process.env, BROKER: 'alpaca', HEADLESS: '1', AI_PROVIDER: 'ollama', AI_API_KEY: 'test',
  AI_BASE_URL: '', ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets', ALERT_WEBHOOK_URL: '' };

function child(name, env) {
  const process = fork(path.join(__dirname, 'fixtures', name + '-service.cjs'), [], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; process.stderr.on('data', chunk => { errors += chunk; }); process.stdout.resume();
  process.messages = []; process.on('message', message => process.messages.push(message));
  process.errors = () => errors;
  return process;
}
async function until(check, message) {
  for (let i = 0; i < 160; i++) { const value = await check(); if (value) return value; await delay(100); }
  assert.fail(message);
}
const ready = process => until(() => {
  assert.equal(process.exitCode, null, process.errors()); return process.messages.find(message => message.ready);
}, 'child did not become ready');
async function stop(process, value = 'stop') {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.send(value);
  await until(() => process.exitCode !== null || process.signalCode !== null, 'child did not exit');
  assert.equal(process.exitCode, 0, process.errors());
}

test('independent engine, web, and TUI share commands while clients never open storage', { timeout: 65000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-processes-'));
  const data = path.join(directory, 'engine');
  const engine = child('engine', { ...baseEnv, DATA_DIR: data });
  const children = [engine];
  t.after(() => { for (const process of children) if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  const e = await ready(engine), engineUrl = `http://127.0.0.1:${e.port}`;
  const clientEnv = { ...baseEnv, ENGINE_URL: engineUrl, AI_API_KEY: '', AI_PROVIDER: 'no-client-credentials', DATA_DIR: path.join(directory, 'must-not-exist'), TERM: 'xterm-256color' };
  const web = child('web', clientEnv), terminal = child('terminal', clientEnv); children.push(web, terminal);
  const w = await ready(web), webUrl = `http://127.0.0.1:${w.port}`;
  await until(() => terminal.messages.some(message => message.env?.broker === 'alpaca'), 'TUI did not connect');
  assert.deepEqual(terminal.messages.at(-1).forbidden, [], 'TUI imports no broker, storage, policy config, or execution modules');
  assert.equal(fs.existsSync(clientEnv.DATA_DIR), false, 'clients do not create account data');
  assert.equal((await fetch(engineUrl + '/')).status, 404, 'engine serves API only');
  assert.equal((await fetch(webUrl)).status, 200);
  assert.equal((await (await fetch(webUrl + '/api/status')).json()).account.equity, 10000);
  assert.equal((await fetch(webUrl + '/api/commands/pause', { method: 'POST', headers: { origin: 'https://foreign.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await (await fetch(engineUrl + '/api/status')).json()).health.paused, false);
  terminal.send({ type: 'input', value: '/pause ' });
  await until(async () => (await (await fetch(webUrl + '/api/status')).json()).health.paused, 'TUI pause did not reach web');
  assert.equal((await fetch(webUrl + '/api/commands/resume', { method: 'POST', headers: { origin: webUrl, 'content-type': 'application/json' }, body: '{}' })).status, 200);
  await until(() => terminal.messages.at(-1)?.lane?.state === 'sleeping', 'web resume did not reach TUI');
  terminal.send({ type: 'input', value: `approve ${e.actionId}` });
  await until(async () => (await (await fetch(webUrl + '/api/actions?status=all')).json()).actions.some(action => action.id === e.actionId && action.status === 'approved'), 'TUI approval did not reach engine');

  // A second engine must fail before opening storage, even with a different port.
  const duplicate = spawnSync(process.execPath, ['-r', 'ts-node/register', 'src/daemon.ts'], {
    cwd: root, env: { ...baseEnv, DATA_DIR: data, ENGINE_PORT: '19878' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /Account storage is locked/);
  assert.equal((await fetch(engineUrl + '/api/status')).status, 200);

  await stop(web); // UI shutdown does not stop trading services.
  assert.equal((await fetch(engineUrl + '/api/status')).status, 200);
  const web2 = child('web', clientEnv); children.push(web2); const w2 = await ready(web2);
  const webUrl2 = `http://127.0.0.1:${w2.port}`;
  await stop(engine);
  assert.equal(fs.existsSync(path.join(data, '.engine-lock')), false);
  await until(() => terminal.messages.at(-1)?.lane?.state === 'error', 'TUI does not show disconnected engine');
  assert.equal((await fetch(webUrl2)).status, 200, 'web remains available without engine');
  assert.equal((await fetch(webUrl2 + '/api/status')).status, 502);
  const restarted = child('engine', { ...baseEnv, DATA_DIR: data, TEST_ENGINE_PORT: String(e.port) }); children.push(restarted); await ready(restarted);
  await until(() => terminal.messages.at(-1)?.lane?.state === 'sleeping', 'TUI did not reconnect');
  assert.equal((await fetch(webUrl2 + '/api/status')).status, 200);
  await stop(terminal, { type: 'stop' });
  assert.equal((await fetch(engineUrl + '/api/status')).status, 200, 'TUI shutdown leaves engine running');
  assert.equal(fs.existsSync(clientEnv.DATA_DIR), false);
  await stop(web2); await stop(restarted);
});

test('engine lock is exclusive, releases normally, and retains crashed-owner evidence', () => {
  require('ts-node/register');
  const { acquireEngineLock } = require('../src/core/engineLock');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-lock-'));
  const release = acquireEngineLock(directory);
  assert.throws(() => acquireEngineLock(directory), /Account storage is locked/);
  release(); release();
  const releaseAgain = acquireEngineLock(directory); releaseAgain();
  fs.mkdirSync(path.join(directory, '.engine-lock'));
  assert.throws(() => acquireEngineLock(directory), /verify it has stopped/);
});

test('web proxy streams events and does not retry uncertain command requests', async () => {
  require('ts-node/register');
  const http = require('node:http');
  const { startWebServer } = require('../src/server/web');
  let submitted = 0;
  const engine = http.createServer((req, res) => {
    if (req.method === 'POST') { submitted++; req.resume(); res.destroy(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: feed\ndata: {"seq":1,"text":"streaming"}\n\n');
  });
  await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
  const web = startWebServer(new URL(`http://127.0.0.1:${engine.address().port}`), 0);
  await new Promise(resolve => web.once('listening', resolve));
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    const response = await fetch(base + '/api/stream');
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /streaming/);
    await reader.cancel();
    const failed = await fetch(base + '/api/commands/pause', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
    assert.equal(failed.status, 502); assert.match((await failed.json()).error, /not retried/);
    await delay(100); assert.equal(submitted, 1);
  } finally {
    web.closeAllConnections(); engine.closeAllConnections();
    await Promise.all([new Promise(resolve => web.close(resolve)), new Promise(resolve => engine.close(resolve))]);
  }
});
