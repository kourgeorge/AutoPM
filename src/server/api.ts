/**
 * The operator HTTP API — what a web dashboard talks to when the bot runs on a server.
 *
 * Started from `daemon.ts` under `HEADLESS=1` only. It is a second front door onto the SAME
 * controls the terminal has, nothing more:
 *
 *   - reads come from the modules that already own the data (last tick, proposal store,
 *     journal, scorecard) or from `HeadlessUI`'s snapshot of what the screen would show;
 *   - every write goes through a path the terminal already uses — `decideProposal` for
 *     approve/reject, the registered slash commands for pause/resume/cycle, and the concierge
 *     for chat. No endpoint places, cancels or changes an order directly, and no endpoint lets
 *     a model decide a proposal.
 *
 * Node's own `http` module, no framework: the surface is a dozen routes and every extra
 * dependency is one more thing to keep patched on a box that holds broker credentials.
 *
 * Auth is a single bearer token (`API_TOKEN`). That is right for ONE bot behind ONE website,
 * which is what each per-user container is; user accounts and logins belong to the website,
 * not here.
 *
 *   GET  /health                          no auth — liveness for the container platform
 *   GET  /api/status                      venue, trader state, account, market, counts
 *   GET  /api/positions                   open positions from the last tick
 *   GET  /api/watchlist                   watchlist rows from the last tick
 *   GET  /api/proposals?status=open|all   trade proposals (default: open)
 *   POST /api/proposals/:id/approve       approve one
 *   POST /api/proposals/:id/reject        reject one; body {"reason": "..."} optional
 *   GET  /api/events                      pending events + recent trade activity
 *   GET  /api/scorecard?days=N            closed-trade results as JSON
 *   GET  /api/feed?after=SEQ&limit=N      log/chat history, oldest first
 *   GET  /api/stream                      the same feed live, as Server-Sent Events
 *   GET  /api/commands                    the slash commands available
 *   POST /api/commands/:name              run one; body {"args": "..."}; returns its output
 *   POST /api/messages                    body {"text": "..."} — exactly like typing a line
 */
import crypto from 'crypto';
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
}

export interface ApiServer {
  close(): Promise<void>;
}

/**
 * Start the API, or return null (with a log line saying why) when it must not run. Never
 * throws: a missing or weak token disables the API, it does not stop the bot from trading.
 */
export function startApiServer(deps: ApiServerDeps): ApiServer | null {
  const { token, host, port, corsOrigin } = config.api;
  if (!token) {
    logger.warn('[API] API_TOKEN is not set — the HTTP API is OFF. Set it to approve trades and read status remotely.');
    return null;
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    logger.error(`[API] API_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters — refusing to start the HTTP API. Generate one with: openssl rand -hex 32`);
    return null;
  }

  const routes = buildRoutes(deps);
  const streams = new Set<http.ServerResponse>();
  const tokenDigest = digest(token);

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
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = matchRoute(routes, req.method ?? 'GET', url.pathname);
    if (!match) {
      sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
      return;
    }
    if (!match.route.open && !authorized(req, tokenDigest)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: 'missing or wrong bearer token' });
      return;
    }

    // The stream holds its response open, so it is handled here rather than as a JSON route.
    if (url.pathname === '/api/stream') {
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
      sendJson(res, 200, result);
    } catch (err: any) {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else throw err;
    }
  }

  server.on('error', (err) => {
    logger.error(`[API] server error: ${err.message}`);
  });
  server.listen(port, host, () => {
    logger.info(`[API] listening on http://${host}:${port}${corsOrigin ? ` (browser origin ${corsOrigin})` : ''}`);
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of streams) s.end();
        server.close(() => resolve());
      }),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function buildRoutes({ ui, trader }: ApiServerDeps): Route[] {
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

  add('GET', '/api/status', () => {
    const snap = ui.snapshot();
    const tick = getLastTick();
    return {
      env: snap.env,
      automation: automationSummary(),
      trader: { ...trader.status, lane: snap.traderLane, cycle: snap.cycle },
      concierge: { lane: snap.conciergeLane },
      market: { open: snap.venueOpen, session: tick?.session ?? null },
      account: tick?.account ?? null,
      portfolio: tick?.portfolio ?? null,
      positionCount: tick ? Object.keys(tick.positions).length : null,
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
      positions: tick ? Object.values(tick.positions) : [],
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

  const decide = (decision: 'approve' | 'reject'): Handler => async ({ params, body }) => {
    const reason = decision === 'reject' ? optionalString((await body()).reason, 'reason') : undefined;
    try {
      ui.decide(decision, params.id, reason);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // `proposals.ts` throws plain Errors; tell "not found" apart from "already decided".
      throw new HttpError(/no such proposal/.test(msg) ? 404 : 409, msg);
    }
    return { proposal: getAllProposals().find((p) => p.id === params.id) };
  };
  add('POST', '/api/proposals/:id/approve', decide('approve'));
  add('POST', '/api/proposals/:id/reject', decide('reject'));

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

  add('POST', '/api/commands/:name', async ({ params, body }) => {
    const args = optionalString((await body()).args, 'args') ?? '';
    const result = await ui.runCommand(params.name, args);
    if (!result.ok && result.output.length === 0 && /^Unknown command/.test(result.error ?? '')) {
      throw new HttpError(404, result.error!);
    }
    return result;
  });

  add('POST', '/api/messages', async ({ body }) => {
    const text = optionalString((await body()).text, 'text');
    if (!text?.trim()) throw new HttpError(400, 'text is required');
    ui.submit(text);
    // Accepted, not answered: the concierge replies asynchronously, into the feed.
    return { accepted: true };
  });

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
    res.write(`id: ${e.seq}\nevent: feed\ndata: ${JSON.stringify(e)}\n\n`);
  };

  // A browser's EventSource resends the last id it saw on reconnect; replay what it missed.
  const resumeFrom = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? NaN);
  if (Number.isInteger(resumeFrom) && resumeFrom >= 0) {
    for (const e of ui.feedAfter(resumeFrom, MAX_FEED_LIMIT)) send(e);
  }

  const unsubscribeFeed = ui.subscribe(send);
  // Tells the dashboard to refetch status/positions — sending the whole tick would be wasteful.
  const unsubscribeTicks = ui.subscribeTicks(() => {
    res.write(`event: tick\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), SSE_HEARTBEAT_MS);
  heartbeat.unref();
  streams.add(res);

  req.on('close', () => {
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

function digest(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

/** Compared as fixed-length digests so neither the length nor the content leaks through timing. */
function authorized(req: http.IncomingMessage, tokenDigest: Buffer): boolean {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  return crypto.timingSafeEqual(digest(m[1].trim()), tokenDigest);
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
