require('ts-node/register');
const { startWebServer } = require('../../src/server/web');
const server = startWebServer(new URL(process.env.ENGINE_URL), 0);
server.on('listening', () => process.send({ ready: true, port: server.address().port }));
const stop = () => { server.close(() => process.disconnect()); server.closeAllConnections(); };
process.on('SIGTERM', stop); process.on('message', message => { if (message === 'stop') stop(); });
