import * as dotenv from 'dotenv';
dotenv.config();

/** Client settings deliberately do not import broker, policy, or AI configuration. */
export function engineUrl(): URL {
  const url = new URL(process.env.ENGINE_URL ?? `http://127.0.0.1:${process.env.ENGINE_PORT ?? '8788'}`);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ENGINE_URL must be a local HTTP origin, such as http://127.0.0.1:8788');
  }
  return url;
}

export function webPort(): number {
  const port = Number(process.env.WEB_PORT ?? process.env.API_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEB_PORT must be between 1 and 65535');
  return port;
}
