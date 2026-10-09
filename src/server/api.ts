import { enqueueRequest, listRequests, type AgentRequest } from '../core/requests';
import { listLessons, reviewLesson } from '../journal/lessons';
/** Local dashboard and operator API. Listens on this computer only; there is one user, so no login. */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { modelUsage, modelBudgetStatus, saveAiSettings } from '../core/modelBudget';
import { serviceStatus } from './status';
import { getPolicySnapshot, saveStrategy } from '../policy/load';
import { getState } from '../state/state';
import { readRecords, readRecordPage, appendRecord, listRecords, readRecord } from '../core/storage';
import { broker } from '../broker';
import { canonicalSymbol } from '../core/symbols';
import { collectBars } from '../collect/barSource';
import { isPresent } from '../collect/types';
import type { Timeframe } from '../collect/yahoo';
import { confirmProtection, clearUnplacedProtection } from '../strategy/protectionIntent';
import { adoptHolding, AdoptRefused } from '../strategy/adopt';
import { sweepActions } from '../strategy/actionExecutor';
import http from 'http';
import { URL } from 'url';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { automationSummary } from '../core/automation';
import { getAllActions, getOpenActions } from '../core/actions';
import { getLastTick } from '../features/lastTick';
import { scorecard } from '../review/metrics';
import { activityHistory, savedPositionContext, savedTaskDetails } from '../review/activity';
import { textPage } from '../agents/savedResults';
import { startResearch, researchStatus } from '../agents/researcher';
import { readEvidence } from '../journal/evidence';
import type { Source } from '../collect/research';
import type { Trader } from '../agents/trader';
import type { FeedEntry, HeadlessUI } from '../ui/headless';

/** Request bodies here are a reason string or a chat line — anything bigger is a mistake or an attack. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FEED_LIMIT = 1000;
const DEFAULT_FEED_LIMIT = 200;
/** Keeps proxies and load balancers from closing an idle event stream. */
const SSE_HEARTBEAT_MS = 25_000;
/** Equity points kept for the live chart — at one tick a minute, well over a trading day. */
const EQUITY_HISTORY_POINTS = 1500;
/** Every request is made by the one local user. */
const OPERATOR = 'operator';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Ctx {
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
}

export interface ApiServerDeps {
  ui: HeadlessUI;
  /** The standalone engine serves API routes only; the web process owns assets. */
  serveWeb?: boolean;
  trader: Trader;
  messageService?: (text: string, actor: string) => AgentRequest;
}

export interface ApiServer {
  close(): Promise<void>;
  address(): ReturnType<http.Server["address"]>;
}

/**
 * Start the API on 127.0.0.1. The Host check stops a web page from reaching it through a
 * DNS name that points here; the Origin check stops another site from posting to it.
 */
export function startApiServer(deps: ApiServerDeps): ApiServer {
  const { port } = config.api;
  // In memory only: the chart shows this run of the app, not the account's whole history.
  const equityHistory: Array<{ at: string; equity: number }> = [];
  const recordEquity = (): void => {
    const tick = getLastTick();
    if (tick?.account?.equity == null || tick.account.stale || equityHistory.at(-1)?.at === tick.tickAt) return;
    equityHistory.push({ at: tick.tickAt, equity: tick.account.equity });
    if (equityHistory.length > EQUITY_HISTORY_POINTS) equityHistory.shift();
  };
  recordEquity();
  const unsubscribeEquity = deps.ui.subscribeTicks(recordEquity);
  const routes = buildRoutes(deps, equityHistory);
  const streams = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error(`[API] unhandled error: ${err?.message ?? String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const bound = (server.address() as { port: number }).port;
    const origins = [`http://127.0.0.1:${bound}`, `http://localhost:${bound}`];
    if (!origins.includes('http://' + (req.headers.host ?? ''))) { sendJson(res, 403, { error: `Open the dashboard at http://127.0.0.1:${bound}` }); return; }
    if (req.method !== 'GET' && req.headers.origin && !origins.includes(req.headers.origin)) { sendJson(res, 403, { error: 'Wrong origin' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (deps.serveWeb !== false && req.method === 'GET' && ['/', '/dashboard.js', '/dashboard.css', '/favicon.svg'].includes(url.pathname)) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, '../../web', file))); return;
    }
    const match = matchRoute(routes, req.method ?? 'GET', url.pathname);
    if (!match) {
      sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
      return;
    }
    // The stream holds its response open, so it is handled here rather than as a JSON route.
    if (url.pathname === '/api/stream') {
      if (streams.size >= 50) { sendJson(res, 429, { error: 'Too many open streams' }); return; }
      openStream(req, res, url, deps.ui, streams);
      return;
    }

    try {
      const result = await match.route.handler({
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
  server.listen(port, '127.0.0.1', () => {
    logger.info(`[API] dashboard at http://127.0.0.1:${(server.address() as { port: number }).port}`);
  });

  return {
    address: () => server.address(),
    close: () =>
      new Promise<void>((resolve) => {
        unsubscribeEquity();
        for (const s of streams) s.end();
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function buildRoutes({ ui, trader, messageService }: ApiServerDeps, equityHistory: ReadonlyArray<{ at: string; equity: number }>): Route[] {
  const routes: Route[] = [];
  const instanceId = crypto.randomUUID();
  const priceHistoryCache = new Map<string, { until: number; result: Promise<unknown> }>();
  const add = (method: string, path: string, handler: Handler): void => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) + '$',
    );
    routes.push({ method, pattern, keys, handler });
  };

  // Read-only projection for the terminal client. The client never opens account storage.
  add('GET', '/api/terminal', ({ url }) => {
    const after = url.searchParams.has('after') ? parseNonNegativeInt(url.searchParams.get('after'), 0, 'after') : null;
    const entries = after == null
      ? listRecords<FeedEntry>('activity', { desc: true, limit: 200 }).reverse().map(r => ({ ...r.value, seq: r.seq }))
      : ui.feedAfter(after, 200);
    return { instanceId, snapshot: { ...ui.snapshot(), usage: modelUsage(), tick: getLastTick() ?? ui.snapshot().tick,
      actions: getOpenActions() }, health: serviceStatus(), entries };
  });

  add('GET', '/api/status', () => {
    const snap = ui.snapshot();
    const tick = getLastTick();
    return {
      health: serviceStatus(),
      usage: modelUsage(),
      aiBudget: modelBudgetStatus(),
      env: snap.env,
      automation: automationSummary(),
      trader: { ...trader.status, lane: snap.traderLane, cycle: snap.cycle },
      assistant: { lane: snap.assistantLane },
      researcher: researchStatus(),
      market: { open: snap.venueOpen, session: tick?.session ?? null },
      account: tick?.account ?? null,
      portfolio: tick?.portfolio ?? null,
      positionCount: tick && !tick.positionsStale ? Object.keys(tick.positions).length : null,
      openActions: getOpenActions().length,
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
      positions: tick && !tick.positionsStale ? Object.values(tick.positions).map(p => ({ ...p,
        managed: !!getState().positionSnapshots[canonicalSymbol(p.symbol)] })) : null,
    };
  });

  const reviewSymbol = (raw: string): string => {
    const symbol = raw.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9./-]{0,19}$/.test(symbol)) throw new HttpError(400, 'A valid ticker is required');
    return canonicalSymbol(symbol);
  };
  add('GET', '/api/positions/:symbol/review', ({ params }) => savedPositionContext(reviewSymbol(params.symbol)));
  add('POST', '/api/positions/:symbol/review', ({ params }) => {
    // The research worker takes the ticker as written ("BRK.B"); data sources don't know "BRKB".
    let request;
    try { request = startResearch(params.symbol, OPERATOR); }
    catch (err: any) { throw new HttpError(/valid ticker/.test(err.message) ? 400 : 409, err.message); }
    return { accepted: true, requestId: request.id, status: request.status };
  });

  const savedPage = (value: string, url: URL) => {
    try { return textPage(value, parseNonNegativeInt(url.searchParams.get('offset'), 0, 'offset'),
      parseNonNegativeInt(url.searchParams.get('limit'), 3000, 'limit')); }
    catch (err: any) { if (err instanceof HttpError) throw err; throw new HttpError(400, err.message); }
  };
  add('GET', '/api/evidence/:id', ({ params, url }) => {
    const row = readEvidence(params.id);
    if (!row) throw new HttpError(404, 'This observation was not found');
    return { id: row.id, tool: row.tool, symbol: row.symbol, source: row.source,
      recordedAt: row.recordedAt, asOf: row.asOf, ...savedPage(JSON.stringify(row.data, null, 2), url) };
  });
  add('GET', '/api/tool-receipts/:id', ({ params, url }) => {
    const row = readRecord<any>('tool-calls', params.id);
    if (!row) throw new HttpError(404, 'This tool receipt was not found');
    return { id: params.id, name: row.name, input: row.input, requestId: row.requestId,
      startedAt: row.startedAt, finishedAt: row.finishedAt, resultSaved: row.result !== undefined,
      ...savedPage(row.result ?? 'No result was recorded. Inspect linked action outcomes before retrying.', url) };
  });
  add('GET', '/api/source-text/:id', ({ params, url }) => {
    const row = readRecord<Source>('sources', params.id);
    if (row?.text === undefined) throw new HttpError(404, 'Original source text has not been saved');
    return { id: params.id, fetchedAt: row.fetchedAt, ...savedPage(row.text, url) };
  });
  add('GET', '/api/agent-tasks/:id', ({ params }) => {
    const task = savedTaskDetails(params.id);
    if (!task) throw new HttpError(404, 'This agent task was not found');
    return task;
  });

  // Read-only chart data. Short-lived, bounded caching also coalesces concurrent requests.
  add('GET', '/api/price-history', ({ url }) => {
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    const timeframe = url.searchParams.get('timeframe') ?? '1Day';
    if (!/^[A-Z0-9][A-Z0-9./-]{0,19}$/.test(symbol)) throw new HttpError(400, 'A valid ticker is required');
    if (!['5Min', '15Min', '1Hour', '1Day'].includes(timeframe)) throw new HttpError(400, 'Unsupported chart interval');
    const key = `${symbol}:${timeframe}`, cached = priceHistoryCache.get(key);
    if (cached && cached.until > Date.now()) return cached.result;
    const result = (async () => {
      try {
        const observation = await collectBars(symbol, 120, timeframe as Timeframe);
        if (!isPresent(observation)) return { symbol, timeframe, available: false, bars: [], error: 'Price history is unavailable from the market-data providers.' };
        const bars = [...new Map(observation.value.filter(b =>
          Number.isFinite(Date.parse(b.t)) && [b.o,b.h,b.l,b.c].every(n => Number.isFinite(n) && n > 0) &&
          Number.isFinite(b.v) && b.v >= 0 && b.h >= Math.max(b.o,b.c) && b.l <= Math.min(b.o,b.c) && b.h >= b.l
        ).map(b => [Date.parse(b.t), b])).values()].sort((a,b) => Date.parse(a.t)-Date.parse(b.t)).slice(-120);
        return { symbol, timeframe, available: bars.length > 0, bars, source: observation.source,
          asOf: bars.at(-1)?.t ?? null, fetchedAt: observation.fetchedAt, stale: observation.stale,
          ...(bars.length ? {} : { error: 'No usable price bars are available.' }) };
      } catch {
        return { symbol, timeframe, available: false, bars: [], error: 'Price history could not be loaded. Try again shortly.' };
      }
    })();
    if (priceHistoryCache.size >= 64) priceHistoryCache.delete(priceHistoryCache.keys().next().value!);
    priceHistoryCache.set(key, { until: Date.now() + 60_000, result });
    return result;
  });

  add('GET', '/api/equity-history', () => ({ points: equityHistory }));

  add('GET', '/api/watchlist', () => {
    const tick = getLastTick();
    return {
      lastTickAt: tick?.tickAt ?? null,
      watchlist: tick ? Object.values(tick.watchlist) : [],
    };
  });

  add('GET', '/api/actions', ({ url }) => {
    const status = url.searchParams.get('status') ?? 'open';
    if (status !== 'open' && status !== 'all') throw new HttpError(400, 'status must be "open" or "all"');
    const list = status === 'open' ? getOpenActions() : getAllActions();
    return { actions: [...list].sort((a, b) => b.createdAt - a.createdAt) };
  });

  const decide = (decision: 'approve' | 'reject'): Handler => async ({ params, body }) => {
    const reason = decision === 'reject' ? optionalString((await body()).reason, 'reason') : undefined;
    try {
      ui.decide(decision, params.id, reason, OPERATOR);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // `actions.ts` throws plain Errors; tell "not found" apart from "already decided".
      throw new HttpError(/no such action/.test(msg) ? 404 : 409, msg);
    }
    return { action: getAllActions().find((p) => p.id === params.id) };
  };
  add('POST', '/api/actions/:id/approve', decide('approve'));
  add('POST', '/api/actions/:id/reject', decide('reject'));

  add('GET', '/api/notifications', () => ({ notifications: readRecords('notifications', 100) }));
  add('GET', '/api/activity-history', ({ url }) => {
    const type = url.searchParams.get('type') ?? 'all';
    if (!['all', 'decision', 'fill', 'event'].includes(type)) throw new HttpError(400, 'type must be all, decision, fill or event');
    const offset = parseNonNegativeInt(url.searchParams.get('offset'), 0, 'offset');
    const limit = Math.max(1, Math.min(parseNonNegativeInt(url.searchParams.get('limit'), 50, 'limit'), 100));
    return activityHistory({ type, query: url.searchParams.get('q') ?? '', offset, limit });
  });
  add('GET', '/api/history/:kind', ({ params, url }) => {
    if (!['journal','fills','action-history','operator-commands','strategy-changes','notifications'].includes(params.kind)) throw new HttpError(400, 'Unknown history type');
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
    // `tail=N` returns the newest N entries, so a chat opens on the latest messages.
    if (url.searchParams.has('tail')) {
      const tail = Math.min(parseNonNegativeInt(url.searchParams.get('tail'), DEFAULT_FEED_LIMIT, 'tail'), MAX_FEED_LIMIT);
      return { entries: listRecords<FeedEntry>('activity', { desc: true, limit: tail }).reverse().map(r => ({ ...r.value, seq: r.seq })) };
    }
    const after = parseNonNegativeInt(url.searchParams.get('after'), 0, 'after');
    const limit = Math.min(parseNonNegativeInt(url.searchParams.get('limit'), DEFAULT_FEED_LIMIT, 'limit'), MAX_FEED_LIMIT);
    return { entries: ui.feedAfter(after, limit) };
  });

  // Matched here so it gets auth and a 404-free route; the actual handling is in `handle`.
  add('GET', '/api/stream', () => undefined);

  add('GET', '/api/commands', () => ({
    commands: ui.listCommands().filter((c) => c.api)
      .map((c) => ({ name: c.name, aliases: c.aliases ?? [], args: c.args ?? null, help: c.help })),
  }));

  add('POST', '/api/commands/:name', async ({ params, body }) => {
    const name = params.name.toLowerCase();
    const command = ui.listCommands().find((c) => c.api && (c.name === name || c.aliases?.includes(name)));
    if (!command) throw new HttpError(404, `Unknown or unavailable command /${params.name}. Type /help for the list.`);
    const args = optionalString((await body()).args, 'args') ?? '';
    if (args.length > 4000) throw new HttpError(400, 'Command arguments must be at most 4000 characters');
    appendRecord('operator-commands', crypto.randomUUID(), new Date().toISOString(), { actorId: OPERATOR, action: command.name, args });
    ui.echoOperator(`/${command.name}${args ? ' ' + args : ''}`);
    return ui.runCommand(command.name, args);
  });

  add('GET', '/api/agent-commands', () => ({ commands: listRequests() }));
  add('GET', '/api/lessons', () => ({ lessons: listLessons() }));
  add('POST', '/api/lessons/:id', async ({ body, params }) => {
    const input = await body();
    try { return reviewLesson(params.id, String(input.text ?? ''), input.active as boolean); }
    catch (err: any) { throw new HttpError(400, err.message); }
  });
  add('POST', '/api/messages', async ({ body }) => {
    const text = optionalString((await body()).text, 'text');
    if (!text?.trim()) throw new HttpError(400, 'text is required');
    if (text.length > 4000) throw new HttpError(400, 'Messages must be at most 4000 characters');
    if (/^\s*(\/|approve\b|reject\b)/i.test(text)) throw new HttpError(400, 'Use the explicit account controls for commands and approvals');
    const command = messageService ? messageService(text, OPERATOR) : enqueueRequest('assistant', text, OPERATOR);
    ui.echoOperator(text);
    return { accepted: true, requestId: command.id, status: command.status };
  });

  add('GET', '/api/settings/ai', () => modelBudgetStatus());
  add('POST', '/api/settings/ai', async ({ body }) => {
    const input = await body();
    if (!Object.hasOwn(input, 'maxRequestsPerDay') ||
      (input.maxRequestsPerDay !== null && typeof input.maxRequestsPerDay !== 'number')) {
      throw new HttpError(400, 'Daily AI call limit must be a number or null for unlimited');
    }
    try { saveAiSettings({ maxRequestsPerDay: input.maxRequestsPerDay as number | null }); }
    catch (err: any) { throw new HttpError(400, err.message); }
    return modelBudgetStatus();
  });

  add('GET', '/api/strategy', () => getPolicySnapshot());
  add('POST', '/api/strategy', async ({ body }) => {
    const input = await body();
    try { return saveStrategy(input.policy, String(input.expectedHash ?? ''), OPERATOR, input.playbook as string | undefined); }
    catch (err: any) { throw new HttpError(/changed/.test(err.message) ? 409 : 400, err.message); }
  });
  add('GET', '/api/orders', () => {
    const tick = getLastTick();
    return { available: !!tick && !tick.ordersStale, lastTickAt: tick?.tickAt, orders: tick && !tick.ordersStale ? tick.orders : null };
  });
  add('POST', '/api/positions/:symbol/adopt', async ({ params, body }) => {
    const input = await body(), target = input.target == null ? undefined : Number(input.target);
    try { await adoptHolding(params.symbol, Number(input.stop), target, OPERATOR); }
    catch (err: any) { if (err instanceof AdoptRefused) throw new HttpError(err.kind === 'invalid' ? 400 : 409, err.message); throw err; }
    return { managed: true, protection: 'Waiting for broker confirmation' };
  });
  add('POST', '/api/positions/:symbol/confirm-protection', async ({ params, body }) => {
    const input = await body();
    try { await confirmProtection(params.symbol, String(input.stopOrderId ?? ''), input.targetOrderId as string | undefined, OPERATOR); }
    catch (err: any) { throw new HttpError(409, err.message); }
    return { ok: true, note: 'Protection verified. Trading remains paused until resumed.' };
  });
  add('POST', '/api/positions/:symbol/rearm', async ({ params }) => {
    try { await clearUnplacedProtection(params.symbol, OPERATOR); }
    catch (err: any) { throw new HttpError(400, err.message); }
    return { ok: true };
  });

  add('POST', '/api/reconcile', async () => { await sweepActions(); return serviceStatus(); });
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
  // Node holds the headers until the first write; send one now so the browser knows it is connected.
  res.write(': connected\n\n');

  const send = (e: FeedEntry): void => {
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
    if (!res.write(': keep-alive\n\n')) res.end();
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
