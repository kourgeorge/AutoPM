import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

/** Asset server and streaming API proxy. Never imports the engine or account storage. */
export function startWebServer(engine: URL, port: number): http.Server {
  if (engine.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(engine.hostname)) throw new Error('The web server requires a local engine');
  const upstreamRequests = new Set<http.ClientRequest>();
  const server = http.createServer((req, res) => {
    const bound = (server.address() as { port: number }).port;
    const origins = [`http://127.0.0.1:${bound}`, `http://localhost:${bound}`];
    const fail = (code: number, error: string) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error }));
    };
    if (!origins.includes('http://' + req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) {
      fail(403, 'Open this dashboard on its local address'); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && ['/', '/dashboard.js', '/dashboard.css', '/favicon.svg'].includes(url.pathname)) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      try {
        const content = fs.readFileSync(path.join(__dirname, '../../web', file));
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
        res.end(content);
      } catch { fail(500, 'Dashboard assets are unavailable'); }
      return;
    }
    if (!url.pathname.startsWith('/api/') || !['GET', 'POST'].includes(req.method ?? '')) { fail(404, 'Not found'); return; }
    // Forward only relevant headers; the local origin was checked above before rewriting it.
    const headers: http.OutgoingHttpHeaders = { host: engine.host, origin: engine.origin };
    for (const name of ['content-type', 'content-length', 'last-event-id', 'accept']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const upstream = http.request(new URL(url.pathname + url.search, engine), { method: req.method, headers }, incoming => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    upstreamRequests.add(upstream);
    upstream.on('close', () => upstreamRequests.delete(upstream));
    upstream.on('error', () => fail(502, req.method === 'POST'
      ? 'Engine connection lost. This request was not retried; check its outcome before submitting again.'
      : 'Engine unavailable. Start it with npm run start:engine.'));
    if (url.pathname !== '/api/stream') upstream.setTimeout(60_000, () => upstream.destroy(new Error('Engine timeout')));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  // Closing the web process closes its connections, never the engine.
  server.on('close', () => { for (const request of upstreamRequests) request.destroy(); });
  server.listen(port, '127.0.0.1');
  return server;
}
