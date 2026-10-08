const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
require('ts-node/register');
const { startWebServer } = require('../src/server/web');

test('browser opened before its engine recovers commands, strategy and live events', { timeout: 35000 }, async () => {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const enginePort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const web = startWebServer(new URL(`http://127.0.0.1:${enginePort}`), 0);
  await new Promise(resolve => web.once('listening', resolve));
  const base = `http://127.0.0.1:${web.address().port}`;
  let engine, browser;
  try {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base);
    await expect(page.locator('#notice')).toContainText('Waiting for engine');
    engine = fork(path.join(__dirname, 'fixtures/engine-service.cjs'), [], {
      env: { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-web-recovery-')), TEST_ENGINE_PORT: String(enginePort),
        HEADLESS: '1', BROKER: 'alpaca', AI_PROVIDER: 'ollama', AI_API_KEY: 'test', AI_BASE_URL: '',
        ALPACA_KEY_ID: 'test', ALPACA_SECRET_KEY: 'test', ALPACA_BASE_URL: 'https://paper-api.alpaca.markets', ALERT_WEBHOOK_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    engine.stdout.resume(); engine.stderr.resume();
    await new Promise((resolve, reject) => { engine.once('message', resolve); engine.once('error', reject); engine.once('exit', code => reject(new Error('Engine exited ' + code))); });
    await expect(page.locator('#live')).toHaveText('Live', { timeout: 15000 });
    const icon=await page.request.get(base+'/favicon.svg');
    assert.equal(icon.status(),200);assert.equal(icon.headers()['content-type'],'image/svg+xml');
    await expect(page.locator('#equity')).toHaveText('$10,000.00');
    await expect(page.locator('#settings-state')).toHaveText('Saved');
    await expect(page.locator('#live-feed')).toContainText('Engine process ready');
    await page.locator('#message-text').fill('/pause ');
    await page.locator('#message-text').press('Enter');
    await expect(page.locator('#pause')).toHaveText('Resume trading');
    await page.getByRole('button', { name: 'Approve action', exact: true }).click();
    await expect(page.locator('#actions')).toContainText('approved');
  } finally {
    await browser?.close();
    if (engine && engine.exitCode === null) {
      const exited = new Promise(resolve => engine.once('exit', resolve));
      engine.send('stop'); await exited;
    }
    web.closeAllConnections(); await new Promise(resolve => web.close(resolve));
  }
});
