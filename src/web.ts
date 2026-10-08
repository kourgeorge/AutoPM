import { engineUrl, webPort } from './client/config';
import { startWebServer } from './server/web';

try {
  const engine = engineUrl(), port = webPort();
  if (Number(engine.port || 80) === port) throw new Error('WEB_PORT and ENGINE_PORT must differ');
  const server = startWebServer(engine, port);
  server.on('listening', () => console.log(`AutoTrade web: http://127.0.0.1:${port} → engine ${engine.origin}`));
  server.on('error', error => { console.error(`Web startup failed: ${error.message}`); process.exitCode = 1; });
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error: any) { console.error(`Web startup failed: ${error.message}`); process.exitCode = 1; }
