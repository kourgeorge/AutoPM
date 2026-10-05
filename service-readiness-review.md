**Implementation update — 3 October 2026**

The original findings below describe the pre-change system. The implementation now uses one worker per brokerage account, one durable execution queue, and one SQLite account store. This is a service foundation with operator-provisioned users; it is not a deployed public account-enrollment platform.

| Original findings | Resolution |
| --- | --- |
| 1–3: bookkeeping, fill semantics, repeat submission | Shared manual/automatic executor; durable claims and client IDs; explicit submitted/partial/unknown states; broker reconciliation; journal outcomes and filled baselines; no blind resubmission |
| 4–6: approvals, pause, account scope | Account/venue/revision/quantity/expiry binding, persisted pause, actual account identity, explicit IBKR account, worker lease and mutation checks |
| 7–8: saves, dependency stalls, health | SQLite transactions, strict legacy import, separate execution/protection loop, request deadlines, liveness/readiness split |
| 9–10: strategy ownership and rule enforcement | Account-pinned prose, atomic settings revisions, stale-save rejection, human activation, advisory lessons, platform ceilings, market/universe/price/asset guards |
| 11: externally owned holdings/orders | Explicit adoption; unsupported instruments excluded from management; external cancellations refused; incomplete protective pairs require inspection |
| 12–14: application, truthfulness, persistence | Browser dashboard, provisioned admin/operator/viewer users, revocable sessions, CSRF, role checks, visible broker states, unavailable holdings, durable feed/chat, bounded queues |
| 15: delivery | Durable notification history and optional HTTPS webhook outbox with retries and stable delivery identities; an actual receiver remains a deployment choice |
| 16–17: accounting and capabilities | Misleading unadjusted portfolio metrics withheld; wrong-broker history tool refused; explicit long-equity scope; account-validated historical fill import. Full accounting and broker acceptance testing remain |
| 18–19: cost and operations | Daily request budget and usage, model/context limits, unique per-account job directories, consistent backups/paused restore, reproducible dependency lockfile, non-root container, CI |

The simplified execution model deliberately stops on uncertain outcomes. It does not claim an effectively-once guarantee from a broker that cannot recover historical client references. IBKR historical gaps and interrupted order replacements may require broker inspection and statement import. A surviving protective leg is retained while discrepancies are reviewed.

Remaining launch work is deployment/account enrollment and routing, secret provisioning, receiver/backup monitoring, optional billing, and sandbox acceptance tests against the actual supported broker configurations. Multi-currency accounting, corporate actions, fully adjusted investment returns, MFA/self-service password recovery, and automated broker-statement conversion are not implemented. These limits should remain explicit in the service offering.

Validation: TypeScript build, isolated replay (275 checks), policy rendering, execution/recovery tests, API authorization tests, backup/budget tests, and a real browser workflow with fake account data. No real orders, production migrations, or deployment were performed during implementation.

---

**AutoTrade service readiness review — 3 October 2026**

Reviewed source at commit 47620af. Assumption: customers connect their own brokerage accounts, choose a strategy and its permissions, and use a hosted dashboard. A service that only publishes signals would need substantially less execution infrastructure.

The engine has useful foundations: a broker interface, deterministic risk checks and detectors, an approval state machine, a fills ledger, policy validation, a configurable data directory, and a headless HTTP API. The HTTP API explicitly anticipates one bot per user. That is a reasonable initial deployment direction, but the surrounding customer service is not implemented here.

The main blockers are reliable order execution, ownership of accounts and strategy rules, durable state, and a UI that distinguishes instructions from confirmed results. Connecting a website to the existing endpoints would expose several incorrect or ambiguous behaviors to customers.

P0 below means resolve before customer live trading. P1 means resolve for a credible customer beta or deliberately exclude the affected feature.

**1. P0 — Approved trades bypass essential bookkeeping**

The proposal executor calls actEntry or actExit directly. Entry journal records, position baselines, and stop/target IDs are written in toolExecuteEntry, after its automatic execution branch. The pending branch returns before those writes. The later approval never returns through that wrapper.

An isolated probe submitted an approved entry through the real proposal executor and actEntry, with synthetic validation and broker responses. It ended as executed with zero journal records and no position snapshot. An immediately armed broker OCO may still exist, but its ownership is not recorded; if arming fails, the sweep lacks the stop baseline it needs to repair protection. Approved exits similarly miss their exit decision and immediate snapshot cleanup.

Move execution bookkeeping into one shared application operation used by both automatic and approved actions. Keep the AI tool and HTTP layers as adapters. Record proposal, decision, order, fills, and position links consistently.

Evidence: [proposalExecutor.ts](/Users/georgekour/repositories/autotrade/src/strategy/proposalExecutor.ts:25), [orderManager.ts](/Users/georgekour/repositories/autotrade/src/strategy/orderManager.ts:466), [traderTools.ts](/Users/georgekour/repositories/autotrade/src/tools/traderTools.ts:1225).

**2. P0 — Submission, acceptance, and filling are treated as the same outcome**

actEntry and actExit return executed after order submission. The entry's returned quantity is the submitted quantity, despite the tool naming it filledQty. The automatic full-exit path removes position baselines using requested sale quantity without confirming fills. A probe left the synthetic broker position open after accepting a sell; the tool returned success and removed its snapshot.

This matters especially for queued orders outside market hours, partial fills, and asynchronous IBKR rejections. The IBKR adapter explicitly acknowledges that its placement promise resolves when sent to TWS, with later errors only logged. A pending exit can leave shares held after their protection was cancelled and their local baseline removed.

Introduce durable order states: submitting, submitted, accepted, partially filled, filled, cancelled, rejected, and outcome unknown. Base position changes on broker fills. Preserve recovery information until the final outcome is known.

Evidence: [orderManager.ts](/Users/georgekour/repositories/autotrade/src/strategy/orderManager.ts:468), [exit bookkeeping](/Users/georgekour/repositories/autotrade/src/tools/traderTools.ts:1349), [IBKRBroker.ts](/Users/georgekour/repositories/autotrade/src/broker/IBKRBroker.ts:130).

**3. P0 — Trading is not recoverable with effectively-once execution**

OrderRequest has no client idempotency key. Alpaca placement does not send client_order_id. Proposals move directly from approved to executed after side effects, with no durable execution claim or submitting state. A crash after broker acceptance but before the local transition leaves an approved proposal eligible for another attempt. The position check can reject some repeats once the fill is visible; it does not resolve an outstanding, unfilled buy or an ambiguous network timeout.

There is also no account-wide reservation for pending entry notional or position slots. Stops have a per-symbol in-process lock, but entry validation and submission are not serialized across the AI loop and proposal sweep. Two workers against the same account would amplify this.

Persist order intent before submission, use broker client identifiers where supported, reconcile unknown outcomes before retrying, reserve pending exposure, and enforce one active execution owner per broker account. A network timeout must not automatically mean the broker rejected the order.

Evidence: [IBroker.ts](/Users/georgekour/repositories/autotrade/src/broker/IBroker.ts:25), [AlpacaBroker.ts](/Users/georgekour/repositories/autotrade/src/broker/AlpacaBroker.ts:96), [proposal state transitions](/Users/georgekour/repositories/autotrade/src/core/proposals.ts:23).

**4. P0 — An approval does not bind a sufficiently precise trading mandate**

Proposals contain paper/live but no customer ID, broker account ID, strategy revision, approval actor ID, or execution price tolerance. The executor never compares the proposal's venue with the configured venue. A probe executed a live-labelled proposal in a paper-configured worker.

decideProposal does not check the deadline; expiry happens only during a scheduler sweep. A probe approved a proposal after its deadline. Already-approved proposals have no execution deadline, and their execution uses current policy rather than a pinned approval revision. Timeout handling also reads the current global onTimeout setting, so changing policy can alter what happens to proposals created earlier.

Bind approvals to an account, instrument, side, maximum quantity/notional, acceptable price range, strategy revision, expiry, and identified actor. Revalidate those terms atomically at execution. Material changes should supersede the proposal. Deduplicate equivalent pending intents in code; the current prohibition on resubmission is only prompt guidance.

Evidence: [Proposal fields](/Users/georgekour/repositories/autotrade/src/state/state.ts:95), [decideProposal](/Users/georgekour/repositories/autotrade/src/core/proposals.ts:127), [sweepProposals](/Users/georgekour/repositories/autotrade/src/strategy/proposalExecutor.ts:81).

**5. P0 — Pause is not a durable trading stop**

Trader.pause stops new AI cycles. It allows the current cycle to finish, does not stop the scheduler's proposal executor, and is not persisted. A probe executed an approved proposal while the trader reported paused; a new Trader instance started unpaused.

The distinction is documented internally, but a customer pressing “Pause trading” will usually expect new orders to stop. The concierge prompt also routes “stop trading” through an AI instruction rather than the deterministic pause command.

Define separate controls for pausing new entries, pausing AI decisions, cancelling pending bot orders, and emergency liquidation. Persist the selected mode and enforce it at the execution boundary. State what happens to existing broker stops. On restart, restore the mode before permitting orders.

Evidence: [Trader.pause](/Users/georgekour/repositories/autotrade/src/agents/trader.ts:70), [scheduler execution](/Users/georgekour/repositories/autotrade/src/features/scheduler.ts:237), [concierge guidance](/Users/georgekour/repositories/autotrade/src/agents/concierge.ts:156).

**6. P0 — Account identity and isolation need to become explicit**

Config, broker, policy, state, caches, and UI are module-level singletons. DATA_DIR is process-wide and intentionally does not change with broker or paper/live mode. Reusing a directory after changing credentials can carry old proposals, baselines, lessons, and performance history into another account. Financial records generally lack account and broker identity; snapshots are keyed by symbol.

IBKR has an additional concrete problem: account summary can fall back to the first available account, positions iterate all accounts, open orders request all accounts, and new order objects do not explicitly set the configured account. Configuring IBKR_ACCOUNT is therefore not a consistent isolation boundary.

For an initial service, use one isolated worker per connected broker account, with its own credentials and durable store. Still stamp records with customer/account/broker/venue IDs and refuse account mismatches at boot. Fix IBKR account filtering and explicit order routing before supporting multi-account gateways. Use a broker instrument identifier where symbol alone is ambiguous.

Evidence: [paths.ts](/Users/georgekour/repositories/autotrade/src/core/paths.ts:15), [broker singleton](/Users/georgekour/repositories/autotrade/src/broker/index.ts:6), [IBKR account handling](/Users/georgekour/repositories/autotrade/src/broker/IBKRBroker.ts:148).

**7. P0 — File saving is crash-conscious, but not transactionally durable**

Atomic rename protects whole JSON files from truncation, which is useful. However:

- State changes wait up to five seconds before saving.
- Shutdown exits immediately or after at most two seconds of API cleanup, without flushing state or draining trading work.
- State save errors are swallowed; unreadable state silently falls back to defaults.
- Journal, proposal history, fills, and state are separate writes without a common transaction or recovery protocol.
- There is no account writer lock, state schema migration system, or backup/restore verification workflow.
- Journal and fills reads scan whole files synchronously. Historical growth eventually affects the same event loop that serves the API and runs trading.

Use transactional storage for mandates, proposals, orders, fills, and critical state. SQLite with durable volumes and one writer per worker is a viable small-service starting point; PostgreSQL is another option. Keep append-only exports and human-readable lessons if useful, but do not make their successful writing the only recovery mechanism. Detect corrupt storage and enter a visible recovery state; prevent new risk until reconciliation succeeds.

Classify data by lifecycle: financial/audit records, user configuration, conversations, regenerable market caches, and generated reports. Give each separate backup, retention, deletion/export, and access rules. DATA_DIR and gitignore are deployment conveniences, not customer isolation.

Evidence: [state persistence](/Users/georgekour/repositories/autotrade/src/state/state.ts:269), [shutdown](/Users/georgekour/repositories/autotrade/src/daemon.ts:168), [journal persistence](/Users/georgekour/repositories/autotrade/src/journal/journal.ts:49).

**8. P0 — Slow dependencies can stall protection while health stays green**

The common Alpaca Axios client has no explicit request timeout. The compatible-model fetch path has no explicit abort deadline. A scheduler tick waits for collection and reconciliation before reaching stop repair and proposal execution, and the next tick is armed only after the previous one settles. An indefinitely pending request can therefore stop future sweeps.

/health always returns ok: true with a timestamp, without checking its age, broker connectivity, storage health, reconciliation lag, or control availability. API startup errors are logged while the bot continues.

Add bounded request deadlines, retry policies that distinguish reads from ambiguous order writes, and readiness checks for trading dependencies. Separate urgent protection/recovery work from research and reporting latency. Track last successful collection, reconciliation, order update, and durable write. Make deployment supervisors act on readiness, not only process liveness.

Evidence: [Alpaca client](/Users/georgekour/repositories/autotrade/src/core/alpacaHttp.ts:44), [model request](/Users/georgekour/repositories/autotrade/src/core/modelProvider.ts:264), [health endpoint](/Users/georgekour/repositories/autotrade/src/server/api.ts:196).

**9. P1 — Playbook, settings, lessons, and platform rules need separate ownership**

The current behavior has three moving sources: shared policy/PLAYBOOK.md, one mutable YAML per data directory, and AI-written LESSONS.md. There is no playbook catalog, ownership, draft/published lifecycle, per-bot revision pinning, or upgrade acceptance. Deploying a new shared PLAYBOOK changes every worker that runs the new code, even when its YAML version stays unchanged.

The YAML's immutable ceilings live inside that same editable YAML. The concierge mutation API protects them, but they are not independent platform rules if customer YAML import/editing is introduced. A decision records the YAML version, not the full strategy content hash, prompt revision, lesson set, model version, or engine version.

Lessons are described as binding and automatically injected; only the last 20 are included. Effective strategy behavior can change without a policy revision, and an older standing lesson can disappear from context simply because more lessons were appended. There is no supported customer workflow to approve, retire, or supersede a lesson.

Use these distinct objects:

| Object | Owner and lifecycle |
|---|---|
| Platform safety policy | Service-owned; customer settings cannot exceed it |
| Playbook template | Named, published revisions with supported assets and behavior |
| Customer strategy | A pinned template revision plus validated customer settings |
| Trading mandate | Account, capital allocation, allowed assets, automation permissions |
| Learned suggestions | Evidence-backed proposals; explicit activation/supersession |
| Decision context | Exact effective revisions and data provenance used for an action |

Treat a template update as a migration with a reviewable diff. Existing customers should stay pinned until the defined upgrade process applies. Expose the effective configuration and its history through structured APIs.

Evidence: [policy paths](/Users/georgekour/repositories/autotrade/src/policy/load.ts:39), [policy mutation](/Users/georgekour/repositories/autotrade/src/policy/mutate.ts:121), [decision version](/Users/georgekour/repositories/autotrade/src/journal/journal.ts:135), [binding lessons](/Users/georgekour/repositories/autotrade/src/agents/trader.ts:759).

**10. P1 — Some displayed rules are preferences, while others are enforced limits**

The production entry guard enforces several valuable checks, including size, exposure, signal strength, earnings blackout, and daily loss. But it does not enforce every policy-looking concept:

- The watchlist guides scanning; it is not an allowed-instruments restriction.
- Sector/single-name concentration thresholds drive warnings rather than entry vetoes.
- Stop ATR settings do not enforce a maximum submitted stop distance.
- “No entries while market closed” is prompt guidance, not an entry guard.
- “Halt entries for the rest of the day” is not latched: dailyLossStatus becomes ok again if equity recovers above the threshold.
- Sizing checks use the price supplied in the intent. Revalidation refreshes account and signals, but does not replace that price with an executable current quote or bind it to a maximum slippage.

The YAML also mixes fractions and percentage points under similarly named Pct fields. Regime overrides are parsed less strictly than other numeric settings. Raw file edits are not automatically watched: reloadPolicy is called by the mutation path, but there is no general file watcher. A file can show a different configuration from the one the process has cached.

Explicitly classify each rule as an enforced limit, alert threshold, or strategy preference. Normalize API units, validate schemas and relationships, make saving and activation distinct, and show the active revision. Risk-reducing actions need deliberate semantics independent of an LLM's interpretation.

Evidence: [entry validation](/Users/georgekour/repositories/autotrade/src/strategy/orderManager.ts:342), [daily loss calculation](/Users/georgekour/repositories/autotrade/src/strategy/riskManager.ts:45), [regime parsing](/Users/georgekour/repositories/autotrade/src/policy/load.ts:253), [reload path](/Users/georgekour/repositories/autotrade/src/policy/mutate.ts:148).

**11. P0 — The bot assumes it may manage the whole connected account**

Live holdings are included regardless of watchlist membership. The playbook directs the AI to annotate unprotected inherited positions. Exiting a symbol cancels every resting sell for that symbol, including orders placed manually or by another system.

A customer connecting an existing investment account may not be authorizing management of every holding. Multiple playbooks in the same account also need allocation and order ownership; symbol-level state cannot express competing strategies holding the same asset.

For the first version, either require a dedicated trading account or implement explicit adoption of holdings and an allocated capital mandate. Identify bot-owned orders. Preview the scope of cancellation and management before activation. If multiple strategies share an account later, use one account execution coordinator.

Evidence: [collection scope](/Users/georgekour/repositories/autotrade/src/collect/index.ts:52), [inherited-position instruction](/Users/georgekour/repositories/autotrade/policy/PLAYBOOK.md:30), [exit cancellation](/Users/georgekour/repositories/autotrade/src/strategy/orderManager.ts:744).

**12. P1 — The API is an internal operator adapter, not yet a customer application**

The current API has a useful bearer token check, minimum token length, body size limit, exact configured CORS origin, and localhost binding by default. It has one credential with all operator powers. There are no customer accounts, account ownership checks, viewer/operator roles, invitation/recovery flows, billing entitlements, or per-person audit identity in this repository.

A browser should reach an authenticated service backend that resolves the user's authorized worker and keeps the worker token private. Do not give all customers direct access to a shared token or allow a browser-supplied worker address to select the account. Add read and write authorization, rate limits, credential rotation, and an audited support-access path.

There is no browser frontend in the reviewed source. HeadlessUI exposes terminal-shaped state and text; charts remain fixed-width ASCII. Policy changes are largely conversational, while the explicit policy/playbook commands return prose or raw YAML.

Recommended first views:

| View | Customer questions it should answer |
|---|---|
| Overview | Which account and paper/live mode? Is trading active? Are data and protection healthy? |
| Approvals | What exactly changes, at what maximum cost, until when, and what happens without an answer? |
| Positions and orders | What is filled versus pending? Which stops really rest at the broker? Who owns each order? |
| Strategy | Which playbook revision and settings are active? What changed? Which lessons are enabled? |
| Activity and performance | Why was an action proposed or rejected? What actually filled? What is strategy performance? |

Chat can support these workflows. Critical settings and trading controls should also be usable and inspectable without a model call.

Evidence: [API authorization design](/Users/georgekour/repositories/autotrade/src/server/api.ts:17), [route surface](/Users/georgekour/repositories/autotrade/src/server/api.ts:183), [headless charts](/Users/georgekour/repositories/autotrade/src/ui/headless.ts:28).

**13. P1 — The view can report a successful or empty state that is not true**

When position collection is unusable, computeTick substitutes an empty list. The API then returns no positions and a count of zero. Account collection can still be healthy, and the derived schema does not preserve a separate positions-collection error. Customers can see an apparently flat account during a holdings outage.

The tool log also summarizes any execute_entry/execute_exit result with ok: true as entered/exited. Pending approval results use ok: true too, so the visible feed can claim a trade happened while it is awaiting approval.

Expose independently timestamped account, position, order, price, and protection snapshots, with explicit unavailable/stale states. Preserve last-known holdings with their age when useful. Use structured action status to render proposed, awaiting approval, submitted, filled, or failed. Show local desired stops separately from broker-confirmed orders.

Evidence: [empty holdings fallback](/Users/georgekour/repositories/autotrade/src/features/compute.ts:436), [positions API](/Users/georgekour/repositories/autotrade/src/server/api.ts:220), [trade log summaries](/Users/georgekour/repositories/autotrade/src/core/logger.ts:96).

**14. P1 — Chat and live updates do not survive normal service operation**

Concierge history and its message queue live only in memory. History grows without compaction or a token budget. HeadlessUI retains 2,000 feed entries and resets its sequence to 1 at restart. The API's resume cursor has no stream generation ID or gap signal.

A probe resumed with cursor 2 against a restarted feed whose new message had sequence 1; it received no entries. SSE clients can receive future live events after subscribing, but missed history across restarts is not recovered, and polling clients can appear silent until the counter catches up. Native browser EventSource also cannot directly set the required bearer header; use the authenticated backend stream or a compatible fetch-based client.

Persist customer conversations and durable activity separately from operational logs. Add message IDs, delivery/processing status, cancellation or queue limits, bounded context, stable event cursors, and explicit resync behavior. Apply stream connection limits and backpressure handling.

Evidence: [concierge storage](/Users/georgekour/repositories/autotrade/src/agents/concierge.ts:183), [feed sequence](/Users/georgekour/repositories/autotrade/src/ui/headless.ts:67), [SSE resume](/Users/georgekour/repositories/autotrade/src/server/api.ts:319).

**15. P1 — Approval and alert delivery assume the user is watching**

Runtime alerts go to the UI/feed and concierge history. There is no integrated durable notification delivery pipeline with retries and acknowledgments. The default policy requires manual entry and exit approval and denies unanswered proposals after ten minutes, while stop and target adjustments are automatic.

This means closing the browser can cause a needed exit proposal to expire. Existing broker stops can still trigger, but unsupported or failed protection needs a separate response. “Manual trading” also needs to explain automatic stop/target execution and adjustment; customers should not discover the distinction through a sale.

Offer an explicit autonomy profile with clear unattended behavior. Add an in-app inbox and selected email/push delivery, deduplication, retries, and escalation. Emergency protection rules should have an agreed deterministic policy rather than depending on a user reading chat.

Evidence: [alert delivery](/Users/georgekour/repositories/autotrade/src/agents/concierge.ts:218), [default automation](/Users/georgekour/repositories/autotrade/policy/default.yaml:119).

**16. P1 — Performance needs customer-accounting semantics**

The fills ledger and closed-trade scorecard are useful, and the benchmark already reports caveats. However, the benchmark uses unadjusted account equity. Deposits and withdrawals therefore appear in return and drawdown statistics; these are not suitable as an unqualified headline strategy return. Total account results also include customer activity outside the bot.

IBKR equity history is unavailable through the benchmark interface. Its execution catch-up uses the TWS execution window, which cannot recover a whole missed prior session through the implemented path. There is no statement-import fallback. Separately, the generic get_portfolio_history tool always calls Alpaca even when the active broker is IBKR, so an IBKR conversation can retrieve a different account's history.

Maintain account cash flows, valuations, fees, corporate-action adjustments, and strategy attribution. Show cash-flow-adjusted returns and clearly distinguish realized, unrealized, gross, and net results. Expose incomplete-history status. Route all account-specific tools through the selected account's broker capabilities.

Evidence: [benchmark flow caveats](/Users/georgekour/repositories/autotrade/src/review/benchmark.ts:321), [IBKR recovery limitation](/Users/georgekour/repositories/autotrade/src/review/reconcile.ts:55), [Alpaca-only history tool](/Users/georgekour/repositories/autotrade/src/tools/alpacaDataTools.ts:236).

**17. P1 — Broker and market-data capability differences need a product boundary**

IBKR requires a reachable TWS/Gateway session and its lifecycle. Switching execution broker does not switch market data: Alpaca credentials are still used, with Yahoo fallbacks. Crypto cannot use the implemented plain-stop protection; partial exits require whole quantities, and IBKR new contracts are hardcoded as USD stocks on SMART. Much of the engine assumes US equity sessions and USD.

Choose supported account, asset, order, currency, and session combinations explicitly. Make connection setup test permissions and actual account identity, and advertise unavailable capabilities in the UI. Restrict unsupported combinations until implemented. Commercial market-data display/redistribution rights and broker integration terms need verification for the chosen service model; this review did not establish those entitlements.

Evidence: [broker/data split](/Users/georgekour/repositories/autotrade/src/core/config.ts:39), [IBKR contract construction](/Users/georgekour/repositories/autotrade/src/broker/IBKRBroker.ts:218), [partial exit validation](/Users/georgekour/repositories/autotrade/src/strategy/orderManager.ts:697).

**18. P1 — Per-customer costs and resource limits are missing**

Each worker collects data for its own watchlist every tick, including per-symbol bar requests. More users duplicate much of the same research and market-data load. There are no per-customer request budgets or durable usage meters. Concierge messages can queue without a bound, and each new model turn carries the growing history.

The configuration exposes AI_MAX_TOOL_ROUNDS and AI_MAX_TOKENS, but the live Trader uses fixed limits of 30 rounds and 4,096 output tokens; Concierge uses 8 rounds and 1,024. The configuration therefore cannot currently control these live-agent costs as an operator may expect.

Meter model/data usage by customer and activity, cap queues and expensive jobs, and wire the declared limits into execution. Share public market data where licensing and entitlements permit; keep private account data isolated. Separate backtests from live trading resource budgets.

Evidence: [collection fan-out](/Users/georgekour/repositories/autotrade/src/collect/index.ts:64), [Trader limits](/Users/georgekour/repositories/autotrade/src/agents/trader.ts:26), [Trader request](/Users/georgekour/repositories/autotrade/src/agents/trader.ts:216), [Concierge loop](/Users/georgekour/repositories/autotrade/src/agents/concierge.ts:234).

**19. P1 — Deployment, secrets, and saved research need a service lifecycle**

The repository has no committed service deployment manifests or CI workflow, and package-lock.json is ignored rather than tracked. Building TypeScript alone does not package the default YAML and PLAYBOOK files, which are resolved from the working directory. A dist-only deployment would miss required runtime assets.

Broker and model credentials come from process environment. There is no customer credential enrollment, revocation/rotation workflow, or secret-store integration. Repository history also records an earlier credential-bearing local settings file being untracked; ignoring it later does not establish that its token was revoked. Revocation status was not checked in this review, and no secret values were inspected.

Backtest output files use working-directory paths and filenames based on dates or modes. Two jobs with the same parameters can overwrite reports; there is no job ownership, immutable result ID, queue, or customer download authorization. Backtest behavior also differs from live operation: the baseline omits live earnings/regime inputs, and AI backtests use a separate prompt. These results should identify exactly what was simulated.

Package a reproducible worker image including policy assets and a committed dependency lock. Add deployment drain/recovery checks, storage migrations, backup restoration tests, and release metadata. Store secrets through a restricted credential service. Store generated artifacts under account/job IDs with immutable configuration and engine/model metadata.

Evidence: [package scripts](/Users/georgekour/repositories/autotrade/package.json:6), [runtime asset paths](/Users/georgekour/repositories/autotrade/src/policy/load.ts:39), [backtest output](/Users/georgekour/repositories/autotrade/src/scripts/backtestAi.ts:65), [simulation scope](/Users/georgekour/repositories/autotrade/src/backtest/engine.ts:1), [.gitignore](/Users/georgekour/repositories/autotrade/.gitignore).

**Recommended initial service structure**

Keep the existing engine inside an isolated worker per connected brokerage account. Add an authenticated application backend for users, account ownership, credentials, subscriptions, strategy revisions, and worker lifecycle. The dashboard communicates through that backend. A customer can have several accounts without the engine needing multiple accounts in one process.

Give each worker transactional trading state and a single execution owner. Publish structured activity to a durable customer-facing store so dashboards and notifications remain useful when a worker restarts or is offline. Keep account-bound financial records separate from shared public data and generated research artifacts.

Use a small explicit domain model: User, BrokerConnection, TradingAccount, PlaybookRevision, StrategyInstance, TradingMandate, Proposal, OrderIntent, BrokerOrder, Fill, Position, PolicyChange, Notification, and BacktestRun. A strategy instance is a customer's configured use of a playbook; an account owns execution.

Start the first beta with paper trading, one supported broker, USD long-only equities, a small curated playbook catalog, and one strategy instance per account. Add capabilities after their recovery, accounting, and permission semantics are implemented.

Resolve the commercial operating model before promising live automation: software executing explicit customer instructions and a service making discretionary trading decisions can imply different obligations depending on jurisdiction. This affects the actual product design—mandates, disclosures, records, and onboarding—and needs jurisdiction-specific review.

**Suggested implementation order**

1. Unify trade execution/bookkeeping; implement order lifecycle, idempotency, account binding, durable pause, and approval validity.
2. Introduce transactional persistence, startup reconciliation, graceful shutdown, request deadlines, and readiness monitoring.
3. Define playbook revisions, platform limits, customer mandates, and explicit ownership of existing holdings.
4. Build authentication/account onboarding and the five dashboard views, with reliable activity and notifications.
5. Add cash-flow-aware performance, usage/billing limits, reproducible deployment, and artifact/job management.
6. Validate recovery and account isolation under fault injection before a limited live rollout.

The most valuable next tests are restart immediately after broker acceptance, partial fill followed by disconnect, duplicate approval/request delivery, two workers starting on one account, failed durable writes, changed policy while approval is pending, expired approval, and a holdings outage with healthy account data.

**Verification and limits**

- TypeScript no-emit check passed.
- Existing replay harness passed all 275 checks using a temporary data directory and placeholder credentials.
- Existing policy-render check passed against the shipped default.
- Six isolated probes reproduced: missing manual-entry bookkeeping; approval after expiry; execution with mismatched proposal venue; execution while paused plus pause reset; broken historical feed resume after restart; and baseline removal after an accepted but unfilled exit.
- Probes used synthetic broker responses and a network-blocking guard. Entry validation was stubbed for the execution-path probes. These establish application control-flow behavior, not real-broker fill guarantees.
- No daemon was started, no real orders were submitted, and no application behavior was changed. Authentication providers, hosting infrastructure, broker commercial agreements, credential revocation, and jurisdictional obligations were not externally audited.
