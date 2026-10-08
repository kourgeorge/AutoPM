require('ts-node/register');
Object.assign(process.stdout, { columns: 110, rows: 32 });
require('../../src/tui');
const uiModule = require.resolve('../../src/ui/ui');
const report = () => {
  const ui = require.cache[uiModule]?.exports.ui;
  if (!ui) return;
  const forbidden = Object.keys(require.cache).filter(file => /\/src\/(broker\/|core\/(storage|config)\.|agents\/|strategy\/(adopt|executionLoop|actionExecutor|stopOrders|protectionIntent)\.)/.test(file));
  process.send?.({ state: true, env: ui.env, lane: ui.traderLane, forbidden });
};
const timer = setInterval(report, 100); timer.unref();
process.on('message', message => {
  if (message.type === 'input') process.stdin.emit('data', Buffer.from(message.value + '\r'));
  if (message.type === 'stop') { process.emit('SIGTERM'); clearInterval(timer); process.disconnect(); }
});
