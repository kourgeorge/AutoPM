# MMR vs. AutoTrade — code review

**Reviewed MMR revision:** `c8fde79` (cloned from `https://github.com/9600dev/mmr.git` to `~/repositories/mmr`)

**Refreshed 2026-09-03:** MMR's repo has not moved (still `c8fde79`, 0 new commits). AutoTrade has — from `c8e06d3` (this doc's original baseline) to `2f6e250`, plus uncommitted worktree changes. The sections below marked "(updated)" reflect that work; everything else was re-checked and still holds.

## Executive assessment

MMR is the closest open-source competitor/peer examined so far. It is an IBKR-first, Python, LLM-native trading platform with an explicit command/tool surface for an LLM loop. Both systems separate model reasoning from deterministic controls, calculate ATR-based sizing and portfolio risk, reconcile broker state, retain audit history, and support ongoing autonomous monitoring. The principal product difference is orientation: **MMR is a general-purpose, service-oriented IBKR trading platform for a CLI/agent workflow; AutoTrade is a more opinionated autonomous momentum-trading application with an integrated LLM Trader, operator Concierge, event/wake system, and interactive approval UX.**

MMR is materially larger at this revision: approximately 99,792 lines across tracked Python/JS-family source and test files when excluding dependency/build directories, compared with AutoTrade's approximately 28,955 lines under the same broad counting approach at the original review. AutoTrade's tracked `.ts`/`.js` source is now approximately 22,600–22,800 lines by a narrower count (`src/` + `policy/`, no tests/docs) — the two counts aren't directly comparable methodologically, but the direction hasn't changed: MMR remains roughly 3-4x larger. The figure is approximate and includes MMR's web/front-end code and test code, so it is a complexity signal rather than a direct implementation-size comparison.

## Strong overlap

| Area | MMR | AutoTrade |
|---|---|---|
| LLM-native operation | CLI exposes JSON for an LLM loop: monitor → analyze → propose → digest → sleep | Native LLM Trader loop plus separate persistent Concierge |
| Broker | IBKR via `ib_async`; paper/live configuration | Alpaca plus IBKR via `@stoqey/ib` |
| Deterministic risk boundary | Pre-trade risk gate; filters; leverage/margin checks; rate/turnover limits | `orderManager` checks intent, stop, daily loss, max positions, duplicate holding, buying power, regime sizing, **book-wide gross-exposure cap (updated)** |
| Sizing | Confidence-, ATR-, liquidity-, and spread-adjusted sizing | Inverse-ATR sizing plus macro-regime reduction |
| Portfolio risk | HHI, gross/net exposure, group budgets, correlation clusters | Weights, sector exposure, HHI, pairwise correlations, candidate correlation gate, gross-exposure ceiling, **`portfolio_drawdown`/`concentration_breach` detectors running every tick, not just on explicit request (updated)** |
| Protective orders at the venue | GTC stop, trailing-stop, and full bracket (stop+take-profit) order types | **GTC-equivalent resting sell stop only (updated, was: none)** — tighten-only, self-healing sweep re-arms/re-clears it; no broker-resident take-profit leg or true trailing-stop order type yet (trailing is simulated in the backtest engine only) |
| Auditability | DuckDB event and proposal stores; proposal state machine | Append-only JSONL decision/fill journal, state, and lessons file |
| Reconciliation | Compares proposals/orders/fills/positions and detects unprotected positions | Startup plus periodic fill reconciliation and round-trip scorecards; **`sweepStops` self-heals a missing/stale venue stop every tick (updated)** |
| Backtest | Strategy backtester with next-open default, slippage, costs, sweeps, statistical confidence, walk-forward PBO, mutation testing | **New (updated): `src/backtest/` engine** — next-bar-open fills, slippage-adjusted, no lookahead by construction, reuses production's own veto chain, parameter sweep (81 grid points x 2 splits x 47 symbols), optional AI-driven decision layer with cost caching, SPY benchmark comparison, win-rate/profit-factor/Sharpe/drawdown metrics. No commission modeling, no statistical significance testing, no walk-forward overfitting check, no mutation testing of the strategy code |
| Strategies | Momentum, mean reversion, breakout scanning/strategy runtime | Current integrated momentum policy/indicator engine |

## MMR advantages worth studying

### 1. Broker-native protection — narrowed significantly, not fully closed (updated 2026-09-03)
MMR supports IBKR-native stop, trailing-stop, and bracket orders. Its protective-stop module (`trader/trading/protective_stop.py`) deliberately places a GTC stop designed to survive a dead data feed or strategy process, prevents overselling (clamped to `min(attributed, broker)`), and refuses an unrepresentable stop price (floors rather than rounds) rather than placing a stop at/above entry. Its reconciliation reports positions with no broker-side protection.

**AutoTrade closed the core gap, but not the full one.** Commit `63b77e6` ("the recorded stop also rests at the venue") added `src/strategy/stopOrders.ts`: the recorded `stopLevel` is now also a real resting sell stop at the broker (Alpaca mints a new id on replace, IBKR amends in place — `moveStopTo` never cancel-then-places, which would open an unprotected window). `sweepStops()` runs every tick and self-heals: arms a missing stop, clears a stale order id that's no longer resting, and reports the reason it *can't* protect a symbol (e.g. crypto pairs, which Alpaca won't take a plain stop order on) rather than failing silently. Tighten-only (`canTighten`), same "never loosen" discipline as MMR's floor-not-round logic. Functionally this is very close to MMR's `protective_stop_plan` — both are a pure sizing/pricing decision plus an idempotent placement path, both refuse rather than place a stop at/above entry.

**What's still missing relative to MMR:** AutoTrade only rests the *stop* leg. The take-profit target lives in `state.json` and is watched by the model/detectors, never placed at the broker — so a gap-through-target while the daemon is down is not protected, only a gap-through-stop is. There's also no true trailing-stop *order type* at the broker (AutoTrade's `stop_trailing` mode exists only inside the backtest engine, as a simulated recompute-and-tighten each bar, not a resting venue order). MMR's bracket/trailing primitives cover both directions natively.

### 2. Proposal workflow is more explicit and durable
MMR has a persisted lifecycle: `PENDING → APPROVED → EXECUTED`, with `REJECTED`, `EXPIRED`, and `FAILED` terminal states. It uses compare-and-swap transitions to avoid concurrent approval races, then re-resolves/reprices/re-sizes before execution. Optional server-side approval tiers require an out-of-band approver key above a notional threshold.

**AutoTrade comparison:** AutoTrade has a strong last-mile human `y/n` gate for live entries and exits, but it does not currently model an independently reviewable, persisted proposal object/state machine. MMR is better for asynchronous review queues or agent/human separation; AutoTrade is better for immediate interactive supervision in its terminal UI.

### 3. Backtest and research validation — gap narrowed, MMR still ahead on validation rigor (updated 2026-09-03)
MMR's backtester defaults to next-bar-open fills, can model slippage/commission/borrow costs, supports live-like execution semantics, parameter sweeps, stored results, and statistical confidence tests (`trader/simulation/backtest_stats.py`). It contains lookahead checks (`scripts/crosshair_check.py`), walk-forward probability-of-backtest-overfitting work (`scripts/momentum_wf_pbo.py`), negative-control tests (`scripts/negative_control.py`), and mutation-testing gates against the strategy code (`scripts/mutation_score.py`, `scripts/run_mutation.py`) — a materially deeper validation stack than execution simulation alone.

**AutoTrade added a real execution-aware backtest engine**, not just the detector/gate replay harness this line originally described. `src/backtest/engine.ts` fills next-bar-open, slippage-adjusted, and is no-lookahead by construction (every decision for day *t* reads bars only through *t*'s close); it reuses production's actual veto chain (`entrySignalVeto` → `positionSizeVeto` → `exposureVeto` → daily-loss state) rather than reimplementing it, which is the harder-won form of realism. It supports a parameter sweep (`backtestSweep.ts`, 81 grid points × 2 time splits × 47 symbols) and stability-across-neighbors checks in the sweep report, an optional AI-driven decision layer (L1.5) with a decision cache so re-running mechanical params doesn't re-pay for AI calls, a SPY benchmark comparison (`benchmarkStats.ts`), and standard trade metrics (win rate, profit factor, Sharpe, drawdown).

**Where MMR still leads:** AutoTrade's engine models only slippage (0.05%, no commission — stated explicitly as a caveat in every report), has no statistical significance/confidence testing on results, no walk-forward overfitting check, and no mutation/property testing of the strategy code itself. MMR's validation stack asks "is this edge real, or did I p-hack the parameter grid" in a way AutoTrade's sweep report does not yet.

### 4. Execution authorization is unusually deliberate
MMR uses an `ApprovedOrder` capability token at the IB placement choke point. Non-exit orders must carry a passing risk-gate record; exits are treated separately so a risk check cannot prevent a risk-reducing close. The source documents residual threat model boundaries rather than claiming perfect isolation. This is a strong pattern to study for AutoTrade’s TypeScript broker interface.

### 5. Data and deployment platform breadth
MMR has distinct trading, data, and strategy services linked via ZeroMQ; DuckDB persists data/audit state; it offers Dockerized IB Gateway deployment, Massive/IB/TwelveData history paths, options/FX/universe tooling, and a wide CLI surface. AutoTrade is intentionally smaller and more integrated, which is an advantage for a single operator but limits it as a general trading platform.

## AutoTrade advantages and differentiation

### 1. A real in-product agent/operator experience
AutoTrade’s Trader and Concierge are native application components, not an external Claude Code loop driven by shell commands. It has a dedicated terminal UI, a persistent operator conversation, structured alert routing, and a deterministic event registry. MMR’s documented primary LLM integration is Claude Code using the MMR JSON CLI.

### 2. Better event escalation and attention management (strengthened, updated 2026-09-03)
AutoTrade's scheduler, edge/hysteresis/cooldown gates, severity routing, critical re-escalation, and wake-pending handling form a mature operational attention system. It avoids both constant LLM polling and lost mid-cycle alerts. MMR describes a monitor/analyze/propose loop and strategy-service reconciliation, but its repository does not present the same event-to-agent wake/escalation product model.

Since the original review, this got measurably wider: `portfolio_drawdown` and `concentration_breach` detectors (commit `0bab3e5`) now run against a `PortfolioData` snapshot on every tick — previously the only paths to this data were an explicit `get_exposure` call or the scheduled close review, so a slow equity bleed or a position drifting past its weight limit between reviews went unseen. A separate `portfolio_review` nudge (commit `ed2997d`, "P6") fires once per session close with the whole book's shape — deployed %, cash, largest name, HHI, sector weights, day P&L, any position missing a recorded stop — synchronously and off the same pure `concentration()` call the detectors just used, so it can't drift from what the detectors already judged. Both are exactly the kind of proactive, non-polling attention primitive this section already credited AutoTrade for; there are just more of them now.

### 3. Strong decision-memory design
AutoTrade distinguishes three durable records: broker-derived fills for numerical truth, journal records for decision rationale, and `LESSONS.md` for conclusions. It injects controlled evidence into each new LLM cycle. MMR has an event/proposal audit trail and snapshots/diffs, but AutoTrade’s explicit learning loop and rationale-to-outcome review are a clearer product differentiator.

### 4. Multi-broker positioning
AutoTrade is designed around both Alpaca and IBKR. MMR is deeply IBKR-specific. AutoTrade can differentiate as a broker-neutral LLM trading operating layer, retaining an IBKR-focused execution hardening path without giving up Alpaca support.

### 5. Policy model and interactive approval semantics
AutoTrade’s policy YAML has immutable ceilings, safe hot reload, and live/paper identity derived from actual broker endpoints. Its live approval flow is deterministic and cannot be answered by the Concierge. MMR has robust config and optional proposal/approver-key controls, but `require_proposal_approval` and `approver_required_above_usd` are disabled by default in its shipped config. AutoTrade’s safer live default is an important positioning point.

## Recommended competitive interpretation

MMR is not merely a competitor: it is the most relevant open-source design benchmark for AutoTrade’s execution, broker-native protection, persisted proposal review, and research/backtesting layers. The product overlap is high enough that a market comparison should treat it as a direct peer for "LLM-native IBKR algorithmic trading." However, MMR is a platform/toolkit; AutoTrade can position as the safety-first autonomous trading operator that pairs deterministic event monitoring, human oversight, a conversational interface, and evidence-backed learning with broker execution.

## Prioritized ideas to evaluate for AutoTrade

1. **~~Broker-native protective orders~~ — done for the stop leg (2026-08-28, `63b77e6`); take-profit/bracket leg still open.** A resting sell stop now exists at the venue with a self-healing sweep. Remaining work: place the take-profit as a real broker order (currently internal-only) and/or a true trailing-stop order type, rather than requiring the daemon to be running to act on either.
2. **Persisted proposal state machine:** Add `PENDING → APPROVED → EXECUTED/FAILED/REJECTED` objects. Preserve the current terminal approval UX as one approval method, not as the entire workflow. *(Still open — no evidence this changed.)*
3. **~~Execution-aware historical research~~ — done as a first layer (2026-08-24, `6936379`); validation rigor still open.** `src/backtest/` now gives next-open fills, slippage, no-lookahead, and parameter sweeps. Remaining work: commission/cost modeling, statistical significance testing on results (bootstrap/confidence intervals, matching MMR's `backtest_stats.py`), a walk-forward overfitting check comparable to `momentum_wf_pbo.py`, and treating the strategy code itself as a test target (mutation testing) rather than only the harness around it.
4. **Authorization capability / single execution choke point:** Adapt MMR's `ApprovedOrder` pattern conceptually in TypeScript so an order cannot reach any broker adapter without deterministic authorization evidence. *(Still open.)*
5. **~~Protective-order reconciliation~~ — largely done via `sweepStops()` (2026-08-28).** It already self-heals every tick: arms what should be armed, clears a stale order id no longer resting, and logs the reason once per symbol rather than re-warning every cycle. `venueStopId`/`venueStopMissing` on the entry `DecisionRecord` are the durable account of why a position went unprotected. What it does *not* yet reconcile is a take-profit leg, since none is placed at the venue — once idea #1's remaining half lands, this item should be revisited to cover it too.

## Verification performed

- Cloned MMR successfully into `/Users/georgekour/repositories/mmr`; origin points to `https://github.com/9600dev/mmr.git`; HEAD at review was `c8fde79`.
- Inspected MMR README, project config, risk gate, proposal/approval model, portfolio-risk implementation, protective-stop logic, approved-order authorization token, reconciliation, auto-executor, backtester, and defaults.
- AutoTrade baseline already verified in this session: TypeScript build passed; detector/gate replay passed all 87 checks; policy render verification passed.
- MMR's full test suite was not run locally because this environment's `python3` is 3.9.6 while MMR requires Python >=3.12. No dependency installation or broker/service process was started.

### Refresh — 2026-09-03

- Confirmed MMR has not changed (`git log c8fde79..HEAD` = 0 commits in `~/repositories/mmr`).
- Confirmed AutoTrade moved from `c8e06d3` (this doc's original baseline) to `2f6e250`, plus uncommitted worktree changes to `policy/`, `src/agents/`, `src/strategy/`, `src/tools/`, `src/review/` (the `policy/POLICY.md` → `policy/PLAYBOOK.md` rename is cosmetic and doesn't change any claim in this doc).
- Read `src/strategy/stopOrders.ts` in full and compared it against MMR's `trader/trading/protective_stop.py` and its bracket/trailing-order support (`trader/trading/order_structure.py`, `executioner.py`) — updated the protective-orders sections above.
- Read `src/backtest/engine.ts` in full, and grepped `metrics.ts`/`benchmarkStats.ts`/`report.ts` for commission and statistical-confidence support (none found) against MMR's `trader/simulation/backtest_stats.py` and `scripts/momentum_wf_pbo.py`/`negative_control.py`/`mutation_score.py` (confirmed present) — updated the backtest sections above.
- Read the commit messages/diffs for `167f2e2` (gross-exposure cap), `0bab3e5` (portfolio drawdown/concentration detectors), `ed2997d` (portfolio_review), `beec754` (trim exits), and `7b7aa91` (IBKR rejection surfacing) to confirm they matched their stated scope before citing them.
- Did not re-run MMR's test suite or AutoTrade's full build/replay in this pass — no code changed as part of this refresh, only this document.
