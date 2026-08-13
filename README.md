# AutoTrade

An autonomous momentum trading daemon powered by Claude. Three concurrent processes run at all times: a deterministic tick loop that watches the market, a sleeping LLM trader that wakes when something crosses (or when its own scheduled silence runs out), and a conversational concierge that lets the operator talk to the system.

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

### The event registry and gates

Detectors report *levels*; the bus owns the *edges*. A level predicate on a 60s loop would fire every tick a position sits 2.1% down — a wake storm, not a signal. So each hit passes four gates, in order, per `cooldownKey`:

| Gate | Rule |
|---|---|
| **Edge** | Fire only on a `false → true` arming transition. Arming lives in `state.armedTriggers`, so a restart does not re-announce what the previous process already announced. |
| **Hysteresis** | Re-arming requires recrossing the threshold by `hysteresisPct`, not merely touching it from the other side. Kills boundary flutter. |
| **Cooldown** | Even a re-armed key stays quiet inside `defaultCooldownMs` (or the detector's own override). |
| **Escalation** | A `critical` that is still breaching and still unacked re-fires every `criticalCooldownMs` with `wakeCount++`. This stands in for auto-execution: ignore a stop breach and the wakes get louder. |

The heartbeat detector is the one exception — it carries no crossing, so the cooldown is its only gate (see below).

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

Which detector produces which severity:

| Detector | Severity |
|---|---|
| `stop_breach`, `daily_loss_breach` | `critical` |
| `trailing_drawdown`, `position_drop`, `ema_cross_down`, `rsi_exit_zone`, `take_profit`, `entry_signal` | `urgent` |
| `position_surge`, `data_stale` | `warn` |
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

The Trader sleeps between cycles. When it wakes — by any of the three paths above — it receives a structured context block:

```
=== CYCLE: <ISO timestamp> ===

=== MACHINE EVENTS (N pending) ===   ← events from the registry, sorted by severity
[id] CRITICAL x3 — Stop breach: NVDA hit $190.00 → consider_exit
...
=== END MACHINE EVENTS ===

Start-of-day equity: $100,373.15

=== PORTFOLIO CONTEXT ===             ← internal baselines only (entry / SL / TP)
GOOGL    entry $348.20  SL $330.00  TP $418.00
NVDA     entry $195.40  SL $183.00  TP $234.00
2 open positions — 3 slots remaining. Call get_positions for live qty and P&L.
=== END PORTFOLIO CONTEXT ===

=== RECENT DECISIONS ===              ← last 8 journal entries
  2026-08-11T09:31 ENTRY   NVDA  44sh @ $195.40 — EMA cross + RSI 62
  ...
=== END RECENT DECISIONS ===

=== OPERATOR INSTRUCTIONS ===         ← only when the concierge relayed one
> Buy BTC with $5,000 notional, GTC limit 1% below market
=== END OPERATOR INSTRUCTIONS ===

If MACHINE EVENTS are present, deal with the critical and urgent ones first.
Otherwise start with get_market_status + get_account + get_positions. End with sleep().
```

The Trader then runs a tool-use loop (up to 30 rounds). It calls tools, gets results, reasons, calls more tools, and finally calls `sleep(minutes, reason)` to end the cycle. The duration it chooses is the longest it will stay silent — a crossing can still cut the sleep short.

### The Trader's tools

| Tool | What it does |
|---|---|
| `get_market_status` | Market open/closed, ET time, minutes to open/close |
| `get_account` | Equity, cash, buying power, daily P&L, daily-loss-limit state |
| `get_positions` | Live positions with qty, avg cost, market value, unrealized P&L |
| `get_pending_events` | Full event objects from the registry (evidence behind a headline) |
| `ack_event(id, disposition, note?)` | Mark an event answered (`acting` / `acknowledged` / `ignoring`) — stops it escalating |
| `execute_entry(symbol, qty, price, stopLoss, takeProfit, atr, reason, eventId?)` | Place bracket entry, write position baselines to state |
| `execute_exit(symbol, reason, eventId?)` | Close at market, remove position baselines |
| `get_position_size(symbol, price, atr)` | Inverse-ATR volatility-scaled qty — equal risk per position |
| `get_correlation(symbol)` | Max pairwise correlation vs open positions + sizing recommendation |
| `get_macro_regime` | FRED-based regime (expansion / late_cycle / recession / recovery), cached 6h |
| `get_journal(symbol?, limit?)` | Decision history with rationales, vetoes and rejections |
| `get_stock_bars`, `get_stock_snapshot`, `get_stock_latest_quote`, `get_most_active_stocks`, `get_market_movers`, `get_news`, `get_portfolio_history` | Native Alpaca market data (read-only; order placement is not exposed) |
| `web_search(query)` | Anything Alpaca's market data does not cover |
| `sleep(minutes, reason)` | End the cycle and set the maximum silence before the next one |

### The Concierge

A separate LLM agent that maintains a persistent conversation with the operator. It has the Trader's read-only tools (no `execute_entry` / `execute_exit`) plus `get_state`, and two of its own:

- `send_to_trader(message)` — queue an instruction and wake the Trader
- `update_policy({...})` — persist a change to the watchlist, sizing or risk parameters; validated against the immutable ceilings, hot-reloaded, and picked up on the Trader's next cycle

It also receives every `warn`/`critical` alert from the Router via `pushAlert`, which prints to the UI and is injected into its conversation history so the operator can ask about it.

The Trader never talks to the operator directly.

### The policy system

Strategy and risk parameters live in `policy/policy.yaml`. The system prompt for the Trader is `policy/POLICY.md` — a template with `{{placeholders}}` that are interpolated from `policy.yaml` at the start of every cycle. This means the prose in the system prompt cannot drift from the numbers in the config.

Failure semantics differ by phase on purpose: the **first** load throws, because trading on defaults nobody declared is worse than not trading. A **reload** never throws — it reports the errors and leaves the last good policy active, so a typo cannot take a running daemon down. The same applies to `POLICY.md` rendering, which falls back to the last successfully rendered prompt. Every accepted `update_policy` writes a timestamped copy of the previous file to `policy/history/`.

The `immutable` block is the part the Concierge and the Trader cannot argue with: `maxPositionsCeiling`, `maxDailyLossPctCeiling`, `positionSizePctCeiling`, `stopLossAtrMultCeiling`, `minTickIntervalMs`, `requireStopOnEntry`.

### What is persisted to disk

`data/state.json` holds only what the broker does not know:

| Field | Purpose |
|---|---|
| `startOfDayEquity` | Basis for the daily loss limit |
| `lastResetDate` | Prevents double-resets on the same ET date |
| `entryPrice` | Fill price — never overwritten, the stop is measured from it |
| `stopLevel` / `takeProfitLevel` | Absolute prices set at entry |
| `sessionHigh` / `sessionLow` | Monotonic bounds since entry — MFE/MAE tracking |
| `openedAt` / `entryDecisionId` | Links position to journal entry |
| `eventCooldowns` / `armedTriggers` | Detector state — survive process restart |

Qty and live price are always fetched from the broker. The state file is never the source of truth for those.

---

## Architecture

```
src/
├── agents/
│   ├── trader.ts         # Trader: LLM loop, cycle context builder, sleep/wake
│   └── concierge.ts      # Concierge: operator-facing conversational agent
├── features/
│   ├── scheduler.ts      # FeatureScheduler: tick loop, daily reset
│   ├── compute.ts        # collectAndCompute: prices + bars → TickData
│   ├── eventBus.ts       # Event registry, the four gates, publishTick
│   ├── router.ts         # Coalesces events → wakeTrader / alertUser
│   └── detectors/        # stopBreach, account, drawdown, technical,
│                         #   dataHealth, heartbeat, index (registry)
├── tools/
│   ├── traderTools.ts    # Tool implementations for the Trader
│   ├── alpacaDataTools.ts# Native Alpaca market data (bars, movers, news, …)
│   └── researchTools.ts  # web_search
├── strategy/
│   ├── indicators.ts     # EMA, RSI, ATR
│   ├── signals.ts        # Entry/exit signal evaluation
│   ├── riskManager.ts    # Loss limit, buying power checks
│   ├── portfolioRisk.ts  # Volatility-scaled sizing, correlation gate
│   └── orderManager.ts   # Order execution + guard vetoes
├── macro/
│   └── regime.ts         # FRED-based macro regime classification (6h cache)
├── broker/
│   ├── IBroker.ts        # Broker interface
│   ├── AlpacaBroker.ts   # Alpaca REST implementation
│   ├── IBKRBroker.ts     # IBKR implementation
│   └── index.ts          # Active broker (swap here to change broker)
├── policy/
│   ├── POLICY.md         # Trader system prompt template
│   ├── policy.yaml       # Strategy + risk parameters
│   ├── history/          # Timestamped copies of superseded policy files
│   ├── render.ts         # Template interpolation
│   ├── mutate.ts         # Validated, hot-reloaded policy writes (update_policy)
│   └── load.ts           # Parse + validate + hot-reload watcher
├── state/
│   └── state.ts          # Durable baselines (data/state.json)
├── journal/
│   └── journal.ts        # Append-only decision log (data/journal.jsonl)
├── collect/
│   └── …                 # Broker + price + bar collection with Maybe<T> wrappers
├── core/
│   ├── config.ts         # API keys, model, broker selection
│   ├── modelProvider.ts  # Claude API client
│   ├── time.ts           # ET clock + market session
│   └── types.ts          # ChatMessage, ContentBlock, ToolDefinition
├── prices/
│   └── yahoo.ts          # Yahoo Finance fallback quotes + bars
├── ui/
│   ├── ui.ts             # Terminal UI (log pane + chat pane)
│   └── inputEditor.ts    # Readline-style line editor for the input box
├── scripts/
│   ├── replay.ts         # Detector/gate scenario harness (npm run replay)
│   ├── journal.ts        # Journal inspection (npm run journal)
│   └── verifyPolicyPrompt.ts  # POLICY.md render check (npm run verify:policy)
└── daemon.ts             # Entry point — wires all three processes together
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env`:

```env
# Broker — Alpaca (paper)
ALPACA_KEY_ID=your_key
ALPACA_SECRET_KEY=your_secret
ALPACA_BASE_URL=https://paper-api.alpaca.markets

# AI
AI_API_KEY=your_anthropic_key
AI_MODEL=claude-sonnet-4-6       # optional override
AI_MAX_TOKENS=4096               # optional override
```

### 3. Run

```bash
npm run dev
```

---

## Configuration

Strategy and risk parameters are in `policy/policy.yaml`. The Trader's system prompt in `policy/POLICY.md` is hot-reloaded on every cycle — edit either file while the daemon is running and the next cycle picks up the change.

Key parameters:

| Parameter | Default | Description |
|---|---|---|
| `emaFast` | 9 | Fast EMA period |
| `emaSlow` | 21 | Slow EMA period |
| `rsiPeriod` | 14 | RSI period |
| `rsiEntryMin` | 50 | Min RSI to enter |
| `rsiExitMax` | 40 | RSI below which to consider exit |
| `atrPeriod` | 14 | ATR period |
| `minBars` | 50 | Bars required before a symbol is evaluated |
| `maxPositions` | 5 | Max simultaneous positions |
| `positionSizePct` | 0.05 | Fraction of equity per trade |
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

The `regime:` block scales entry aggressiveness by macro regime (`sizeMult`, `rsiEntryMin` per regime), and `immutable:` holds the ceilings that no runtime change can exceed.
