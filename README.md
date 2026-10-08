# AutoTrade

A local, single-user trading app with independent engine, terminal, and web processes, a deterministic execution queue, and an AI research agent. It supports Alpaca and Interactive Brokers; automated entries are restricted to whole-share long equities during regular market hours.

## Run locally

Requires Node 22.13 or newer. All account data lives in `data/`. Run one engine per account data directory. Terminal and web clients connect to that engine.

```sh
npm ci
npm run build
```

Set these environment variables, or put them in an untracked `.env`:

```dotenv
BROKER=alpaca
ALPACA_BASE_URL=https://paper-api.alpaca.markets
ALPACA_KEY_ID=your-paper-key
ALPACA_SECRET_KEY=your-paper-secret
AI_PROVIDER=anthropic
AI_MODEL=claude-sonnet-4-6
AI_API_KEY=your-model-key
```

Start the engine, then start either or both interfaces in separate terminals:

```sh
npm run start:engine   # Trading engine and local API on 127.0.0.1:8788
npm run start:tui      # Terminal client; connects to the engine
npm run start:web      # Browser server on http://127.0.0.1:8787
```

For a single-command session, use either shortcut:

```sh
npm run start:engine+tui
npm run start:engine+web
```

Each shortcut starts the engine and the selected interface as separate child processes. Ctrl+C, `/quit` in the paired TUI, or either process exiting stops the pair; the engine gets its normal graceful shutdown. An existing engine is never stopped or reused by these shortcuts—use the standalone UI command to connect to one already running. The matching development shortcuts are `dev:engine+tui` and `dev:engine+web`.

These are three independent processes. Only the engine reads account storage, connects to the broker, and runs research and execution. The TUI sends commands and reads snapshots from the engine; the web server serves the dashboard and proxies its API and event stream. Both interfaces show the same account and action outcomes. Closing or restarting a UI leaves the engine running. Stop the engine with Ctrl+C or SIGTERM in its own terminal.

Clients may start before the engine. The TUI reconnects automatically; the browser shows the unavailable connection and recovers when the engine starts. Failed command requests are never automatically replayed. If a connection drops after submission, check the action or request outcome before submitting again.

`ENGINE_PORT` sets the engine listener (default `8788`). `ENGINE_URL` selects the local engine for both clients (default `http://127.0.0.1:8788`, or the configured `ENGINE_PORT`). `WEB_PORT` sets the browser listener (default `8787`; the older `API_PORT` remains a web-port fallback). UI processes do not need broker or AI credentials. Use `dev:engine`, `dev:tui`, and `dev:web` to run the same roles through TypeScript.

`npm start`, `npm run dev`, and the older `start:headless` / `dev:headless` commands now start the engine only; `HEADLESS` no longer selects a combined engine/TUI startup. When upgrading from a combined process, stop it before starting the separate engine.

The engine acquires `DATA_DIR/.engine-lock` before loading account storage. A second engine using that directory fails immediately, even if it selects another port. Normal shutdown releases the lock. After a crash or SIGKILL, the lock is intentionally retained: inspect `owner.json`, verify the recorded process has stopped, then remove only `.engine-lock` before restarting. This is an operational lock; existing account files need no migration.

AutoTrade is a local, single-user app: there is no login. The dashboard only answers on this computer (127.0.0.1), and refuses requests from other sites. New accounts start with entries and exits set to manual approval; you can switch either to automatic in Strategy settings.

For Interactive Brokers, also set `BROKER=ibkr`, `IBKR_HOST`, `IBKR_PORT`, `IBKR_CLIENT_ID`, and **`IBKR_ACCOUNT`**. Account selection is explicit. Market data still uses the configured Alpaca/Yahoo collectors. USD stock contracts are the supported trading instruments; other holdings are displayed with distinct instrument identities and cannot be adopted for automated trading.

## Trading lifecycle

See [Trader decision context](DECISION_CONTEXT.md) for thesis checks, position reviews, research sources, evidence snapshots and decision follow-up. Optional SEC research requires `SEC_USER_AGENT` with an application name and contact email.

All entry, exit, and adjustment tools create durable actions. Automatic actions start approved; manual actions wait for your approval. One executor validates and claims the action before contacting the broker.

`pending → approved → executing → submitted / partial → executed`

Rejection, failure, expiry, and an unknown broker outcome are explicit states. Submission means an order was sent; filled quantity comes from the broker. Position baselines are recorded from fills. Exit baselines remain until the broker outcome and holdings confirm the close.

Approvals bind the account, venue, full strategy revision, quantity, and expiry. The executor rechecks these after network waits. Manual approvals always expire unanswered; `onTimeout: allow` is rejected. A price move above 1% requires a fresh entry action. Entries use a cent-priced IOC limit that caps spend, and risk checks include outstanding orders.

A stable client order ID supports recovery after a connection failure or restart. An uncertain request is never automatically submitted again. Unknown outcomes pause the account and block subsequent trading actions. Use **Check broker outcomes** after restoring connectivity. If the broker cannot establish the outcome, inspect its order/fill history; keep the account paused until the discrepancy is resolved. There is intentionally no blind “retry trade” button.

Pause is saved immediately and blocks new queued actions. Broker orders already accepted remain active. Protection checks continue independently of AI research and market-data collection. Missing protective legs are reported for inspection; the app does not cancel an external order or tear down a surviving protective leg to rebuild a pair.

Existing holdings start unmanaged unless they have a legacy management record. An administrator can explicitly adopt a supported holding with a stop and optional target. Existing broker orders must be reviewed first. Interrupted protection can be relinked through the recovery form, which checks actual broker prices, quantities, and linked order IDs.

## Strategy and playbook ownership

The account owns a saved revision consisting of structured settings and a pinned playbook. **Review and save** activates both atomically and records the previous revision. Stale saves are rejected so one user cannot overwrite another's changes.

`policy/default.yaml` and `policy/PLAYBOOK.md` seed new accounts. Application upgrades do not silently replace an existing account's playbook. Model-written lessons are advisory. Chat can save watchlist, sizing and risk-limit changes when you ask for them (through the same checks and change history as the Strategy settings form); it cannot change approval settings, activate a strategy, or approve a trade. Platform ceilings and execution constraints remain enforced in code even if the playbook text changes.

The dashboard's **Risk profile** control offers Conservative, Balanced, Aggressive and Custom. Presets fill explicit numeric policy settings; editing one of those values makes the profile Custom. Saving creates the usual account strategy revision and invalidates older approvals. New accounts start Balanced; existing accounts retain their limits and leave new controls unconfigured until the user saves them.

Ask the assistant **“Explain my strategy settings”** for a plain-language overview of the saved profile, risk controls, investment limits, allowed symbols and human approvals. Its read-only `get_strategy_settings` tool reads the current account revision and supplies percentages with consistent units, including explicit “Not configured” labels. Settings changes you ask for in chat are saved immediately with `update_trading_settings` and appear in the strategy change history; approval and automation settings can only be changed in Strategy settings.

| Control | Conservative | Balanced | Aggressive |
| --- | ---: | ---: | ---: |
| Planned risk per trade (% of equity) | 0.25% | 0.5% | 1% |
| Annualized portfolio volatility target | 8% | 12% | 20% |
| Minimum planned reward:risk | 2:1 | 2:1 | 2:1 |
| Maximum position / single-name weight | 5% | 10% | 10% |
| Daily loss entry halt | 1% | 2% | 3% |
| Gross exposure ceiling | 50% | 80% | 100% |
| Sector exposure ceiling | 20% | 30% | 35% |

`risk.riskPerTradePct` and `risk.targetVolatilityPct` use **percentage points** (`0.5` means 0.5%). `risk.minRewardRisk` is a ratio. Null leaves an optional control unconfigured. The older `positionSizePct`, `maxDailyLossPct` and `maxGrossExposurePct` remain fractions (`0.1` means 10%). Presets are starting settings, not performance forecasts.

With a configured risk profile, `get_watchlist_scan` adds portfolio risk fit and ranks feasible candidates by signal strength discounted for incremental volatility. `get_entry_plan` sizes a supported stop/target setup using current equity, buying power, concentration and risk at the IOC entry limit. Execution rechecks the actual permitted quantity, including the approved maximum and regime reduction. Stops and volatility targets are estimates: gaps, slippage and fees can exceed the planned loss, and a high reward:risk ratio alone does not imply positive expectancy.

Portfolio volatility uses sample covariance from up to 60 completed daily return intervals, at least 30 aligned observations, annualized over 252 sessions; cash contributes zero modeled volatility. The engine aligns both endpoints of each interval and requires history through the last completed exchange session. Volatility targeting currently requires authenticated Alpaca calendar access even when orders route through IBKR. Missing calendar data or missing/stale required history blocks new entries. Unknown sectors conservatively count toward the largest possible overlap, including ETFs whose constituents are not modeled. Saving a tighter profile affects future entries; it does not automatically liquidate existing holdings. Backtests reuse the sizing engine with past-only data and conservatively unknown sectors; targetless exit modes disclose that their mechanical reward:risk cannot be evaluated.

After migration, editing the old YAML or Markdown files does not activate changes. Use the dashboard's Strategy settings. The saved account revision is authoritative.

## Agent behavior and audit trail

Trader and assistant use the same bounded turn runner. Tool permissions and input schemas are checked before dispatch. Requests, model turns, tool attempts, and mutation receipts survive restarts; resumed calls use their saved identities. Pausing or stopping interrupts reasoning, while the separate execution loop continues reconciling broker orders and protection. A failed or truncated turn is reported as incomplete, with any already-created actions still visible.

The Requests panel shows who started each request (you or the scheduler), its status, and linked action outcomes. Chat also returns a request ID. Journals distinguish requested quantity, filled quantity, and verified protection; entry intent and the original thesis are retained when later management decisions change stops. Critical incidents remain open after observation, and an acting acknowledgment must link a saved proposal. Failed, expired, or incompletely filled actions return the incident to review.

Lessons require source decision IDs when written by an agent. Administrators can edit or retire them in the Lessons panel. Existing lessons without structured evidence are retained as retired observations until reviewed. Chat may consume at most 40% of the daily model request allocation; remaining capacity is reserved for trader reasoning. Raw equity charts never substitute for verified investment returns.

## Durable data and migration

`data/db/` holds the account as plain files:

| File | What it holds |
| --- | --- |
| `trade-settings.json` | The active strategy: `settings` (risk settings, watchlist) and `playbook` (the trader's instructions), always saved together |
| `settings.json` | Account information: the broker account this data belongs to |
| `state.json` | The app's temporary state: saved stops, pause switch, start-of-day equity and peak, pending alerts, daily AI usage |
| `journal.jsonl` | Every decision and why it was made, with its outcome |
| `fills.jsonl` | What the broker actually filled; the source for P&L |
| `actions.jsonl` | Every order or stop change, open or finished |
| `action-history.jsonl` | Each step of each action (created, approved, submitted, executed, …) |
| `action-dedup.jsonl` | Stops the same request from sending the same order twice |
| `alerts.jsonl` | Every alert and how it was handled |
| `requests.jsonl` | Each request to the AI, from you or the scheduler, and its answer |
| `transcripts.jsonl` | The full AI exchange for each request; chat history is read from here |
| `tool-calls.jsonl` | Each tool the AI called and its result, so nothing runs twice |
| `activity.jsonl` | The dashboard's activity feed |
| `lessons.jsonl` | Lessons the trader keeps across cycles |
| `operator-commands.jsonl`, `strategy-changes.jsonl`, `stop-requests.jsonl`, `notifications.jsonl`, `notifications-sent.jsonl` | Created when first needed |

A `.jsonl` line is `{"seq","id","at","value"}`; an update appends a new line for the same id, the last one wins, and older lines are dropped when the app next starts. Run one engine per account data directory. Terminal and web clients connect to that engine.

Invalid JSON in `db/` stops startup; it never resets the account to an empty state. On first start `data/` is bound to the connected broker account, saved in `db/settings.json`. Startup refuses a different broker, venue, or account, so paper and live records never mix. Startup errors remain visible after the terminal dashboard closes.

Historical bars, fundamentals, and sector files remain replaceable caches. Backtests write unique job directories under `data/jobs/`, avoiding shared date-named report files. Keep the whole data directory private. Every action, open or finished, is kept in `db/actions.jsonl`; each step is in `db/action-history.jsonl` and is paginated through `/api/history/action-history?after=SEQ&limit=100`. The other history types are `journal`, `fills`, `operator-commands`, `strategy-changes` and `notifications`.

To back up, stop the app and copy `data/db/` somewhere safe.

IBKR only exposes recent executions through TWS. Missed historical executions need statement reconciliation. A normalized import is supported:

```sh
npm run import:fills -- account-fills.json
```

The JSON shape is `{ "accountId": "ibkr:paper:ACCOUNT", "fills": [...] }`. Each fill follows `src/broker/IBroker.ts`: `execId`, `orderId`, `permId`, `symbol`, `side`, `qty`, `price`, `fee` (null if unknown), and ISO `at`. Import validates the account and deduplicates fills/corrections. It does not convert a raw broker statement automatically.

## Operations

### Saved reviews in the web dashboard

Holdings and watchlist use compact, single-line rows. Select a ticker to open a centered details window: position figures and status at the top, price and volume chart in the middle, and tabs for Assessment, Entry thesis, Protection, Market context, and Research below it. Research sources expand individually. Opening the window loads its historical chart; **Refresh saved view** rereads existing records and the latest engine tick without requesting fresh research or reloading the chart. Unknown or stale coverage stays explicit; an intended stop is not a verified broker order.

**Ask trader to review** queues a task for that symbol. It can fetch research and save assessments, but its tool registry excludes trading, protection changes, event handling, and agent handoffs. Paused engines leave the task queued. Read its outcome through **Follow task**, then refresh the saved view when it finishes.

The Review tab calls agent requests **Agent tasks**. A task trail links saved tool inputs and outputs, journal decisions, action progress, confirmed fills, and related agent tasks. Observation and source text viewers have character pages and read saved content only. Lesson details show scope, supporting and counter decisions, sample counts, and review dates; these counts do not establish that a lesson improves returns.

These views reuse the existing tables. New assessment tasks have an optional `mode: review_only` field in their request record; no database migration is needed for these UI changes.

### Engine operations

- `/api/status` provides detailed health, pause state, account identity, and model usage. Missing holdings/orders are explicitly unavailable, never reported as a flat portfolio.
- `/api/feed` has durable cursors. SSE clients receive a reset event if their replay window is too large and must fetch the paginated feed. Slow streams close instead of accumulating memory.
- `AI_MAX_REQUESTS_PER_DAY` defaults to 300 per day (UTC). `AI_MAX_TOKENS` defaults to 4096 and `AI_MAX_TOOL_ROUNDS` to 10. Missing provider token usage is counted explicitly. The request budget still applies when a provider omits token counts. Protective execution continues if the AI budget is exhausted.
- `ALERT_WEBHOOK_URL` optionally enables HTTPS notification delivery for approvals, critical alerts, and uncertain outcomes. `ALERT_WEBHOOK_TOKEN` is an optional bearer credential for the receiver. Delivery retries durably; receivers deduplicate the stable `Idempotency-Key`. No destination is configured by default. Notification history is available at `/api/notifications`.
- SIGTERM stops intake and drains execution before closing storage. Requests have deadlines; shutdown has a final 25-second deadline. Broker-side orders remain at the venue across shutdown.

Measured closed-trade results use venue fills. Portfolio return, Sharpe, volatility, and drawdown are withheld when cash flows cannot be verified or are present in the window. Complete cash-flow-adjusted performance, taxes, corporate actions, and automatic statement reconciliation are outside the current accounting scope.

## Verification

```sh
npm run build
npm test
npm run verify:isolated
npx playwright install chromium
npm run test:browser
```

Tests use temporary account directories and fake broker credentials. The isolated replay blocks network requests. Browser checks cover approval, pause, reviewed settings, and mobile overflow; they use installed Chrome on macOS or Playwright Chromium elsewhere. No test places real trades.
