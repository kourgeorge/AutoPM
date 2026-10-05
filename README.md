# AutoTrade

An account-scoped trading worker with a browser dashboard, a deterministic execution queue, and an AI research agent. It supports Alpaca and Interactive Brokers; automated entries are restricted to whole-share long equities during regular market hours.

## Run locally

Requires Node 22.13 or newer. Each brokerage account needs its own worker, credentials, persistent `DATA_DIR`, and URL. Users provisioned within that worker share access to that account. Do not connect two independent workers or data directories to the same brokerage account.

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
DATA_DIR=./data
HEADLESS=1
API_PUBLIC_ORIGIN=http://127.0.0.1:8787
```

Provision a dashboard administrator, then start the worker:

```sh
npm run user -- alice admin
npm run start:headless
```

The user command prints a generated password once. Store it securely. Alternatively, supply `AUTOTRADE_USER_PASSWORD` through the environment. Open `http://127.0.0.1:8787` and sign in. Initial entries and exits require approval. The application does not accept public self-registration.

For Interactive Brokers, also set `BROKER=ibkr`, `IBKR_HOST`, `IBKR_PORT`, `IBKR_CLIENT_ID`, and **`IBKR_ACCOUNT`**. Account selection is explicit. Market data still uses the configured Alpaca/Yahoo collectors. USD stock contracts are the supported trading instruments; other holdings are displayed with distinct instrument identities and cannot be adopted for automated trading.

## Users and controls

| Role | Access |
| --- | --- |
| Viewer | Account, holdings, orders, strategy, and activity |
| Operator | Viewer access, chat, approvals, pause/resume, and reconciliation |
| Administrator | Operator access, strategy saves, holding adoption, and protection recovery |

```sh
npm run user -- analyst viewer
npm run user -- trader operator
npm run user -- alice disable
```

Reprovisioning a user changes their password/role and revokes old sessions. Browser authentication uses HttpOnly, SameSite cookies with CSRF checks. HTTPS origins receive Secure cookies. Sessions expire after 12 hours. All authorized users in a worker can read its shared chat and account history.

`API_TOKEN` is an optional service administrator credential, and `API_VIEWER_TOKEN` is an optional read-only service credential. Each must have at least 24 characters. Keep them on servers; the dashboard does not store bearer tokens in browser storage.

## Trading lifecycle

All entry, exit, and adjustment tools create durable actions. Automatic actions start approved; manual actions wait for an authorized user. One executor validates and claims the action before contacting the broker.

`pending → approved → executing → submitted / partial → executed`

Rejection, failure, expiry, and an unknown broker outcome are explicit states. Submission means an order was sent; filled quantity comes from the broker. Position baselines are recorded from fills. Exit baselines remain until the broker outcome and holdings confirm the close.

Approvals bind the account, venue, full strategy revision, quantity, and expiry. The executor rechecks these after network waits. Manual approvals always expire unanswered; `onTimeout: allow` is rejected. A price move above 1% requires a fresh entry proposal. Entries use a cent-priced IOC limit that caps spend, and risk checks include outstanding orders.

A stable client order ID supports recovery after a connection failure or restart. An uncertain request is never automatically submitted again. Unknown outcomes pause the account and block subsequent trading actions. Use **Check broker outcomes** after restoring connectivity. If the broker cannot establish the outcome, inspect its order/fill history; keep the account paused until the discrepancy is resolved. There is intentionally no blind “retry trade” button.

Pause is saved immediately and blocks new queued actions. Broker orders already accepted remain active. Protection checks continue independently of AI research and market-data collection. Missing protective legs are reported for inspection; the worker does not cancel an external order or tear down a surviving protective leg to rebuild a pair.

Existing holdings start unmanaged unless they have a legacy management record. An administrator can explicitly adopt a supported holding with a stop and optional target. Existing broker orders must be reviewed first. Interrupted protection can be relinked through the recovery form, which checks actual broker prices, quantities, and linked order IDs.

## Strategy and playbook ownership

The account owns a saved revision consisting of structured settings and a pinned playbook. **Review and save** activates both atomically and records the previous revision. Stale saves are rejected so one user cannot overwrite another's changes.

`policy/default.yaml` and `policy/PLAYBOOK.md` seed new accounts. Application upgrades do not silently replace an existing account's playbook. Model-written lessons are advisory. Chat suggests settings; it cannot activate a strategy or approve a trade. Platform ceilings and execution constraints remain enforced in code even if the playbook text changes.

The dashboard's **Risk profile** control offers Conservative, Balanced, Aggressive and Custom. Presets fill explicit numeric policy settings; editing one of those values makes the profile Custom. Saving creates the usual account strategy revision and invalidates older approvals. New accounts start Balanced; existing accounts retain their limits and leave new controls unconfigured until the user saves them.

Ask the concierge **“Explain my strategy settings”** for a plain-language overview of the saved profile, risk controls, investment limits, allowed symbols and human approvals. Its read-only `get_strategy_settings` tool reads the current account revision and supplies percentages with consistent units, including explicit “Not configured” labels. Risk-profile changes suggested in chat remain suggestions; review and save the values in Strategy settings to activate them.

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

`get_watchlist_scan` adds portfolio risk fit and ranks feasible candidates by signal strength discounted for incremental volatility. `get_entry_plan` sizes a supported stop/target setup using current equity, buying power, concentration and risk at the IOC entry limit. Execution rechecks the actual permitted quantity, including the approved maximum and regime reduction. Stops and volatility targets are estimates: gaps, slippage and fees can exceed the planned loss, and a high reward:risk ratio alone does not imply positive expectancy.

Portfolio volatility uses sample covariance from up to 60 completed daily return intervals, at least 30 aligned observations, annualized over 252 sessions; cash contributes zero modeled volatility. The engine aligns both endpoints of each interval and requires history through the last completed exchange session. Volatility targeting currently requires authenticated Alpaca calendar access even when orders route through IBKR. Missing calendar data or missing/stale required history blocks new entries. Unknown sectors conservatively count toward the largest possible overlap, including ETFs whose constituents are not modeled. Saving a tighter profile affects future entries; it does not automatically liquidate existing holdings. Backtests reuse the sizing engine with past-only data and conservatively unknown sectors; targetless exit modes disclose that their mechanical reward:risk cannot be evaluated.

After migration, editing the old YAML or Markdown files does not activate changes. Use the dashboard's Strategy settings. The saved account revision is authoritative.

## Agent behavior and audit trail

Trader and concierge use the same bounded turn runner. Tool permissions and input schemas are checked before dispatch. Requests, model turns, tool attempts, and mutation receipts survive restarts; resumed calls use their saved identities. Pausing or stopping interrupts reasoning, while the separate execution loop continues reconciling broker orders and protection. A failed or truncated turn is reported as incomplete, with any already-created actions still visible.

The Requests panel shows the initiating user, request status, and linked action outcomes. Chat also returns a request ID. Journals distinguish requested quantity, filled quantity, and verified protection; entry intent and the original thesis are retained when later management decisions change stops. Critical incidents remain open after observation, and an acting acknowledgment must link a saved proposal. Failed, expired, or incompletely filled actions return the incident to review.

Lessons require source decision IDs when written by an agent. Administrators can edit or retire them in the Lessons panel. Existing lessons without structured evidence are retained as retired observations until reviewed. Chat may consume at most 40% of the daily model request allocation; remaining capacity is reserved for trader reasoning. Raw equity charts never substitute for verified investment returns.

## Durable data and migration

`DATA_DIR/autotrade.sqlite` contains account state, actions, their audit trail, fills, current journal outcomes, strategy revisions, advisory lessons, conversation, sessions, feed cursors, usage, and notification delivery state. Writes commit synchronously with WAL and FULL synchronization. Trading claims and their audit writes share transactions.

Legacy `state.json`, financial JSONL files, `LESSONS.md`, and policy files are imported once without deleting the originals. Invalid JSON stops import; it never resets the account to an empty state. A legacy directory with positions/actions requires **`ACCOUNT_ID`** to match the actual broker account before it can be bound. For Alpaca this is the account UUID returned by `/v2/account`, not the account number. A bound directory cannot be reused for a different broker, venue, or account.

If startup exits with “Legacy data has no account identity,” confirm that the saved positions/actions belong to the connected account, add the exact `ACCOUNT_ID=…` shown in the error to `.env` (or the service environment), and restart. This check runs before trading starts. Startup errors remain visible after the terminal dashboard closes. Use a different `DATA_DIR` if the old records belong to another account.

Historical bars, fundamentals, and sector files remain replaceable caches. Backtests write unique job directories under `DATA_DIR/jobs/`, avoiding shared date-named report files. Keep the whole data directory private. The active state keeps all open actions and the latest 500 closed actions; the complete transition history remains in SQLite and is paginated through `/api/history/proposal?after=SEQ&limit=100`. Other history types include decision, fill, operator, strategy, and notification.

```sh
npm run backup -- create
npm run backup -- restore /secure/account-backup.sqlite /new/account-data
```

Backups use a consistent SQLite snapshot. Restore requires a new directory, verifies integrity/account identity, pauses trading, and discards browser sessions. Stop the original worker before starting the restored copy. Retain/export research job artifacts separately. Schedule backups and copy them to protected storage outside the worker's disk.

IBKR only exposes recent executions through TWS. Missed historical executions need statement reconciliation. A normalized import is supported:

```sh
npm run import:fills -- account-fills.json
```

The JSON shape is `{ "accountId": "ibkr:paper:ACCOUNT", "fills": [...] }`. Each fill follows `src/broker/IBroker.ts`: `execId`, `orderId`, `permId`, `symbol`, `side`, `qty`, `price`, `fee` (null if unknown), and ISO `at`. Import validates the account and deduplicates fills/corrections. It does not convert a raw broker statement automatically.

## Hosting and operations

The included Dockerfile packages compiled code, policy assets, and the dashboard, and runs as a non-root user. Mount a persistent volume at `/data` for each account. Provision users with `node dist/scripts/user.js` inside the image. Use `node dist/scripts/backup.js` for backups in a production image.

Put each worker behind an HTTPS reverse proxy and set `API_PUBLIC_ORIGIN` to its exact public origin. The container binds to `0.0.0.0:8787`; expose it only through that proxy. Use a deployment secret store for broker/model credentials. The deployment must ensure one worker per account: the SQLite lease coordinates processes sharing one database, not independent copies on different disks.

- `/health` reports process liveness. `/ready` reports 503 when execution, account data, holdings, protection, storage, or reconciliation is unhealthy. Use readiness to alert operators, not to restart an account repeatedly for a business-state discrepancy.
- `/api/status` provides detailed health, pause state, account identity, and model usage. Missing holdings/orders are explicitly unavailable, never reported as a flat portfolio.
- `/api/feed` has durable cursors. SSE clients receive a reset event if their replay window is too large and must fetch the paginated feed. Slow streams close instead of accumulating memory.
- `AI_MAX_REQUESTS_PER_DAY` defaults to 300 per account (UTC day). `AI_MAX_TOKENS` defaults to 4096 and `AI_MAX_TOOL_ROUNDS` to 10. Missing provider token usage is counted explicitly. The request budget still applies when a provider omits token counts. Protective execution continues if the AI budget is exhausted.
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

Tests use temporary account directories and fake broker credentials. The isolated replay blocks network requests. Browser checks cover login, approval, pause, reviewed settings, and mobile overflow; they use installed Chrome on macOS or Playwright Chromium elsewhere. No test places real trades.

This repository supplies an account worker and an operator-provisioned customer dashboard. A public service still needs deployment-level account enrollment/routing, billing if applicable, credential provisioning, delivery/backup monitoring, and paper-broker acceptance testing before live rollout. See [service-readiness-review.md](service-readiness-review.md) for the implementation assessment.
