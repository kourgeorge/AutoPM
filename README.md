# AutoTrade

An autonomous momentum trading daemon powered by an LLM. Three concurrent processes run at all times: a deterministic tick loop that watches the market, a sleeping LLM trader that wakes when something crosses (or when its own scheduled silence runs out), and a conversational concierge that lets the operator talk to the system.

Around that loop sit three layers whose whole purpose is that a conclusion outlives the cycle that drew it: the **journal** records what was decided, the **fills ledger and scorecard** measure what actually worked, and **LESSONS.md** holds what was concluded. The trader's context is rebuilt from scratch every cycle, so anything not written to one of those three is lost.

---

## How the agent works

### The three processes

```
┌─────────────────────────────────────────────────────────┐
│  FeatureScheduler  (deterministic, always running)      │
│  every N seconds:                                       │
│    collect prices + account + positions                 │
│    → compute EMA / RSI / ATR per symbol                 │
│    → run detectors (entry signal, stop breach, …)       │
│    → publish events → Router                            │
│  every 5 min (after routing):                           │
│    reconcile venue fills → round trips → review_ready   │
└──────────────────────────┬──────────────────────────────┘
                           │ events
              ┌────────────▼────────────────────────┐
              │              Router                 │
              │  coalesces events (1 of each/tick): │
              │  urgent/critical  →  wakeTrader()   │
              │  warn/critical    →  alertUser()    │
              └──────┬────────────────────┬─────────┘
                     │                    │
          ┌──────────▼──────────┐   ┌─────▼───────────────┐
          │       Trader        │   │     Concierge       │
          │     (LLM loop)      │◄──┤  (LLM, persistent   │
          │  sleeps until its   │   │   conversation)     │
          │  own sleep(minutes) │   │  send_to_trader()   │
          │  expires or a wake  │   │  wakes with a       │
          │  interrupts it      │   │  message            │
          └─────────────────────┘   └─────────────────────┘
```

### The tick loop (FeatureScheduler)

Runs continuously at a configurable interval. A tick never overlaps with the previous one — `setTimeout` is re-armed after the tick settles, never `setInterval`.

Each tick:
1. **Daily reset** — if the ET date has turned, snapshot `startOfDayEquity` from the broker
2. **Collect** — prices (Alpaca snapshots, with per-symbol Yahoo Finance fallback), OHLCV bars, account info, open positions from the broker
3. **Compute** — derive EMA(fast/slow), RSI, ATR, position P&L, drawdown from high, distance to stop
4. **Detect** — every detector evaluates the computed data against the active policy
5. **Publish** — hits that survive the gates land in the event registry and are handed to the Router
6. **Reconcile** — at most every 5 minutes, and *after* routing: pull venue fills into the ledger and publish `review_ready` if a round trip closed. Deliberately last, so a broker call can never delay a `critical` event by its own latency.

### The event registry and gates

Detectors report *levels*; the bus owns the *edges*. A level predicate on a 60s loop would fire every tick a position sits 2.1% down — a wake storm, not a signal. So each hit passes four gates, in order, per `cooldownKey`:

| Gate | Rule |
|---|---|
| **Edge** | Fire only on a `false → true` arming transition. Arming lives in `state.armedTriggers`, so a restart does not re-announce what the previous process already announced. |
| **Hysteresis** | Re-arming requires recrossing the threshold by `hysteresisPct`, not merely touching it from the other side. Kills boundary flutter. |
| **Cooldown** | Even a re-armed key stays quiet inside `defaultCooldownMs` (or the detector's own override). |
| **Escalation** | A `critical` that is still breaching and still unacked re-fires every `criticalCooldownMs` with `wakeCount++`. This stands in for auto-execution: ignore a stop breach and the wakes get louder. |

Two things bypass the gates on purpose:

- **The heartbeat** carries no crossing, so cooldown is its only gate (see below).
- **`publishDiscrete`** publishes a fact that is *already* an edge — `review_ready` is the only current user. There is nothing to recross, nothing to flutter, and running it through `processHits` would write a `cooldowns` entry per occurrence, an unbounded leak in `state.json`. **The caller owns dedup**; `review_ready` dedups on a watermark.

Passed events accumulate in an in-memory registry, capped at 100. The Trader reads and acknowledges them at cycle start with `get_pending_events` / `ack_event`. `info` events supersede their own predecessor rather than accumulating, so a night of heartbeats cannot bury a live `warn`.

### How the Trader gets woken

There are exactly three ways a cycle starts, and only one of them is a clock:

1. **Its own `sleep(minutes)` expires.** Every cycle must end with `sleep(minutes, reason)`. This is a *maximum silence*, not a polling interval — the guidance in POLICY.md is 60 min while the market is open, 240 while it is closed. If the model never calls `sleep`, the default is 10 min; after a cycle throws, the retry is 1 min.
2. **The Router wakes it** because a tick produced an `urgent` or `critical` event. The wake carries no payload — events travel via the registry and are read at cycle start, so N wakes and one wake produce an identical cycle. This is why the Router coalesces to **one** `wakeTrader()` per tick.
3. **The operator wakes it** through the Concierge's `send_to_trader(message)`. The message is queued and rendered under `=== OPERATOR INSTRUCTIONS ===` in the next cycle context.

At daemon startup the Trader runs one cycle immediately, before any sleep.

Severity decides who hears about an event, and nothing else does:

| Severity | Wakes Trader | Alerts operator | Escalates | Notes |
|---|---|---|---|---|
| `info` | no | no | no | Accumulates as context for the next cycle |
| `warn` | no | yes | no | Operator sees it; the Trader sees it next time it is up |
| `urgent` | **yes** | no | no | |
| `critical` | **yes** | yes | **yes** | Re-fires at `criticalCooldownMs` with a louder `wakeCount` until acked |

Which producer emits which severity:

| Event | Severity |
|---|---|
| `stop_breach`, `daily_loss_breach` | `critical` |
| `trailing_drawdown`, `position_drop`, `ema_cross_down`, `rsi_exit_zone`, `take_profit`, `entry_signal` | `urgent` |
| `position_surge`, `data_stale` | `warn` |
| `review_ready` | `warn` — not a detector; published by the reconciler |
| `heartbeat` | `urgent` or `info` — see below |

**The heartbeat** is the periodic look that no threshold can replace: a position bleeding 0.3% an hour crosses nothing until it has already crossed the stop. It is evaluated every tick but paced by cooldown alone:

| Condition | Cadence | Severity | Effect |
|---|---|---|---|
| Holding position(s) **and** market session open | `heartbeatWithPositionsMs` (15 min) | `urgent` | Wakes the Trader |
| Flat, or holding while the market is closed | `heartbeatFlatMs` (60 min) | `info` | Wakes nobody; sits in the registry as context |

Both regimes share one `cooldownKey`, so going from flat to holding tightens the existing beat rather than starting a second one. The overnight case is deliberately `info`: ungated, a 15-minute beat meant 96 non-actionable LLM cycles a day for as long as anything was open.

**A wake that arrives mid-cycle** is not lost and does not abort the cycle — interrupting between `execute_entry` and the baseline write would leave a filled order with no stop recorded anywhere. It sets `wakePending`, and the next `sleep` is skipped so the following cycle starts immediately.

### The Router

Receives all events from a single tick and coalesces them:
- **One** `wakeTrader()` per tick — multiple wakes from the same tick produce one cycle, because the Trader reads all pending events from the registry
- **One** `alertUser()` per tick — multi-line, one line per alerting event. Not free: each `pushAlert` injects two turns into the Concierge's history, so N pushes would cost 2N turns of context for information that fits in one message.
- Events at `wakeCount >= 3` are relabelled `UNACTIONED xN` in the operator's line, so a breach nobody is handling does not read as routine repetition.

### The Trader cycle

The Trader sleeps between cycles. When it wakes — by any of the three paths above — it receives a structured context block, in this order:

```
=== CYCLE: 2026-08-18T14:22:07.331Z ===

=== MACHINE EVENTS (4 pending) ===        ← registry, sorted by severity then age
[evt_8f2a] CRITICAL x3 — Stop breach: NVDA hit $190.00 -> consider_exit
[evt_c104] WARN     x1 — 2 round trip(s) closed since your last review — 1W/1L,
                         net -$84.21 gross (XLE, AMD) -> reflect
1 info event(s) not shown.
get_pending_events for the numbers behind a headline; ack_event(id, disposition) …
=== END MACHINE EVENTS ===

Start-of-day equity: $100,373.15

=== PORTFOLIO CONTEXT ===                 ← recorded baselines JOINED to live exposure
  GOOGL    entry $348.20 SL $330.00 TP $418.00  6.2%  Communication Services  age 3d
          MFE +4.1% / MAE -1.8% — "EMA cross with RSI 62, sector leader"
  XLF                                     4.4%  Financials  NO STOP RECORDED HERE
          rationale not recorded
2 open positions at the venue — 8 slots remaining. Call get_positions for live qty and P&L.
Held at the venue with no stop recorded here — the stop detector has no level to
compare against and will report nothing: XLF.
Deployed 10.6% of equity. Max weight GOOGL 6.2%. Max sector Financials 4.4%. HHI 0.51.
get_exposure for the full breakdown.
=== END PORTFOLIO CONTEXT ===

=== BROKER ORDERS ===                     ← unconditional; what actually rests at the venue
This system sends only market orders. Anything else below was placed outside it…
Nothing is resting at the venue. No stop, target or bracket exists anywhere but
in this system.
=== END BROKER ORDERS ===

=== RECENT DECISIONS ===                  ← last 8 journal records, incl. vetoes
  2026-08-11T09:31 ENTRY    NVDA  44sh @ $195.40 — EMA cross + RSI 62
  2026-08-11T10:02 VETO     AMD   [max_positions] — at cap, skipped
=== END RECENT DECISIONS ===

=== LESSONS (7) ===                       ← last 20, rendered in full
Written by earlier cycles of this system. They are standing rules of thumb…
## 2026-08-17T13:41:02Z — policy v6
XLE gapped on an OPEC headline nobody checked…
=== END LESSONS ===

=== OPERATOR INSTRUCTIONS ===             ← only when the concierge relayed one
> Buy BTC with $5,000 notional, GTC limit 1% below market
=== END OPERATOR INSTRUCTIONS ===

If MACHINE EVENTS are present, deal with the critical and urgent ones before
anything else. Otherwise start with get_market_status + get_account +
get_positions. End with sleep().
```

Two properties of that block are load-bearing:

- **PORTFOLIO CONTEXT counts positions at the venue, not from the snapshot map.** The two diverge in practice — leftover snapshots for positions long gone, holdings with no snapshot and therefore no stop anywhere. Counting snapshots once printed "-2 slots remaining" for a book of six.
- **A missing stop is stated twice**, per-row and again as a list, because it is the one condition where the stop detector measures nothing and reports nothing — indistinguishable, in a log, from a position behaving well.

The Trader then runs a tool-use loop (default 10 rounds, `AI_MAX_TOOL_ROUNDS`). It calls tools, gets results, reasons, calls more tools, and finally calls `sleep(minutes, reason)` to end the cycle. The duration it chooses is the longest it will stay silent — a crossing can still cut the sleep short.

### The Trader's tools

Reading the market:

| Tool | What it does |
|---|---|
| `get_market_status` | Market open/closed, ET time, minutes to open/close |
| `get_account` | Equity, cash, buying power, daily P&L, daily-loss-limit state |
| `get_positions` | Live positions with qty, avg cost, market value, unrealized P&L |
| `get_open_orders` | What is actually resting at the venue, grouped by position. This system places only market orders, so anything listed was placed outside it — and a venue stop is *not* the level the stop detector watches |
| `get_stock_bars`, `get_stock_snapshot`, `get_stock_latest_quote`, `get_most_active_stocks`, `get_market_movers`, `get_news`, `get_portfolio_history` | Native Alpaca market data (read-only; order placement is not exposed) |
| `web_search(query)` | Anything Alpaca's market data does not cover |

Measuring — the deterministic tools that exist so the model does not have to guess:

| Tool | What it does |
|---|---|
| `get_signals(symbol)` | The five entry signals — EMA momentum, trend strength, volume, breakout, MACD — each scored −1…+1, plus ATR and last close. The *same* computation that fills an `entry_signal` event, run on demand |
| `get_position_size(symbol, price, atr)` | Inverse-ATR volatility-scaled qty — equal risk per position |
| `get_correlation(symbol)` | Max pairwise correlation of a **candidate** vs open positions, plus a sizing recommendation |
| `get_exposure` | Shape of the book: per-position weight, sector, gross deployed, cash, largest single-name and sector weight, Herfindahl index, every held-vs-held correlation pair. The only source of a weight or a sector in this system |
| `get_scorecard(symbol?, days?)` | Measured performance over **completed** round trips: win rate, expectancy in $/%/R, hold times split by winners and losers, drawdown, stop discipline, breakdowns by symbol and policy version |
| `get_macro_regime` | FRED-based regime (expansion / late_cycle / recession / recovery), cached 6h |

Acting and recording:

| Tool | What it does |
|---|---|
| `execute_entry(symbol, qty, price, stopLoss, takeProfit, atr, reason, eventId?)` | Buy at market. The stop and target are recorded as **baselines watched by this system** — they are *not* sent to the venue as bracket legs, and nothing exits a position but an `execute_exit` call. Filled qty may be smaller than requested if the macro regime caps it |
| `execute_exit(symbol, reason, eventId?)` | Close at market, remove position baselines |
| `annotate_position(symbol, stopLoss, thesis, takeProfit?, entryPrice?)` | Retrofit baselines onto a position opened without them — legacy, externally opened, or any row flagged `NO STOP RECORDED HERE`. Writes the stop so the detector starts watching immediately, and journals the thesis |
| `get_pending_events` | Full event objects from the registry (the evidence behind a headline) |
| `ack_event(id, disposition, note?)` | Mark an event answered (`acting` / `acknowledged` / `ignoring`) — stops it escalating |
| `get_journal(symbol?, limit?)` | Decision history with rationales, guard vetoes and venue rejections |
| `write_lesson(lesson)` | Append one changed rule of thumb to `data/LESSONS.md` — the only thing a cycle can say that outlives it |
| `sleep(minutes, reason)` | End the cycle and set the maximum silence before the next one |

**Why the measuring tools exist at all.** POLICY.md names the five signal vocabulary, which was enough for the model to report "4/5 bullish, EMA momentum + trend + volume + breakout green" for a symbol whose EMA9 sat 3.4% *below* its EMA21 — measured, it was 1/5. Naming a vocabulary in a prompt without a tool to populate it invites confabulation, so each of `get_signals`, `get_exposure` and `get_scorecard` is declared in its own description as the *only* admissible source for its numbers.

### The Concierge

A separate LLM agent that maintains a persistent conversation with the operator. It has the Trader's read-only tools (no `execute_entry` / `execute_exit` / `annotate_position` / `write_lesson`) plus `get_state`, and two of its own:

- `send_to_trader(message)` — queue an instruction and wake the Trader
- `update_policy({...})` — persist a change to the watchlist, sizing or risk parameters; validated against the immutable ceilings, hot-reloaded, and picked up on the Trader's next cycle

It also receives every `warn`/`critical` alert from the Router via `pushAlert`, which prints to the UI and is injected into its conversation history so the operator can ask about it.

The Trader never talks to the operator directly.

### The policy system

Strategy and risk parameters live in YAML, split by mutability:

- `policy/default.yaml` — the read-only default the project **ships**. Never written at runtime.
- `data/policy/policy.yaml` — the **live** policy. Seeded from the default on first run; every `update_policy` writes here.
- `data/policy/history/` — a timestamped copy of the previous file for every accepted mutation.

The system prompt for the Trader is `policy/POLICY.md` — a template with `{{placeholders}}` interpolated from the live policy at the start of every cycle, so the prose in the system prompt cannot drift from the numbers in the config.

Failure semantics differ by phase on purpose: the **first** load throws, because trading on defaults nobody declared is worse than not trading. A **reload** never throws — it reports the errors and leaves the last good policy active, so a typo cannot take a running daemon down. The same applies to `POLICY.md` rendering, which falls back to the last successfully rendered prompt.

The `immutable` block is the part the Concierge and the Trader cannot argue with: `maxPositionsCeiling`, `maxDailyLossPctCeiling`, `positionSizePctCeiling`, `stopLossAtrMultCeiling`, `minTickIntervalMs`, `requireStopOnEntry`.

POLICY.md's rules are prose and mostly unenforced. The hard guards live in `enterPosition`, and each one names itself in the journal as a `vetoRule`: `missing_stop`, `invalid_intent`, `max_positions`, `already_holding`, `insufficient_buying_power`, `daily_loss_breached`.

### The review layer

Three files, one division of trust: **fills are truth for numbers, the journal is truth for reasons.** Prices, quantities, fees and timestamps come only from the venue; rationale, intended stop, trigger event and policy version come only from `journal.jsonl`. The join key is `orderId`, already present on both sides.

- `review/fillsLedger.ts` → `data/fills.jsonl`, append-only, synchronous writes. Dedup happens on **read**, not write, so a correction is a new line and the superseded one stays visible. IBKR revises an `execId` by incrementing the digits after the final period (`.01` → `.02`); keyed naively, that doubles a position.
- `review/ledger.ts` matches round trips **flat-to-flat**, not lot-FIFO. Identical under the `already_holding` guard, and better on a scale-out: 434 shares bought in one order and sold in two is one round trip with a weighted exit price.
- `review/metrics.ts` → `scorecard()`. **Code measures, the LLM interprets** — no verdicts or grades in there. `caveats[]` are facts about the *data* (n<20, fees unknown, missing rationales), never advice. `fee: null` means unknown, never 0: Alpaca bills SEC/TAF as separate activities, so `feesComplete` is false there and `grossPnL` is the comparable number.

The ledger is persisted rather than re-queried because **TWS serves executions for the current trading day only** — the broker is a tap on a window that closes, not a history endpoint. Alpaca serves months. `getFills(since?)` treats `since` as a *hint* and over-fetches on purpose — 7 days on the periodic run, 30 at startup, because the daemon may have been down for days. Both brokers' time filters are untrustworthy (Alpaca's `after` is documented against activity creation, not execution; IBKR's needs a timezone this process cannot know), so the boundary is pushed far enough away that no fill can fall behind it. The cost of overlap is a dedup; the cost of a gap is permanent.

The reconciler runs every 5 minutes off the tick, unconditionally when the session leaves `open` (IBKR clears overnight), and once at startup with a 30-day lookback that logs an explicit warning if the gap exceeds 24h — so a downtime never passes as an uneventful stretch.

**`review_ready`** is the edge that makes reflection happen. Cycles otherwise only ever wake mid-tape on market conditions, so the model was never put in front of an *outcome*. It fires when a round trip closes — the one moment the result is arithmetic rather than an opinion. It is `warn` rather than `info` because `buildMachineEvents` filters `info` out of the rendered list, and rather than `urgent` because the trade is already closed. Dedup is `state.lastReviewedExitAt`, a watermark of the newest `exitAt` announced; on an empty watermark the first run **adopts** the newest existing exit and says so, instead of announcing months of backlog.

### The lessons loop

`data/LESSONS.md` — free-text markdown, append-only, synchronous writes. Entries are `## <iso> — policy v<n>` sections. This closes the last open edge in adaptation: keep the three layers straight — the journal is what was **decided**, the scorecard is what **worked**, LESSONS.md is what was **concluded**. Before it, a conclusion died with the cycle that drew it.

Deliberately no schema, no dedup, no pruning, no rate limit. The bar is prose in POLICY.md and in the tool description ("most cycles must write no lesson"), because a mechanical gate would have to decide when a conclusion is *allowed* to happen, and the moment worth writing is when the evidence is in context — not when a clock says so.

Injected by `buildLessons()` capped at 20 and rendered **in full**, never as headlines: a compressed lesson is a slogan. There is no `get_lessons` tool and nothing hints at lessons beyond the cap, because a truncated list the model cannot reach is exactly the fabrication trap `get_signals` was built to close. Only the operator can delete or edit a lesson; the agent can only append a correction.

### What is persisted to disk

`data/state.json` holds only what the broker does not know:

| Field | Purpose |
|---|---|
| `startOfDayEquity` | Basis for the daily loss limit |
| `lastResetDate` | Prevents double-resets on the same ET date |
| `positionSnapshots` | Per-position baselines, keyed by canonical symbol |
| `entryPrice` | Fill price — never overwritten, the stop is measured from it |
| `stopLevel` / `takeProfitLevel` | Absolute prices set at entry |
| `sessionHigh` / `sessionLow` | Monotonic bounds since entry — MFE/MAE tracking |
| `openedAt` / `entryDecisionId` | Links position to journal entry |
| `eventCooldowns` / `armedTriggers` | Detector state — survive process restart |
| `lastReviewedExitAt` | Watermark for `review_ready` — the newest exit already announced |

Qty and live price are always fetched from the broker. The state file is never the source of truth for those.

Snapshots are keyed through `core/symbols.ts` (`canonicalSymbol`), because an order placed as `BTC/USD` comes back from Alpaca as `BTCUSD`. Two layers used to answer "same symbol?" differently, so a stop could render as recorded in the prompt and be invisible to the stop detector at the same time.

`sessionHigh` / `sessionLow` are monotonic by construction and therefore have no path back — one bad price is permanent for as long as the position is held. That is accepted rather than corrected, because daily bars cannot adjudicate it: the vendor's series has no bar for the current day until well after the close (measured 2026-08-18, 20:32Z: NVDA/UBER/MSFT all end at 08-17), so a bars check run at startup judges today's live extremes against yesterday's range and flags legitimate intraday moves as impossible. A `state/repair.ts` that narrowed against daily bars was removed for exactly that: on a live book it wanted to erase UBER's real intraday low, on a position opened that same day. The defence is at the source — see `quoteCandidate` in `collect/priceSource.ts`, which rejects a one-sided book rather than averaging a price with a blank.

Everything else under `data/` is append-only and gitignored: `journal.jsonl`, `fills.jsonl`, `LESSONS.md`, `sectors.json`, `policy/`.

---

## Architecture

```
src/
├── agents/
│   ├── trader.ts         # Trader: LLM loop, cycle context builder, sleep/wake
│   └── concierge.ts      # Concierge: operator-facing conversational agent
├── features/
│   ├── scheduler.ts      # FeatureScheduler: tick loop, daily reset, reconcile
│   ├── compute.ts        # collectAndCompute: prices + bars → TickData
│   ├── eventBus.ts       # Event registry, the four gates, publishTick/publishDiscrete
│   ├── router.ts         # Coalesces events → wakeTrader / alertUser
│   └── detectors/        # stopBreach, account, drawdown, technical,
│                         #   dataHealth, heartbeat, util, index (registry)
├── tools/
│   ├── traderTools.ts    # Tool implementations for the Trader
│   ├── alpacaDataTools.ts# Native Alpaca market data (bars, movers, news, …)
│   └── researchTools.ts  # web_search
├── strategy/
│   ├── indicators.ts     # EMA, RSI, ATR
│   ├── signals.ts        # The five entry signals + exit evaluation
│   ├── riskManager.ts    # Loss limit, buying power checks
│   ├── portfolioRisk.ts  # Volatility-scaled sizing, correlation gate,
│   │                     #   returnsMatrix + correlate (the shared arithmetic)
│   ├── exposure.ts       # Book shape: weights, sectors, HHI, held correlations
│   └── orderManager.ts   # Order execution + guard vetoes
├── review/
│   ├── fillsLedger.ts    # data/fills.jsonl — append-only, dedup on read
│   ├── ledger.ts         # Flat-to-flat round trips, joined to the journal
│   ├── metrics.ts        # scorecard() — measures, never grades
│   ├── reconcile.ts      # Pull venue fills; startup + periodic
│   └── reviewReady.ts    # Publishes review_ready off the exit watermark
├── journal/
│   ├── journal.ts        # Append-only decision log (data/journal.jsonl)
│   ├── lessons.ts        # data/LESSONS.md — append-only conclusions
│   └── types.ts          # DecisionRecord
├── macro/
│   └── regime.ts         # FRED-based macro regime classification (6h cache)
├── broker/
│   ├── IBroker.ts        # Broker interface (Position, AccountInfo, OpenOrder…)
│   ├── AlpacaBroker.ts   # Alpaca REST implementation
│   ├── IBKRBroker.ts     # IBKR implementation (TWS / IB Gateway)
│   ├── errors.ts         # Broker error classification
│   └── index.ts          # Active broker, selected by BROKER env var
├── policy/
│   ├── load.ts           # Seed + parse + validate + hot-reload watcher
│   ├── render.ts         # POLICY.md template interpolation
│   ├── mutate.ts         # Validated, hot-reloaded writes (update_policy)
│   └── types.ts          # Policy shape
├── state/
│   └── state.ts          # Durable baselines (data/state.json)
├── collect/
│   ├── priceSource.ts    # Alpaca snapshots, quote/trade freshness pick
│   ├── barSource.ts      # OHLCV bars
│   ├── brokerSource.ts   # Account + positions
│   ├── yahoo.ts          # Yahoo Finance fallback quotes + bars
│   ├── sectorCache.ts    # data/sectors.json — no TTL, nulls not cached
│   └── types.ts          # Maybe<T> wrappers; the one staleness chokepoint
├── core/
│   ├── config.ts         # API keys, model, broker selection (NOT behaviour)
│   ├── modelProvider.ts  # Anthropic + any OpenAI-compatible endpoint
│   ├── symbols.ts        # canonicalSymbol / sameSymbol — one definition of "same symbol"
│   ├── alpacaHttp.ts     # Both Alpaca base URLs + the nanosecond timestamp rule
│   ├── fsAtomic.ts       # writeFileAtomic — whole-file writes a crash cannot truncate
│   ├── time.ts           # ET clock + market session
│   ├── logger.ts         # Logging (routed into the UI log pane)
│   └── types.ts          # ChatMessage, ContentBlock, ToolDefinition
├── ui/
│   ├── ui.ts             # Terminal UI (log pane + chat pane)
│   └── inputEditor.ts    # Readline-style line editor for the input box
├── scripts/
│   ├── replay.ts         # Detector/gate scenario harness (npm run replay)
│   ├── journal.ts        # Journal inspection (npm run journal)
│   └── verifyPolicyPrompt.ts  # POLICY.md render check (npm run verify:policy)
└── daemon.ts             # Entry point — wires all three processes together

policy/
├── POLICY.md             # Trader system prompt template (shipped, hot-reloaded)
└── default.yaml          # Shipped default policy (read-only at runtime)
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill it in. The minimum for Alpaca paper trading:

```env
# Broker — alpaca (default) or ibkr
BROKER=alpaca
ALPACA_KEY_ID=your_key
ALPACA_SECRET_KEY=your_secret
# ALPACA_BASE_URL=https://paper-api.alpaca.markets   # live: https://api.alpaca.markets
# ALPACA_DATA_URL=https://data.alpaca.markets

# AI — the only required variable
AI_API_KEY=your_api_key
# AI_PROVIDER=anthropic          # or openai, groq, ollama, cohere, together, …
# AI_MODEL=claude-sonnet-4-6
# AI_BASE_URL=                   # required for any provider not in the list above
# AI_MAX_TOKENS=4096
# AI_MAX_TOOL_ROUNDS=10

# Optional — enables get_macro_regime. Without it the regime resolves from nulls.
# FRED_API_KEY=your_fred_key
```

`AI_API_KEY` is the only variable that throws when missing. Everything else has a default.

The base URL is never guessed from a provider name: an unrecognised `AI_PROVIDER` without `AI_BASE_URL` is an error, because guessing would send `Authorization: Bearer <your key>` to whatever domain the guess happens to spell.

To run against Interactive Brokers instead, set `BROKER=ibkr` and start TWS or IB Gateway:

```env
BROKER=ibkr
IBKR_HOST=localhost
IBKR_PORT=7497        # TWS paper 7497 / live 7496; Gateway paper 4002 / live 4001
IBKR_CLIENT_ID=1
IBKR_ACCOUNT=         # blank for single-account setups
```

Note that **environment holds secrets and endpoints, never behaviour.** Anything an operator would tune to change *how* the system trades lives in the policy YAML.

### 3. Run

```bash
npm run dev        # ts-node src/daemon.ts
```

Other scripts:

```bash
npm run build            # tsc → dist/
npm start                # node dist/daemon.js
npm run replay           # detector + gate scenario harness
npm run journal          # inspect data/journal.jsonl
npm run verify:policy    # render POLICY.md and check for unfilled placeholders
```

---

## Configuration

Strategy and risk parameters are in `data/policy/policy.yaml` (seeded from `policy/default.yaml` on first run). The Trader's system prompt in `policy/POLICY.md` is re-rendered on every cycle — edit either file while the daemon is running and the next cycle picks up the change.

Key parameters, with the shipped defaults:

| Parameter | Default | Description |
|---|---|---|
| `emaFast` | 9 | Fast EMA period |
| `emaSlow` | 21 | Slow EMA period |
| `rsiPeriod` | 14 | RSI period |
| `rsiEntryMin` | 50 | Min RSI to enter |
| `rsiExitMax` | 40 | RSI below which to consider exit |
| `atrPeriod` | 14 | ATR period |
| `minBars` | 50 | Bars required before a symbol is evaluated |
| `maxPositions` | 10 | Max simultaneous positions |
| `positionSizePct` | 0.1 | Fraction of equity per trade |
| `stopLossAtrMult` | 2.0 | Stop = entry − N × ATR |
| `takeProfitAtrMult` | 6.0 | Target = entry + N × ATR |
| `maxDailyLossPct` | 0.03 | Daily loss halt threshold |

Trigger and wake cadences (`triggers:`):

| Parameter | Default | Description |
|---|---|---|
| `tickIntervalMs` | 60000 | Scheduler tick cadence — how often detectors run |
| `positionDropPct` | 2 | Drop from entry that fires `position_drop` |
| `trailingDrawdownPct` | 2 | Drawdown from session high that fires `trailing_drawdown` |
| `positionSurgePct` | 4 | Gain that fires `position_surge` |
| `hysteresisPct` | 0.5 | Re-arm band — how far a level must recross to fire again |
| `defaultCooldownMs` | 900000 | Quiet period per `cooldownKey` (15 min) |
| `criticalCooldownMs` | 300000 | Escalation interval for an unacked `critical` (5 min) |
| `heartbeatWithPositionsMs` | 900000 | Heartbeat cadence while holding with the market open — wakes the Trader |
| `heartbeatFlatMs` | 3600000 | Heartbeat cadence when flat or closed — context only, no wake |
| `maxQuoteAgeMs` | 180000 | Age past which a quote is stale and fires `data_stale` |

Safety ceilings (`immutable:`) — no runtime change, from the Concierge or the Trader, can exceed these:

| Parameter | Default |
|---|---|
| `maxPositionsCeiling` | 10 |
| `maxDailyLossPctCeiling` | 0.05 |
| `positionSizePctCeiling` | 0.1 |
| `stopLossAtrMultCeiling` | 4 |
| `minTickIntervalMs` | 30000 |
| `requireStopOnEntry` | true |

The `regime:` block scales entry aggressiveness by macro regime (`sizeMult` and `rsiEntryMin` per regime: expansion and recovery at full size, `late_cycle` 0.75× with RSI ≥ 55, `recession` 0.5× with RSI ≥ 60).
