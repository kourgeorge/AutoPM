# AutoTrade

An autonomous momentum trading daemon powered by Claude. Three concurrent processes run at all times: a deterministic tick loop that watches the market, a sleeping LLM trader that wakes only when something crosses, and a conversational concierge that lets the operator talk to the system.

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
              ┌────────────▼────────────┐
              │        Router           │
              │  coalesces events:      │
              │  critical/urgent  →  wakeTrader()   │
              │  warn/critical    →  alertUser()    │
              └──────┬────────────┬─────┘
                     │            │
          ┌──────────▼──┐   ┌─────▼──────────────┐
          │   Trader    │   │    Concierge        │
          │  (LLM loop) │   │  (LLM, persistent  │
          │  sleeps 4–  │   │   conversation)     │
          │  10 min     │   │                     │
          └─────────────┘   └─────────────────────┘
```

### The tick loop (FeatureScheduler)

Runs continuously at a configurable interval. A tick never overlaps with the previous one — `setTimeout` is re-armed after the tick settles, never `setInterval`.

Each tick:
1. **Daily reset** — if the ET date has turned, snapshot `startOfDayEquity` from the broker
2. **Collect** — prices (Yahoo Finance), OHLCV bars, account info, open positions from the broker
3. **Compute** — derive EMA(fast/slow), RSI, ATR, position P&L, drawdown from high, distance to stop
4. **Detect** — every detector evaluates the computed data against the active policy
5. **Publish** — events that pass all four gates (cooldown / armed-trigger / severity / dedup) land in the event registry and are handed to the Router

### The event registry and gates

Each detector can fire one or many `TriggerEvent` per tick. An event only passes through if:
- It is not in cooldown (each event kind has a configurable quiet period)
- Its armed-trigger prerequisite is satisfied (e.g. EMA cross-up must be armed before cross-down can fire)
- Its severity is at or above the routing threshold
- It is not a duplicate of the last identical event

Passed events accumulate in an in-memory registry. The Trader reads and acknowledges them at cycle start with `get_pending_events` / `ack_event`.

### The Router

Receives all events from a single tick and coalesces them:
- **One** `wakeTrader()` per tick — multiple wakes from the same tick produce one cycle, because the Trader reads all pending events from the registry
- **One** `alertUser()` per tick — multi-line, one line per alerting event

### The Trader cycle

The Trader sleeps between cycles. The scheduler wakes it; the operator (via Concierge) can also wake it with an instruction.

When it wakes, it receives a structured context block:

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

The Trader then runs a tool-use loop (up to 30 rounds). It calls tools, gets results, reasons, calls more tools, and finally calls `sleep(minutes, reason)` to end the cycle. The sleep duration it chooses sets when it wakes next.

### The Trader's tools

| Tool | What it does |
|---|---|
| `get_market_status` | Market open/closed, ET time, minutes to open/close |
| `get_account` | Equity, cash, buying power, daily P&L |
| `get_positions` | Live positions with qty, market value, unrealized P&L |
| `get_pending_events` | Full event objects from the registry (evidence behind a headline) |
| `ack_event(id, disposition)` | Mark an event handled — stops it re-firing next cycle |
| `execute_entry(symbol, qty, price, stop, tp, reason)` | Place entry order, write position baselines to state |
| `execute_exit(symbol, reason)` | Place exit order, remove position baselines |
| `web_search(query)` | Research a symbol or market condition |
| `get_journal(symbol?, limit?)` | Full decision history with rationales |
| `sleep(minutes, reason)` | End the cycle, schedule next wake |

### The Concierge

A separate LLM agent that maintains a persistent conversation with the operator. Has read access to the same tools as the Trader (minus entry/exit). When the operator wants the Trader to act, the Concierge calls `send_to_trader(message)`, which queues the message and wakes the Trader.

The Trader never talks to the operator directly.

### The policy system

Strategy and risk parameters live in `policy/policy.yaml`. The system prompt for the Trader is `policy/POLICY.md` — a template with `{{placeholders}}` that are interpolated from `policy.yaml` at the start of every cycle. This means the prose in the system prompt cannot drift from the numbers in the config.

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
│   ├── eventBus.ts       # Event registry, gates, publishTick
│   ├── router.ts         # Coalesces events → wakeTrader / alertUser
│   └── detectors/        # One file per detector (entry, stop breach, drawdown, …)
├── tools/
│   ├── traderTools.ts    # Tool implementations for the Trader
│   └── researchTools.ts  # web_search
├── strategy/
│   ├── indicators.ts     # EMA, RSI, ATR
│   ├── riskManager.ts    # Position sizing, loss limit, buying power checks
│   └── orderManager.ts   # Order execution + guard vetoes
├── broker/
│   ├── IBroker.ts        # Broker interface
│   ├── AlpacaBroker.ts   # Alpaca REST implementation
│   └── index.ts          # Active broker (swap here to change broker)
├── policy/
│   ├── POLICY.md         # Trader system prompt template
│   ├── policy.yaml       # Strategy + risk parameters
│   ├── render.ts         # Template interpolation
│   └── load.ts           # Hot-reload watcher
├── state/
│   └── state.ts          # Durable baselines (data/state.json)
├── journal/
│   └── journal.ts        # Append-only decision log (data/journal.jsonl)
├── collect/
│   └── …                 # Broker + price + bar collection with Maybe<T> wrappers
├── core/
│   ├── config.ts         # API keys, model, broker selection
│   ├── modelProvider.ts  # Claude API client
│   └── types.ts          # ChatMessage, ContentBlock, ToolDefinition
├── prices/
│   └── yahoo.ts          # Price + bar fetching via Yahoo Finance
├── ui/
│   └── ui.ts             # Terminal UI (log pane + chat pane)
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
| `maxPositions` | 5 | Max simultaneous positions |
| `positionSizePct` | 0.05 | Fraction of equity per trade |
| `stopLossAtrMult` | 2.0 | Stop = entry − N × ATR |
| `takeProfitAtrMult` | 6.0 | Target = entry + N × ATR |
| `maxDailyLossPct` | 0.03 | Daily loss halt threshold |
| `tickIntervalMs` | 60000 | Scheduler tick cadence |
