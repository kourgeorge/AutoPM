// Loaded before the real daemon. All external I/O is blocked; only broker reads are faked.
const fs = require('node:fs');
const path = require('node:path');
let accountReads = 0;
let mutations = 0;
const deny = () => { throw new Error('Unexpected network access in startup test'); };
require('node:http').request = deny;
require('node:https').request = deny;
require('node:net').Socket.prototype.connect = deny;
global.fetch = deny;
const mutate = () => { mutations++; throw new Error('Trading must not start in a startup test'); };
const brokerPath = require.resolve('../../src/broker');
require.cache[brokerPath] = {
  id: brokerPath, filename: brokerPath, loaded: true,
  exports: { broker: {
    getAccountInfo: async () => {
      accountReads++;
      return { accountId: 'startup-account', equity: 10000, cash: 10000, buyingPower: 10000, previousCloseEquity: 10000 };
    },
    getPositions: async () => [], getOpenOrders: async () => [], getFills: async () => [],
    isMarketOpen: async () => false,
    placeOrder: mutate, cancelOrder: mutate, replaceOrder: mutate, placeOco: mutate,
  } },
};
const runtimePath = require.resolve('../../src/core/runtime');
const probe = setInterval(() => {
  const runtime = require.cache[runtimePath]?.exports;
  if (runtime?.runtimeStatus().ready) {
    clearInterval(probe);
    process.send?.({ ready: true });
  }
}, 25);
probe.unref();
process.on('exit', () => {
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'probe.json'), JSON.stringify({ accountReads, mutations }));
});
