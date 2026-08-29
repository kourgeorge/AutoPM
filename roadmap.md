# VISION — from signal-reactive trader to portfolio-maintaining agent

**Status: roadmap.** Seven independent work orders, P0 → P6, each self-contained: exact files,
exact line numbers, what to reuse, the traps, and how to verify. Implement one at a time. Ordering
matters (see the rationale under the priority table) but each item ships alone.

Progress is tracked in the priority table. Everything not marked shipped is unbuilt.

---

## 1. Why this document exists

An essay proposing an "agentic portfolio operating system" (riffing on Ang, Azimbayev & Kim
2026, *The Self-Driving Portfolio*) argued the real agent problem is not
`Market → LLM → BUY/SELL` but:

```
Portfolio state → continuous observations → signals → portfolio diagnosis
  → candidate adaptations → risk/policy validation → execution → outcome memory → loop
```

Most of that loop **already exists in this repo**, and several parts are stronger here than in
the essay:

| Essay proposal | Where it already lives |
|---|---|
| Event-driven signal system | `src/features/eventBus.ts` — four gates: edge, hysteresis, cooldown, escalation |
| Separate signal from decision | detectors compute → LLM judges → `orderManager.ts` guards enforce |
| Action budget / policy engine | `policy/policy.yaml` + `immutable` ceilings + 8 hard guards in `enterPosition` |
| Outcome memory | `src/review/` — fills ledger → round trips → scorecard → `review_ready` → `data/LESSONS.md` |
| Macro / regime agent | `src/macro/regime.ts` (FRED, 6 h cache) + `regime.sizeMult` enforced inside the guard |
| Risk agent (partial) | `src/strategy/portfolioRisk.ts` — inverse-vol sizing, correlation gate |
| "User rejected this before" | `ack_event` dispositions land as `hold` records in `data/journal.jsonl` |
| Simulation | `src/scripts/replay.ts` — deterministic scenarios, detectors only, no LLM |

So this is not a rebuild. It is a list of specific missing **edges**.

## 2. The six genuine gaps

1. **The portfolio is not a first-class object.** `state.positionSnapshots` holds
   entry/stop/TP/high/low *per symbol* and nothing aggregate. No sector, no weight, no
   concentration, no held-vs-held correlation, no equity peak. Ten of the eleven detectors are
   per-symbol; only `dailyLossDetector` looks at the account.
2. **The prompt names a vocabulary no tool can populate.** `policy/POLICY.md:40` ("Avoid sector
   concentration — check PORTFOLIO CONTEXT and use judgment") and
   `src/agents/trader.ts:211` ("assess the sectors of open positions") both point the model at
   information the system does not have. This is the `get_signals` fabrication class exactly.
3. **"Exit when the thesis is done" is unanswerable from context.** `POLICY.md:27` asks it;
   `buildPortfolioContext` (`trader.ts:194`) renders entry/SL/TP and *not* the rationale the
   position was opened for. The link already exists — `PositionSnapshot.entryDecisionId` →
   `journal.jsonl` — and the context builder does not use it.
4. **No benchmark.** The scorecard is nine absolute statistics. None of them answers "is this
   worth doing instead of holding SPY".
5. **Positions are immutable once open.** `exitPosition` always sells `pos.qty`
   (`orderManager.ts:140`); `stopLevel` is written once at entry and has no second writer. Every
   winner gives its MFE back and no winner can be protected.
6. **One reactive timescale.** 60 s detectors + 5 min reconcile + heartbeat. Nothing schedules a
   strategic pass; the agent only ever wakes mid-tape on a crossing.

## 3. Design decisions (settled — do not relitigate while implementing)

- **One LLM, deterministic tools.** The essay's specialized market/fundamental/news/macro/risk
  sub-agents are rejected. Each becomes a *measured tool*, following `signals.ts`,
  `portfolioRisk.ts`, `macro/regime.ts`. A sub-agent's output is prose re-read as fact — the
  exact failure the research-cache and computed-"performance mode" context blocks were deleted
  for.
- **Code measures, the LLM interprets.** Precedent: `src/review/metrics.ts`. Tools return
  arithmetic and `caveats[]`. `caveats[]` are facts *about the data* ("n < 20", "fees unknown",
  "sector unknown for 2 symbols"), never advice, never verdicts.
- **Never name a noun in the prompt without a tool that returns it.** This is the standing rule
  the whole document is organised around.
- **Position management = tighten-only stops + partial exits.** Guard-enforced, so it cannot be
  used to dodge a loss.

### Explicitly NOT building

- **A composite "Portfolio Health 76/100".** A weighted score of seven subscores is a verdict
  wearing a number. Ship the seven measurements; let the model interpret them.
- VaR / CVaR, portfolio beta, factor models. No return distribution worth the name exists over
  ~11 round trips.
- The RL reward `R = return − λ₁risk − λ₂drawdown − λ₃turnover − λ₄concentration − λ₅tax`. A
  useful framing for what the scorecard should surface; not a thing to optimize against.
- An IPS / user-objectives object. `policy.yaml` **is** the IPS for a single-operator account.
- An LLM-in-the-loop backtest harness. The account is already paper — live paper trading *is*
  shadow mode, with real fills and real slippage, which no replay gives.
- Adding to an existing position. The `already_holding` guard (`orderManager.ts:85`) stays.

---

## 4. Priority table

| # | Item | Closes gap | Size | New event kinds | New policy keys | Touches guards | Status |
|---|---|---|---|---|---|---|---|
| P0 | `get_exposure` + weights/sectors in PORTFOLIO CONTEXT | 1, 2 | S | no | no | no | **shipped** |
| P1 | Thesis + age + MFE/MAE in PORTFOLIO CONTEXT | 3 | XS | no | no | no | **shipped** |
| P2 | `get_benchmark` — one number vs SPY | 4 | S | no | no | no | **shipped** |
| P3 | Portfolio Doctor: `equityPeak` + 2 portfolio detectors | 1 | M | **2** | **3** | no | unbuilt |
| P4 | `update_stop` (tighten-only) + partial `execute_exit` | 5 | M | no | no | **yes** | **shipped** |
| P5 | `get_calendar` + `get_fundamentals` — earnings dates, crowding, revisions | — | S | no | no | no | **shipped** |
| P6 | Slow loop: scheduled close / weekly review wake | 6 | S | **1** | no | no | **shipped** |

**Ordering rationale.** P0 and P1 *repair defects that already exist* — a prompt that names a
vocabulary it cannot populate, and an instruction that cannot be followed from context. Nothing
new belongs above a known fabrication vector. P4 is the item most likely to change returns, but
it is the only one that touches the guard layer, so it goes after the cheap context work is
proven. P3 is the architectural piece and depends on P0's arithmetic. P5 and P6 are independent
of everything and can be pulled forward if convenient.

Dependencies: **P3 needs P0** (it calls the same exposure math — `concentration()` in
`src/strategy/exposure.ts` is already pure and network-free for exactly this reason). **P6 reads
P0 and P2** for its event evidence but degrades gracefully without them. Everything else is
standalone.

---

## 5. Shared conventions

Read this section once; every work order assumes it.

### 5.1 Units — percentage points, always

There is a live unit trap in the codebase. `policy.risk.maxDailyLossPct` is a **fraction**
(`0.03`) while `AccountData.dayPnLPct` is **percentage points** (`-3.0`), so
`src/features/detectors/account.ts:22` has to write:

```ts
const threshold = -policy.risk.maxDailyLossPct * 100;
```

Every new threshold in this document is **percentage points** (`6` means 6 %). Name the unit in
the type comment where it is declared, and assert it in a replay scenario.

### 5.2 Adding a tool — four places, in order

1. Implement the measurement in the layer that owns it (`src/strategy/`, `src/review/`,
   `src/collect/`) — never inside the tool.
2. Add the JSON schema to `TRADER_TOOL_DEFINITIONS` (`src/tools/traderTools.ts`). Copy the
   shape of the `execute_entry` definition.
3. Add a `case` to the `executeTraderTool` switch. Its central `catch` already converts
   `GuardRejection` → `{error, rejectedBy:'guard', rule}` and `BrokerRejection` →
   `{error, rejectedBy:'broker', status, venueCode, venueMessage}` — do not catch locally.
4. Teach `policy/POLICY.md` that the tool exists, then run `npm run verify:policy`.

### 5.3 Yahoo calls

`src/collect/yahoo.ts` is the live module. **`src/prices/yahoo.ts` is dead — nothing imports it**
(commit `abe53e2` relocated the module and left the original behind). Edit the `collect/` copy.

Always pass moduleOptions as the third argument:

```ts
const r = await yf.quoteSummary(symbol, { modules: ['assetProfile'] }, { validateResult: false });
```

`yahoo-finance2` v4 schema validation is not advisory: on a shape mismatch it logs a wall of text
(into the blessed log box, since stdout is captured) **and throws**, killing the call even when
the field you wanted is present. Yahoo's shape drifts per symbol. Our own field checks are the
real validation.

### 5.4 On-disk caches

Copy the discipline of `src/journal/journal.ts`: a file under `data/`, **synchronous** writes,
`try/catch` that logs and continues (a cache write failure must never take down a trading
cycle), added to `.gitignore` beside `data/state.json` / `journal.jsonl` / `fills.jsonl` /
`LESSONS.md`. Provide an `_ephemeral`-style seam if `replay.ts` will touch it — see the existing
`useEphemeralJournal` / `useEphemeralFillsLedger` / `useEphemeralLessons` in `replay.ts`.

`src/collect/sectorCache.ts` (P0) is the worked example.

### 5.5 Never guess a datum

A missing sector is `null` plus a caveat. A missing earnings date is `null` plus a caveat. A
missing entry rationale renders as `"rationale not recorded"`. Interpolating any of them is the
failure mode this whole document exists to avoid.

---

## 6. P0 — Portfolio exposure as measured fact — **SHIPPED**

**Closes gaps 1 and 2. Size S.**

### Why

`POLICY.md:40` and `trader.ts:211` both instructed the model to assess sector concentration. No
tool in the system returned a sector. Either delete the instruction or supply the data — supplied
it. Same failure class as the TSLA incident where the prompt listed five signal names and the
model reported "4/5 bullish" with zero signal data (measured: 1/5 bullish, 3 bearish).

### What shipped

**`src/strategy/exposure.ts`** — `ExposurePosition`, `HeldCorrelation`, `Exposure`, and two
entry points:

- **`concentration(positions, equity, sectors)`** — pure, no network, no broker. All the weight /
  HHI / sector arithmetic. **P3 calls this from `computeTick`**; it is pure precisely so the 60 s
  tick never gains a network call and `compute.ts`'s NO-NEW-MATH invariant survives.
- **`exposure(): Promise<Exposure>`** — `Promise.all([getAccountInfo(), getPositions()])` →
  `getSectors()` → `concentration()` → correlation matrix.

Empty book → zeros, empty arrays, `caveats: ['no open positions']`.

**Reuse that mattered:** `dailyReturns` and `pearsonCorrelation` were module-private in
`src/strategy/portfolioRisk.ts` and are now exported. `exposure()` imports them, so
`get_exposure` and `get_correlation` cannot report two different numbers for the same pair. Same
`LOOKBACK_DAYS = 60`, same "≥ 15 returns" minimum.

`hhi = Σ (marketValue_i / Σ marketValue)²` — weights **of the book**, not of equity, so cash does
not dilute the concentration reading. `weightPct` is of **equity** and comes from the broker's
`marketValue`, never from `snapshot.entryPrice`.

**Sector source.** `getSectorRaw` in `src/collect/yahoo.ts` —
`quoteSummary(symbol, { modules: ['assetProfile'] }, { validateResult: false })` →
`.assetProfile.sector`. It was `quoteSummary`'s first caller in the codebase.

**`src/collect/sectorCache.ts`** → `data/sectors.json`, `{ [symbol]: string }`, read once into a
module map, appended on a miss, synchronous writes inside `try/catch`. No TTL — a sector does not
change, and deleting the file is the invalidation. Two entry points:

- `getSectors(symbols)` — async, fetches misses.
- `getCachedSectors(symbols)` — **pure, non-network**, for P3's tick. A miss is `null`; warming
  happens when `get_exposure` runs. The tick never blocks on Yahoo.

A fetch failure or missing field is `sector: null` plus a caveat naming the symbols. ETFs
legitimately have no `assetProfile.sector` — that is a `null`, not an error.

**Tool `get_exposure`** — read-only, no arguments.

**`buildPortfolioContext`** now renders weight % and sector per position, and the bare
instruction that used to sit at `trader.ts:211` is replaced by measured numbers:

```
=== PORTFOLIO CONTEXT ===
  AMD    entry $142.10 SL $135.40 TP $162.00  9.8% Technology  age 3d
         MFE +6.1% / MAE -1.2% — "4/5 bullish, volume 0.82, MI300 ramp into Q4 guide…"
2 open positions — 4 slots remaining. Call get_positions for live qty and P&L.
Deployed 16.9% of equity. Max weight AMD 9.8%. Max sector Technology 9.8%. HHI 0.58.
Max held correlation 0.34 (AMD/XLE). get_exposure for the full breakdown.
```

`buildPortfolioContext` and `buildCycleContext` became `async`, and `runCycle` awaits the context
build. If `exposure()` throws, the block renders without the exposure columns plus one line saying
exposure was unavailable — a context builder must never take down a cycle.

### Traps this hit

- Weight must come from live `marketValue`, not `entryPrice`.
- Guard every division by `equity` and by `Σ marketValue` — a `NaN`/`Infinity` in a prompt is a
  fabricated number.
- The correlation matrix is O(n²) *pairs* but must be O(n) *fetches*: bars are fetched **once per
  symbol** and correlated in memory (≤ 6 fetches for `maxPositions: 6`, not ≤ 15).

### Done when — met

The model can state a sector weight and cite `get_exposure` for it, and `POLICY.md` no longer
asks for a judgment the system cannot inform.

---

## 7. P1 — The thesis, in front of the model — **SHIPPED**

**Closes gap 3. Size XS. No new file, no new schema, no new tool.**

### Why

`POLICY.md:27` says exit "when the thesis is done, not when it is uncomfortable". The thesis lived
in `data/journal.jsonl`, reachable only via `get_journal`, and the model had no reason to call it
for a position it could already see in context. So "is the thesis done" was decided without the
thesis.

### What shipped

`PositionSnapshot.entryDecisionId` already linked to the `DecisionRecord`.
`buildPortfolioContext` now renders, per position:

- **entry rationale**, truncated to ~140 chars, resolved through `entryDecisionId`
- **age**, from `openedAt` — "3d" / "4h" / "35m"
- **MFE / MAE**, from `sessionHigh` / `sessionLow` against `entryPrice`

MFE/MAE is the part that makes it actionable: *"+0.4 % now, +6.1 % at best"* is a different
decision from *"+0.4 % and never higher"*, and before this both rendered identically.

**Reuse:** one `readDecisions({ limit: 200 })` per cycle → `Map` by `id`. Not one read per
position.

Missing record, or a snapshot with no `entryDecisionId`, renders `"rationale not recorded"`. Never
a reconstruction — positions predating the `orderId`-linking work genuinely lack the link and must
read as absent. Missing baselines omit the MFE/MAE clause rather than printing `NaN`.

`PositionData` in `src/features/compute.ts` already carries `mfePct` / `maePct`, but that is a
`TickData` field and this is the trader context builder, which reads `state.positionSnapshots`. The
two numbers are computed here from the same three fields `compute.ts` uses, so they agree.

### Done when — met

An exit rationale in the journal can quote the entry rationale it is retiring, without the model
having called `get_journal`.

---

## 8. P2 — One benchmark number — **SHIPPED**

**Closes gap 4. Size S.**

### Why

Nine absolute statistics cannot answer "is this worth doing instead of holding SPY". One number
can.

### The conflation avoided

- `scorecard()` (`src/review/metrics.ts`) measures **realised round trips**, in dollars, with no
  capital base. Setting that sum beside SPY's percentage compares closed trades to continuous
  exposure — not a comparison at all.
- The honest pairing is **equity-curve total return vs SPY total return over the same sessions**,
  which needs a different source and a different unit.

So this is **not** a field inside `Scorecard`, and `Scorecard` now carries a caveat on every call
saying so and naming `get_benchmark`.

### What shipped

**`src/review/benchmark.ts`** — `benchmark({ days = 30 }): Promise<Benchmark>`:

```
window: { from, to, days, sessions }   // sessions = dates present in BOTH series
portfolioReturnPct  spyReturnPct  excessPct
portfolioSharpe     spySharpe            // annualised, ZERO risk-free on both legs
portfolioVolPct     spyVolPct            // annualised sd of daily returns
maxDrawdownPct      spyMaxDrawdownPct
caveats[]
```

`maxDrawdownPct` is an **equity-curve peak-to-trough in percent** and is *not*
`Scorecard.maxDrawdown`, which is a running sum over round-trip P&L in dollars and cannot see the
mark-to-market path of an open position. The two disagree and both are right; the field comment
says so.

Legs: `alpacaTrading.get('/v2/account/portfolio/history', { period: '<days>D', timeframe: '1D' })`
and `collectBars('SPY', days + 10, '1Day')`, fetched in parallel, then aligned **by ET date, never
by index**. Either leg can be absent and the other is still returned with a caveat naming which —
a zero standing in for the portfolio leg would read as "flat" rather than "unknown".

**Sharpe uses a zero risk-free rate on both legs**, deliberately: the comparison that matters is
against doing nothing, and the reference point is `spySharpe` beside it rather than a textbook
threshold. Stated as a caveat whenever a Sharpe is reported.

**`src/review/metrics.ts`** also gained the dispersion half of its own means, which needed no
network and no benchmark: `returnPctStdev`, `perTradeSharpe` (mean return over its sd),
`perTradeSharpeR` (same in units of declared risk), and `expectancyTStat` — how many standard
errors the mean return sits above **zero**, not above the sample's own mean, because a noisy mean
is an artificially low bar. `perTradeSharpe` is documented as *not* the Sharpe ratio: there is no
time in it, so an hourly and a weekly strategy score identically.

**Tool `get_benchmark(days?)`**, added to the concierge's shared set too. POLICY.md ADAPTATION:
*the benchmark is the scoreboard, the scorecard explains it* — plus the line that losing to the
index while making money is the finding most worth a `write_lesson`, since it is invisible without
the call.

### Traps this hit

- Alpaca reports **equity 0** for sessions before the account was funded. Treated as a level, that
  manufactures a −100 % day; they are dropped, which is why `sessions` ran 17 of 22 raw points on
  the first live probe.
- The two series must join on a date in **exchange time**. Equity is stamped at the ET close and a
  daily bar at the ET open; read in UTC, some of them roll onto the neighbouring date and the join
  goes one day out of step.
- `excessPct` is computed from **unrounded** returns, so it can differ by 0.01 from the two
  rounded fields beside it. That is correct and the alternative is worse.
- Cash movements are **detected and stated, never adjusted for** — `/v2/account/activities` with
  `activity_types: CSD,CSW,JNLC`, re-filtered locally because Alpaca's `after` is on activity
  creation. A flow-weighted return is not derivable from a daily series.
- Under `BROKER=ibkr` there is no equity curve to read: `alpacaTrading` reaches the Alpaca account
  only when that is the active broker. Returns the SPY leg plus an explicit caveat.

### Verified

`npx tsc --noEmit`, `npm run verify:policy`, and `tmp/probe-benchmark.ts` — 10 assertions against
live data, all passing: `spyReturnPct` against SPY closes fetched independently, sessions against
the independent bar count, `portfolioReturnPct` against the raw payload's first/last funded equity,
`excessPct` identity, non-negative drawdowns, the short-window and zero-risk-free caveats firing,
and `perTradeSharpe` / `expectancyTStat` against hand arithmetic.

### Done when — met

`get_benchmark` returns one number the model can quote, and the scorecard's role is explaining
that number rather than standing in for it.

---

## 9. P3 — Portfolio Doctor (the architectural piece)

**Closes gap 1. Size M. Two new event kinds, three new policy keys. Depends on P0. Unbuilt.**

### Why

Ten of eleven detectors are per-symbol. Six positions can each sit 1.5 % off entry — below
`triggers.positionDropPct` — while the book is down 6 % and 70 % concentrated in semis, and
**nothing fires**. The essay's "diagnosis" step has no home here yet.

### Part 1 — `TickData` gains a portfolio block

`src/features/compute.ts`. Add:

```ts
export interface PortfolioData {
  grossDeployedPct: number;     // percentage points
  maxWeightPct: number;
  maxWeightSymbol: string | null;
  hhi: number;
  maxSectorWeightPct: number;
  maxSectorName: string | null;
  equityPeak: number;           // dollars, monotonic, durable
  drawdownFromPeakPct: number;  // percentage points, ≥ 0
}
```

`computeTick` fills it from the `RawBundle` it already has (`src/collect/index.ts` — `positions`
carry `marketValue`, `account` carries `equity`) plus the sector cache from P0.

**Honour the file's stated invariant: NO NEW MATH IN `compute.ts`.** Call
**`concentration(positions, equity, sectors)`** from `src/strategy/exposure.ts` — P0 already
factored it pure and network-free for exactly this call site. Sectors come from
**`getCachedSectors`** (pure, no fetch): a cache miss is `null`, and warming happens when
`get_exposure` runs. `computeTick` must not add network calls to the 60 s tick.

### Part 2 — `equityPeak` in `SystemState`

`src/state/state.ts`. A monotonic max of account equity, written in **exactly one place**, the
same discipline `sessionHigh` gets.

**`resetDailyState` must not touch it.** It currently writes only `startOfDayEquity` and
`lastResetDate` — keep it that way. A peak that resets nightly measures nothing; that is precisely
why `trailingDrawdownDetector` measures from a durable `sessionHigh` rather than a ratcheting
baseline.

State persists to `data/state.json` with a 5 s debounce (`DEBOUNCE_MS`), so the peak survives
restarts. Seed it from current equity on first observation, and note in the file header which
fields are monotonic.

### Part 3 — Two detectors

New file `src/features/detectors/portfolio.ts`, modelled beat-for-beat on
`src/features/detectors/account.ts` (47 lines — the only existing account-level detector, and the
one whose header documents the unit trap). Register both in `src/features/detectors/index.ts`,
**risk-first**, i.e. beside `dailyLoss` near the top of the `DETECTORS` array.

**`portfolio_drawdown`**
- `crossing: { level: p.drawdownFromPeakPct, threshold: policy.triggers.portfolioDrawdownPct, direction: 'above', band: policy.triggers.hysteresisPct }`
- severity **`urgent`**, not critical. `daily_loss_breach` is the circuit breaker; this is a
  slower bleed that wants a decision, not a halt.
- `suggestedAction`: reduce exposure / review the book.
- evidence: peak, current equity, drawdown %, position count, gross deployed.

**`concentration_breach`**
- two hits, not one: single-name weight vs `policy.risk.maxSingleWeightPct`, and sector weight vs
  `policy.risk.maxSectorWeightPct`, both `direction: 'above'`.
- severity **`warn`**. Nothing needs unwinding this second — but note `buildMachineEvents`
  **filters `info` out of the rendered list entirely**, so `warn` is the floor for anything the
  model must actually see.
- **Use distinct cooldown keys** (e.g. `concentration_breach:single:AMD` and
  `concentration_breach:sector:Technology`) so a live single-name breach cannot mask a sector
  breach or vice versa. `disarm` writes `s.cooldowns[key]`; two facts sharing one key is one fact.

Add both kinds to the `EventKind` union in `eventBus.ts`.

### Policy additions

`src/policy/types.ts`, `src/policy/load.ts`, `policy/policy.yaml` — all three, or the loader
throws.

| Key | Block | Unit | Suggested |
|---|---|---|---|
| `portfolioDrawdownPct` | `triggers` | percentage points | `6` |
| `maxSingleWeightPct` | `risk` | percentage points | `15` |
| `maxSectorWeightPct` | `risk` | percentage points | `35` |

Validate with the existing `num(src, where, key, errs, {min,max,int})` helper in `load.ts`.
Consider an `immutable` ceiling for the sector cap, alongside `maxPositionsCeiling` etc.

**Percentage points for all three** (§5.1). Name the unit in the type comment.

### Verify — mandatory, this is state-machine code

`npm run replay`, adding scenarios via the existing `scenario(name, seed, body)` harness
(`src/scripts/replay.ts`; `slowBleed` is the complete template; assert with `checkCount`).
**Assert event counts, not presence** — the count is the only thing that distinguishes "detected"
from "detected once".

1. equity grinding down 0.5 %/tick past the threshold → `portfolio_drawdown` fires **exactly
   once**, not once per tick
2. equity recovering above the band, then re-breaching → fires **again** (hysteresis re-arms)
3. a peak set, `resetDailyState()` called, equity still below → **no** new event, and `equityPeak`
   is unchanged
4. concentration crossing 30 % then oscillating 29.8 / 30.2 → **one** event
5. a single-name breach and a sector breach live together → **two** events, neither suppressed

Then `npx tsc --noEmit`, `npm run verify:policy`.

### Done when

A book that is quietly bleeding or quietly concentrated wakes a cycle, and the replay suite proves
it wakes it once.

---

## 10. P4 — Position management: tighten-only stops + partial exits

**Closes gap 5. Size M. The only item that touches the guard layer. Unbuilt.**

### Why

`exitPosition` always sells `pos.qty` (`orderManager.ts:140`), and `stopLevel` is written once at
entry with no second writer. A position that ran +8 % and gave it all back is the most common way
this book loses money, and the agent has no verb for it.

Both new capabilities go **into `src/strategy/orderManager.ts`, beside `enterPosition` /
`exitPosition`** — for the reason the file header states: the guards are the first statements of
these functions, not of the tools that call them, so *below the decision maker means below every
caller*. Reuse `GuardRejection` and `reject()`; `rule` is a stable machine name because it lands
in the journal as `vetoRule` and has to be greppable months later.

### 10.1 `updateStop(symbol, stopLevel)` → tool `update_stop(symbol, stopLevel, reason)`

Guard rules:

| rule | condition |
|---|---|
| `no_position` | nothing open in `symbol` (mirror `exitPosition`'s check) |
| `no_stop_on_record` | the snapshot has no `stopLevel` — there is nothing to tighten *from*, and silently adopting one launders an unstopped position into a stopped one |
| `stop_not_tightened` | `stopLevel <= snapshot.stopLevel`. **This is the whole safety property.** A loosened stop is a renegotiated promise. |
| `invalid_intent` | non-finite, `<= 0`, or `>= last price` — a stop above the market is a market sell wearing a costume |

Then:
- write the new level with **`patchPositionSnapshot`**. **Not `openPositionSnapshot`** — that
  merges into the existing record (`const merged = existing ?? snap`) and would silently no-op on
  an update.
- journal a `DecisionRecord`: `kind: 'hold'`, `actor: 'trader'`, with `intendedStop` set, so
  `metrics.ts`'s `stopDiscipline` block still measures against a *declared* stop. Use the
  `decision(kind, actor, fields)` helper.
- note in the `state.ts` header that **`stopLevel` now has two writers** (entry + this) while
  `entryPrice` / `sessionHigh` / `sessionLow` still have exactly one.

Does this place a stop order at the venue? **No** — today's stops are synthetic: the detectors
watch `stopLevel` and the model exits. Keep that. Introducing real stop orders is a separate
decision about who owns the exit, and mixing the two would leave two stops disagreeing.

### 10.2 `exitPosition(symbol, reason, qty?)` → `execute_exit(symbol, reason, qty?)`

Omitted `qty` keeps today's full-exit behaviour **verbatim**. Guards: `invalid_intent` for
non-integer, `<= 0`, or `> pos.qty`.

**The landmine:** `toolExecuteExit` calls `removePositionSnapshot(symbol)` at
`traderTools.ts:1099`. A partial exit must **keep** the snapshot — same `entryPrice`, same
`sessionHigh` / `sessionLow`, same `openedAt`, same `entryDecisionId`. Only a sell that takes the
position to zero clears it:

```ts
const remaining = pos.qty - soldQty;
if (remaining <= 0) removePositionSnapshot(symbol);
```

Get this wrong and the entry baseline is lost mid-trade; every stop detector then measures against
nothing.

**Nothing downstream needs changing.** `computeOutcomes` in `src/review/ledger.ts` already matches
**flat-to-flat** with a running position counter (`if (position > 0) continue;`) and a qty-weighted
exit price, so a scale-out is one round trip, not two — verified on XLE: 434 bought in one order,
sold in two.

### Still forbidden

Adding to a position. `already_holding` stays. Averaging into a loser is not a capability worth
handing over, and the comment there already says adding to a winner is a different decision with a
different stop.

### POLICY.md

- CYCLE FRAMEWORK step 4 gains the new verbs.
- RISK RULES states the tighten-only rule as a rule, and lists `stop_not_tightened` /
  `no_stop_on_record` among the refusals the model must read rather than resubmit.
- **Do not call trimming "rebalancing."** There is no target allocation to rebalance toward, and
  the word would invite the model to claim one.

### Verify

1. `npx tsc --noEmit`
2. `tmp/probe-manage.ts` against the live paper account, asserting the refusals fire: loosening →
   `stop_not_tightened`; a stop above last → `invalid_intent`; `qty` above held →
   `invalid_intent`; unknown symbol → `no_position`. Each refusal must also appear in
   `data/journal.jsonl` with the right `vetoRule`.
3. One real partial exit on a live position, then assert: the snapshot **still exists** with the
   original `entryPrice`/`openedAt`, and after `reconcileFills()` the round trip is still **one**
   outcome, not two.
4. `npm run verify:policy`.

### Done when

A winner can be protected without being closed, and no path exists that widens a stop.

---

## 11. P5 — Earnings calendar — **SHIPPED**

**Size S. Independent of everything.** Shipped 2026-08-26, and **wider than this spec**: the same
`quoteSummary` call that carries the earnings date also carries crowding, liquidity, balance sheet
and estimate revisions, so a second tool over the same fetch and the same cache was built at the
same time rather than scraping Yahoo twice later. The spec below describes the calendar half only;
see *What shipped*.

### Why

A momentum book holding through an earnings print is a coin flip with gap risk no ATR stop
protects against — the stop is *jumped*, not hit. The example lesson written into `POLICY.md` is
literally about not checking the calendar. Today the only route to a date is `web_search`, the
least reliable tool in the box for a date.

### New: `get_calendar(symbol)`

```ts
{ symbol, nextEarningsAt: string | null, daysUntil: number | null,
  isEstimate: boolean, source: 'yahoo', caveats: string[] }
```

From `quoteSummary(symbol, { modules: ['calendarEvents'] }, { validateResult: false })` →
`.calendarEvents.earnings.earningsDate` (an **array**; take the earliest future entry).
`earningsDateEstimate` / a date with no time component means `isEstimate: true` — say so, since an
estimated date is a different input to a hold decision.

Cache for one day (§5.4) — dates move, unlike sectors, so this cache needs a TTL where
`data/sectors.json` does not. Model it on `src/collect/sectorCache.ts` and add the TTL. Unknown →
`null` + caveat. Never a guess.

### Prose first, guard later

Start with a POLICY.md rule ("do not open inside N days of earnings without naming the reason").
Promote it to a guard rule in `enterPosition` **only if the journal shows it being ignored** — that
is the same evidence standard the policy asks of the model.

### What shipped

Advisory only, as written above, from 2026-08-26: `enterPosition` was untouched and the rule lived
in prose. **Promoted to a guard on 2026-08-29**, once the evidence standard in *Prose first, guard
later* above was met (Rank 3 of #15: the rule was ignorable, and unlike a stop-loss violation an
earnings gap is not bounded by `stopLossAtrMult`). `earningsVeto` (pure) / `refuseIfEarningsWindow`
(fetch) in `src/strategy/orderManager.ts`, wired into `enterPosition` before the signal gate.
Refuses as `earnings_window` inside `risk.earningsBlackoutDays` (default 5, new policy field) of
`nextEarningsAt` — confirmed and estimated dates blocked identically, since the uncertainty POLICY.md
already named is about the day, not the risk, and gating only on confirmed dates would flap open the
moment an estimate firmed up. Fails **closed** as `earnings_unavailable` when the calendar can't be
read, mirroring `signals_unavailable`: no evidence, no position. Crypto is skipped before the fetch —
`getFundamentals` throws unconditionally for a crypto pair (no earnings calendar exists for one), so
without the skip every crypto entry would be refused forever, not just ones near a print.

- **`src/collect/yahoo.ts` → `getFundamentalsRaw(symbol)`.** Six modules in one call —
  `calendarEvents`, `defaultKeyStatistics`, `financialData`, `summaryDetail`, `earningsTrend`,
  `earningsHistory`. It **throws** where `getSectorRaw` swallows, because the cache has to be able
  to tell a failed call from a genuinely empty answer. Crypto pairs are rejected before the call
  (no earnings exists for `BTC/USD`); `BRK-B` is deliberately not, since the hyphen is Yahoo's own
  class-share spelling.
- **`src/collect/fundamentals.ts`** — `mapFundamentals()` is pure and owns every unit conversion
  and every caveat; `getFundamentals()` / `getFundamentalsBatch()` / `getCachedFundamentals()`
  follow the `sectorCache.ts` split. Cache is `data/fundamentals.json`, **not** the
  `data/calendar.json` named above: one fetch produces one entry serving both tools, so two files
  would mean two TTLs over one payload.
- **TTL is 24h *plus* an early-expiry rule** the spec above does not have: an entry is also stale
  once its `nextEarningsAt` has passed. The moment the print happens the cached date is wrong and
  the statements behind it are about to be restated, so age alone is the wrong test. `daysUntil` is
  recomputed on every read and never trusted from the file.
- **`get_calendar(symbol)`** — dates, the confirmed/estimated distinction, dividend dates, and the
  last four quarters of EPS surprise. **`get_fundamentals(symbol)`** — crowding, liquidity, balance
  sheet, revisions. Both carry `caveats[]` and `modulesPresent`.
- **`EARNINGS IN nD`** on venue-confirmed rows in PORTFOLIO CONTEXT, inside 14 days only, one
  batched resolve before the loop. An unreachable Yahoo says nothing rather than announcing the
  outage on every row.
- **Excluded on purpose:** `targetMeanPrice`, `recommendationMean`, `recommendationKey`,
  `numberOfAnalystOpinions`. Those are verdicts wearing numbers — someone else's conclusions, not
  measurements — and this system does not launder a verdict into evidence.

Three facts learned from the live feed, all of them now load-bearing:

1. **Units are mixed inside a single module.** `financialData.profitMargins` is a fraction;
   `financialData.debtToEquity` is already a percentage. Normalisation is per FIELD, never per
   module, and every scaled field says its unit in its name (`debtToEquityPct`).
2. **An ETF is a partial answer, not a blank.** XLE returns two of six modules — no
   `calendarEvents`, but real volume, a real 52-week range and a real `totalAssets`. So the caveat
   names *which modules are absent* and what each absence costs, and there is no `error` field on
   that path (`logger.ts:34` would render a normal ETF answer as `ERROR:`).
3. **`earningsHistory.history` is oldest-first**, and `earningsTrend` spells one field
   `downLast7Days` with a capital D where its siblings use lowercase.

### Verify

`npx tsc --noEmit`; `tmp/probe-fundamentals.ts` on NVDA / AAPL / XLE / BTCUSD asserting the unit
rules and the absent-module path; the TTL rules in **fresh processes** — `_cache` is memoized on
first read, so an in-process file edit is invisible to it; `npm run verify:policy`.

### Done when

The model can decline to hold through a print and cite a date it actually read. ✅

---

## 12. P6 — The slow loop

**Closes gap 6. Size S. One new event kind. Unbuilt.**

### Why

Cycles only ever wake mid-tape on a crossing, so no moment is reserved for the strategic pass —
the exposure read, the benchmark check, the "should this book look like this at all" question.
`review_ready` closed the reflection edge for *individual trades*; this closes it for the
*portfolio*. It is the cheapest structural win in this document.

### The hook already exists

`maybeReconcile` (`src/features/scheduler.ts`) already detects the session leaving `open`:

```ts
const closing = this.lastSession === 'open' && session !== 'open';
// ... await reconcileFills();  → publishReviewReady(this.policyOf());
```

Call the new publisher right after `publishReviewReady`.

### New file: `src/review/scheduledReview.ts`

Modelled beat-for-beat on `src/review/reviewReady.ts` (134 lines) — read that file first; every
decision in it applies here.

- **`publishDiscrete('portfolio_review', hit, policy)`**, not `processHits`. This is already an
  edge: there is no level to recross, so `isArmed` would fire once ever and hysteresis is
  meaningless — and `processHits` would write a `cooldowns` entry per firing, an unbounded leak
  into `data/state.json`.
- **The caller owns dedup**, via a `lastPortfolioReviewAt` watermark in `SystemState`. First run
  **adopts and logs** rather than announcing, exactly as `lastReviewedExitAt` does. Advance the
  watermark **after** publishing: a throw in between would lose the announcement, whereas
  re-announcing is merely noisy.
- **Never throws.** Wrap the body, log and return `[]` — same contract as `publishReviewReady`.
- Severity **`warn`**, `suggestedAction: 'reflect'`. Evidence carries the P0 exposure summary and
  the P2 benchmark number so the cycle *opens* with the diagnosis in hand. Degrade to whatever is
  available if P2 is not built yet.
- Cadence: once per session close, plus a weekly one at Friday's close (a distinguishable
  `scope: 'daily' | 'weekly'` in the evidence). **Not premarket** — nothing actionable happens
  before the open and the agent cannot trade then anyway.
- `resetDailyState` must not touch the watermark.

Add `portfolio_review` to the `EventKind` union in `eventBus.ts`.

### POLICY.md

Name it in ADAPTATION as the **second** exception to "WARN events are context", alongside
`review_ready`. Say what the cycle is for: read the exposure and the benchmark, decide whether a
rule changed, and usually write no lesson.

### Verify

`npm run replay` with scenarios asserting: first run is **silent** and adopts the watermark; a
rewound watermark yields **exactly one** `warn`/`reflect` event; an immediate re-run is silent;
**`state.eventCooldowns` is untouched** (the `publishDiscrete` leak check that the `review_ready`
probe already performs). Then `npx tsc --noEmit`, `npm run verify:policy`.

### Done when

Every session close puts the book — not a symbol — in front of the model exactly once.

---

## 13. Critical files

| Path | Used by |
|---|---|
| `src/strategy/exposure.ts` — `concentration()` (pure) + `exposure()` | P0 ✓, P3 |
| `src/collect/sectorCache.ts` — `getSectors()` / `getCachedSectors()` (pure) | P0 ✓, P3 |
| `src/strategy/portfolioRisk.ts` — `dailyReturns`, `pearsonCorrelation` (now exported) | P0 ✓ |
| `src/collect/yahoo.ts` — `getSectorRaw`, `getFundamentalsRaw`; `quoteSummary` + `{ validateResult: false }` | P0 ✓, P5 ✓ |
| `src/agents/trader.ts` — `buildPortfolioContext` / `buildCycleContext` (both async) | P0 ✓, P1 ✓ |
| `src/tools/traderTools.ts` — tool defs + `executeTraderTool` switch | P0 ✓, P5 ✓, P2, P4 |
| `src/review/benchmark.ts` *(new)* | P2 |
| `src/tools/alpacaDataTools.ts` — portfolio history | P2 |
| `src/features/compute.ts` — `TickData` + `PortfolioData`; NO-NEW-MATH invariant | P3 |
| `src/state/state.ts` — `equityPeak`, `lastPortfolioReviewAt`; `resetDailyState` untouched | P3, P6 |
| `src/features/detectors/portfolio.ts` *(new)* + `detectors/index.ts` | P3 |
| `src/features/detectors/account.ts` — the template, and the unit trap | P3 |
| `src/features/eventBus.ts` — `EventKind`; `publishDiscrete` | P3, P6 |
| `src/policy/types.ts`, `src/policy/load.ts`, `policy/policy.yaml` | P3 |
| `src/strategy/orderManager.ts` — `updateStop`, `exitPosition(qty?)` | P4 |
| `src/tools/traderTools.ts:1099` `removePositionSnapshot` — the partial-exit landmine | P4 |
| `src/review/scheduledReview.ts` *(new)*, modelled on `src/review/reviewReady.ts` | P6 |
| `src/features/scheduler.ts` — `maybeReconcile` | P6 |
| `src/scripts/replay.ts` — `scenario`, `checkCount`, `slowBleed` | P3, P6 |
| `policy/POLICY.md` | every P |

## 14. Verification — run in this order, every increment

1. **`npx tsc --noEmit`.** No test framework is configured; the compiler is the first gate.
2. **A probe script under `./tmp/`** — *not* `/tmp`, because of ts-node's `rootDir` — run with
   `npx ts-node tmp/probe-x.ts`, asserting against the live paper account. Per-increment
   assertions are listed in each work order.
3. **`npm run replay`** for anything touching detectors or state machines (P3, P6). **Assert event
   counts, not just presence.**
4. **`npm run verify:policy`** after every POLICY.md edit. `renderPolicy` throws on an unknown
   placeholder or a bad filter, and POLICY.md is **not** covered by the guarded reload that
   protects `policy.yaml` — a prose typo would otherwise brick the loop on first start.
5. **Read the rendered prompt.** Every increment adds prose the model will treat as fact. The
   check is the one this document opens with: **does every noun in the prompt have a tool that
   returns it?**
6. **`npm run dev` for one live cycle**, then read the log: confirm the model called the new tool
   and that its rationale quotes numbers the tool actually returned — not numbers a headline
   implied.
