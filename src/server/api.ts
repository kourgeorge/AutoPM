import { enqueueCommand, listCommands as listAgentCommands, type AgentCommand } from '../core/commands';
import { listLessons, reviewLesson } from '../journal/lessons';
/** Account-scoped browser and operator API. One database and broker account per worker. */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { authenticate, login, logout, sessionCookie, users, type Principal } from './auth';
import { modelUsage } from '../core/modelBudget';
import { serviceStatus } from './status';
import { getPolicySnapshot, saveStrategy } from '../policy/load';
import { getState, openPositionSnapshot } from '../state/state';
import { readRecords, readRecordPage, appendRecord, transaction } from '../core/storage';
import { broker } from '../broker';
import { canonicalSymbol, isCryptoSymbol, sameSymbol } from '../core/symbols';
import { assertExecutionOwner } from '../core/runtime';
import { confirmProtection } from '../strategy/protectionIntent';
import { sweepProposals } from '../strategy/proposalExecutor';
import http from 'http';
import { URL } from 'url';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { automationSummary } from '../core/automation';
import { getAllProposals, getOpenProposals } from '../core/proposals';
import { getLastTick } from '../features/lastTick';
import { scorecard } from '../review/metrics';
import type { Trader } from '../agents/trader';
import type { FeedEntry, HeadlessUI } from '../ui/headless';

/** Request bodies here are a reason string or a chat line — anything bigger is a mistake or an attack. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FEED_LIMIT = 1000;
const DEFAULT_FEED_LIMIT = 200;
/** Keeps proxies and load balancers from closing an idle event stream. */
const SSE_HEARTBEAT_MS = 25_000;
/** A token shorter than this is almost certainly a placeholder someone forgot to replace. */
const MIN_TOKEN_LENGTH = 24;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Ctx {
  principal: Principal;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<Record<string, unknown>>;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Only `/health` is open; everything else needs the token. */
  open?: boolean;
}

export interface ApiServerDeps {
  ui: HeadlessUI;
  trader: Trader;
  messageService?: (text: string, actor: string) => AgentCommand;
}

export interface ApiServer {
  close(): Promise<void>;
  address(): ReturnType<http.Server["address"]>;
}

/**
 * Start the API, or return null (with a log line saying why) when credentials are missing.
 * throws for configuration errors; headless startup requires an enabled API.
 */
export function startApiServer(deps: ApiServerDeps): ApiServer | null {
  const { token, host, port, corsOrigin } = config.api;
  if (!token && Object.keys(users()).length === 0) {
    logger.warn('[API] API_TOKEN is not set — the HTTP API is OFF. Set it to approve trades and read status remotely.');
    return null;
  }
  if ((token && token.length < MIN_TOKEN_LENGTH) || (config.api.viewerToken && config.api.viewerToken.length < MIN_TOKEN_LENGTH)) {
    logger.error(`[API] API_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters — refusing to start the HTTP API. Generate one with: openssl rand -hex 32`);
    return null;
  }

  const routes = buildRoutes(deps);
  const streams = new Set<http.ServerResponse>();
  const buckets = new Map<string, { until: number; count: number }>();
  function rateLimit(key: string, limit: number): boolean {
    const now = Date.now();
    for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
    if (!buckets.has(key) && buckets.size >= 10000) return false;
    const bucket = buckets.get(key) ?? { until: now + 60000, count: 0 };
    bucket.count++; buckets.set(key, bucket); return bucket.count <= limit;
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error(`[API] unhandled error: ${err?.message ?? String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && ['/', '/dashboard.js', '/dashboard.css'].includes(url.pathname)) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, '../../web', file))); return;
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!rateLimit('login:' + req.socket.remoteAddress, 10)) { sendJson(res, 429, { error: 'Too many login attempts; try again in a minute' }); return; }
      if (req.headers.origin && req.headers.origin !== config.api.publicOrigin) { sendJson(res, 403, { error: 'Wrong origin' }); return; }
      try {
        const body = await readJsonBody(req);
        if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 256) throw new HttpError(400, 'Username and password are required');
        const result = await login(body.username, body.password);
        if (!result) { sendJson(res, 401, { error: 'Invalid username or password' }); return; }
        res.setHeader('Set-Cookie', sessionCookie(result.token));
        sendJson(res, 200, { user: result.user, csrf: result.csrf });
      } catch (err: any) { if (err instanceof HttpError) sendJson(res, err.status, { error: err.message }); else throw err; }
      return;
    }
    const match = matchRoute(routes, req.method ?? 'GET', url.pathname);
    if (!match) {
      sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
      return;
    }
    const principal = authenticate(req);
    if (!match.route.open && !principal) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: 'Sign in to continue' }); return;
    }
    if (!rateLimit('request:' + (principal?.name ?? req.socket.remoteAddress), 240)) {
      sendJson(res, 429, { error: 'Request limit reached; try again in a minute' }); return;
    }
    if (req.method === 'POST' && principal) {
      if (principal.csrf && (req.headers['x-csrf-token'] !== principal.csrf || (req.headers.origin && req.headers.origin !== config.api.publicOrigin))) {
        sendJson(res, 403, { error: 'Invalid request origin or CSRF token' }); return;
      }
      if (principal.role === 'viewer' && url.pathname !== '/api/logout') { sendJson(res, 403, { error: 'Viewer access is read-only' }); return; }
      if ((url.pathname === '/api/strategy' || url.pathname.includes('/adopt') || url.pathname.includes('/confirm-protection') || url.pathname.startsWith('/api/lessons/')) && principal.role !== 'admin') {
        sendJson(res, 403, { error: 'Administrator access required' }); return;
      }
    }

    // The stream holds its response open, so it is handled here rather than as a JSON route.
    if (url.pathname === '/api/stream') {
      if (streams.size >= 50) { sendJson(res, 429, { error: 'Too many open streams' }); return; }
      openStream(req, res, url, deps.ui, streams);
      return;
    }

    try {
      const result = await match.route.handler({
        principal: principal ?? { name: 'anonymous', role: 'viewer' },
        req,
        res,
        url,
        params: match.params,
        body: () => readJsonBody(req),
      });
      sendJson(res, res.statusCode, result);
    } catch (err: any) {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else throw err;
    }
  }

  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('error', (err) => {
    logger.error(`[API] server error: ${err.message}`);
    throw err;
  });
  server.listen(port, host, () => {
    logger.info(`[API] listening on http://${host}:${port}${corsOrigin ? ` (browser origin ${corsOrigin})` : ''}`);
  });

  return {
    address: () => server.address(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of streams) s.end();
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function buildRoutes({ ui, trader, messageService }: ApiServerDeps): Route[] {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, open = false): void => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) + '$',
    );
    routes.push({ method, pattern, keys, handler, open });
  };

  add('GET', '/health', () => {
    const tick = getLastTick();
    return { ok: true, uptimeSec: Math.round(process.uptime()), lastTickAt: tick?.tickAt ?? null };
  }, true);

  add('GET', '/ready', ({ res }) => {
    const status = serviceStatus(); res.statusCode = status.ready ? 200 : 503;
    return { ready: status.ready };
  }, true);
  add('GET', '/api/session', ({ principal }) => ({ user: { name: principal.name, role: principal.role }, csrf: principal.csrf }));
  add('POST', '/api/logout', ({ principal, res }) => { logout(principal); res.setHeader('Set-Cookie', sessionCookie('')); return { ok: true }; });

  add('GET', '/api/status', () => {
    const snap = ui.snapshot();
    const tick = getLastTick();
    return {
      health: serviceStatus(),
      usage: modelUsage(),
      env: snap.env,
      automation: automationSummary(),
      trader: { ...trader.status, lane: snap.traderLane, cycle: snap.cycle },
      concierge: { lane: snap.conciergeLane },
      market: { open: snap.venueOpen, session: tick?.session ?? null },
      account: tick?.account ?? null,
      portfolio: tick?.portfolio ?? null,
      positionCount: tick && !tick.positionsStale ? Object.keys(tick.positions).length : null,
      openProposals: getOpenProposals().length,
      pendingEvents: snap.events.length,
      policyVersion: tick?.policyVersion ?? null,
      lastTickAt: tick?.tickAt ?? null,
    };
  });

  add('GET', '/api/positions', () => {
    const tick = getLastTick();
    return {
      lastTickAt: tick?.tickAt ?? null,
      available: !!tick && !tick.positionsStale,
      error: tick?.positionsError ?? (!tick ? 'Waiting for account data' : null),
      positions: tick && !tick.positionsStale ? Object.values(tick.positions).map(p => ({ ...p, managed: !!getState().positionSnapshots[canonicalSymbol(p.symbol)] })) : null,
    };
  });

  add('GET', '/api/watchlist', () => {
    const tick = getLastTick();
    return {
      lastTickAt: tick?.tickAt ?? null,
      watchlist: tick ? Object.values(tick.watchlist) : [],
    };
  });

  add('GET', '/api/proposals', ({ url }) => {
    const status = url.searchParams.get('status') ?? 'open';
    if (status !== 'open' && status !== 'all') throw new HttpError(400, 'status must be "open" or "all"');
    const list = status === 'open' ? getOpenProposals() : getAllProposals();
    return { proposals: [...list].sort((a, b) => b.createdAt - a.createdAt) };
  });

  const decide = (decision: 'approve' | 'reject'): Handler => async ({ params, body, principal }) => {
    const reason = decision === 'reject' ? optionalString((await body()).reason, 'reason') : undefined;
    try {
      ui.decide(decision, params.id, reason, principal.name);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // `proposals.ts` throws plain Errors; tell "not found" apart from "already decided".
      throw new HttpError(/no such proposal/.test(msg) ? 404 : 409, msg);
    }
    return { proposal: getAllProposals().find((p) => p.id === params.id) };
  };
  add('POST', '/api/proposals/:id/approve', decide('approve'));
  add('POST', '/api/proposals/:id/reject', decide('reject'));

  add('GET', '/api/notifications', () => ({ notifications: readRecords('notification', 100) }));
  add('GET', '/api/history/:kind', ({ params, url }) => {
    if (!['decision','fill','proposal','operator','strategy','notification'].includes(params.kind)) throw new HttpError(400, 'Unknown history type');
    const after = parseNonNegativeInt(url.searchParams.get('after'), 0, 'after');
    const limit = Math.min(parseNonNegativeInt(url.searchParams.get('limit'), 50, 'limit'), 100);
    return { entries: readRecordPage(params.kind, after, limit) };
  });

  add('GET', '/api/events', () => {
    const snap = ui.snapshot();
    return { pending: snap.events, activity: snap.activity };
  });

  add('GET', '/api/scorecard', ({ url }) => {
    const raw = url.searchParams.get('days');
    if (raw == null) return scorecard();
    const days = Number(raw);
    if (!Number.isInteger(days) || days <= 0) throw new HttpError(400, 'days must be a whole number above 0');
    return scorecard({ days });
  });

  add('GET', '/api/feed', ({ url }) => {
    const after = parseNonNegativeInt(url.searchParams.get('after'), 0, 'after');
    const limit = Math.min(parseNonNegativeInt(url.searchParams.get('limit'), DEFAULT_FEED_LIMIT, 'limit'), MAX_FEED_LIMIT);
    return { entries: ui.feedAfter(after, limit) };
  });

  // Matched here so it gets auth and a 404-free route; the actual handling is in `handle`.
  add('GET', '/api/stream', () => undefined);

  add('GET', '/api/commands', () => ({
    commands: ui.listCommands().map((c) => ({ name: c.name, aliases: c.aliases ?? [], args: c.args ?? null, help: c.help })),
  }));

  add('POST', '/api/commands/:name', async ({ params, body, principal }) => {
    if (!['pause','resume','cycle'].includes(params.name)) throw new HttpError(400, 'Use pause, resume, or cycle');
    appendRecord('operator', crypto.randomUUID(), new Date().toISOString(), { actorId: principal.name, action: params.name });
    const args = optionalString((await body()).args, 'args') ?? '';
    const result = await ui.runCommand(params.name, args);
    if (!result.ok && result.output.length === 0 && /^Unknown command/.test(result.error ?? '')) {
      throw new HttpError(404, result.error!);
    }
    return result;
  });

  add('GET', '/api/agent-commands', () => ({ commands: listAgentCommands() }));
  add('GET', '/api/lessons', () => ({ lessons: listLessons() }));
  add('POST', '/api/lessons/:id', async ({ body, params, principal }) => {
    const input = await body();
    try { return reviewLesson(params.id, String(input.text ?? ''), input.active as boolean, principal.name); }
    catch (err: any) { throw new HttpError(400, err.message); }
  });
  add('POST', '/api/messages', async ({ body, principal }) => {
    const text = optionalString((await body()).text, 'text');
    if (!text?.trim()) throw new HttpError(400, 'text is required');
    if (text.length > 4000) throw new HttpError(400, 'Messages must be at most 4000 characters');
    if (/^\s*(\/|approve\b|reject\b)/i.test(text)) throw new HttpError(400, 'Use the explicit account controls for commands and approvals');
    const command = messageService ? messageService(text, principal.name) : enqueueCommand('concierge', text, principal.name);
    return { accepted: true, commandId: command.id, status: command.status };
  });

  add('GET', '/api/strategy', () => getPolicySnapshot());
  add('POST', '/api/strategy', async ({ body, principal }) => {
    const input = await body();
    try { return saveStrategy(input.policy, String(input.expectedHash ?? ''), principal.name, input.playbook as string | undefined); }
    catch (err: any) { throw new HttpError(/changed/.test(err.message) ? 409 : 400, err.message); }
  });
  add('GET', '/api/orders', () => {
    const tick = getLastTick();
    return { available: !!tick && !tick.ordersStale, lastTickAt: tick?.tickAt, orders: tick && !tick.ordersStale ? tick.orders : null };
  });
  add('POST', '/api/positions/:symbol/adopt', async ({ params, body, principal }) => {
    const input = await body(), symbol = canonicalSymbol(params.symbol), stop = Number(input.stop), target = input.target == null ? undefined : Number(input.target);
    if ([stop, target].some(level => level != null && Math.abs(level * 100 - Math.round(level * 100)) > 1e-8)) throw new HttpError(400, 'Stop and target prices must use whole cents');
    if (isCryptoSymbol(symbol) || !(stop > 0) || !Number.isFinite(stop) || (target != null && (!Number.isFinite(target) || target <= stop))) throw new HttpError(400, 'Provide valid equity stop and target prices');
    const positions = await broker.getPositions();
    const held = positions.find(p => sameSymbol(p.symbol, symbol));
    const mark = held?.marketValue != null && held.qty > 0 ? held.marketValue / held.qty : null;
    if (!held || held.assetClass === 'other' || held.qty <= 0 || !Number.isInteger(held.qty) || mark == null || stop >= mark || (target != null && target <= mark)) throw new HttpError(409, 'A whole-share long holding and a stop below the current mark are required');
    if (getState().positionSnapshots[symbol]) throw new HttpError(409, 'Position is already managed');
    if ((await broker.getOpenOrders()).some(o => sameSymbol(o.symbol, symbol))) throw new HttpError(409, 'Review existing broker orders before adopting this holding');
    assertExecutionOwner();
    transaction(() => {
      openPositionSnapshot({ symbol, entryPrice: held.avgCost, stopLevel: stop, takeProfitLevel: target });
      appendRecord('operator', crypto.randomUUID(), new Date().toISOString(), { actorId: principal.name, action: 'adopt', symbol, stop, target, qty: held.qty });
    });
    return { managed: true, protection: 'Waiting for broker confirmation' };
  });
  add('POST', '/api/positions/:symbol/confirm-protection', async ({ params, body, principal }) => {
    const input = await body();
    try { await confirmProtection(params.symbol, String(input.stopOrderId ?? ''), input.targetOrderId as string | undefined, principal.name); }
    catch (err: any) { throw new HttpError(409, err.message); }
    return { ok: true, note: 'Protection verified. Trading remains paused until resumed.' };
  });
  add('POST', '/api/reconcile', async () => { await sweepProposals(); return serviceStatus(); });
  return routes;
}

// ── Server-Sent Events ───────────────────────────────────────────────────────

function openStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ui: HeadlessUI,
  streams: Set<http.ServerResponse>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    // Stops nginx from buffering the stream into silence.
    'X-Accel-Buffering': 'no',
  });

  const send = (e: FeedEntry): void => {
    if (!authenticate(req)) { res.end(); return; }
    if (!res.write(`id: ${e.seq}\nevent: feed\ndata: ${JSON.stringify(e)}\n\n`)) res.end();
  };

  // A browser's EventSource resends the last id it saw on reconnect; replay what it missed.
  const resumeFrom = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? NaN);
  if (Number.isInteger(resumeFrom) && resumeFrom >= 0) {
    const replay = ui.feedAfter(resumeFrom, MAX_FEED_LIMIT + 1);
    if (replay.length > MAX_FEED_LIMIT) { res.write('event: reset\ndata: {"reason":"Fetch /api/feed to catch up"}\n\n'); res.end(); return; }
    for (const e of replay) send(e);
  }

  const unsubscribeFeed = ui.subscribe(send);
  // Tells the dashboard to refetch status/positions — sending the whole tick would be wasteful.
  const unsubscribeTicks = ui.subscribeTicks(() => {
    res.write(`event: tick\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!authenticate(req) || !res.write(': keep-alive\n\n')) res.end();
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();
  streams.add(res);

  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribeFeed();
    unsubscribeTicks();
    streams.delete(res);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { route, params };
  }
  return null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function optionalString(v: unknown, name: string): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
  return v;
}

function parseNonNegativeInt(raw: string | null, fallback: number, name: string): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a whole number, 0 or more`);
  return n;
}
