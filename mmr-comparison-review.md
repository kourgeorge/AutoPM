# MMR vs. AutoTrade — code review

**Reviewed MMR revision:** `c8fde79` (cloned from `https://github.com/9600dev/mmr.git` to `~/repositories/mmr`)

## Executive assessment

MMR is the closest open-source competitor/peer examined so far. It is an IBKR-first, Python, LLM-native trading platform with an explicit command/tool surface for an LLM loop. Both systems separate model reasoning from deterministic controls, calculate ATR-based sizing and portfolio risk, reconcile broker state, retain audit history, and support ongoing autonomous monitoring. The principal product difference is orientation: **MMR is a general-purpose, service-oriented IBKR trading platform for a CLI/agent workflow; AutoTrade is a more opinionated autonomous momentum-trading application with an integrated LLM Trader, operator Concierge, event/wake system, and interactive approval UX.**

MMR is materially larger at this revision: approximately 99,792 lines across tracked Python/JS-family source and test files when excluding dependency/build directories, compared with AutoTrade’s approximately 28,955 lines under the same broad counting approach. The figure is approximate and includes MMR’s web/front-end code and test code, so it is a complexity signal rather than a direct implementation-size comparison.

## Strong overlap

| Area | MMR | AutoTrade |
|---|---|---|
| LLM-native operation | CLI exposes JSON for an LLM loop: monitor → analyze → propose → digest → sleep | Native LLM Trader loop plus separate persistent Concierge |
| Broker | IBKR via `ib_async`; paper/live configuration | Alpaca plus IBKR via `@stoqey/ib` |
| Deterministic risk boundary | Pre-trade risk gate; filters; leverage/margin checks; rate/turnover limits | `orderManager` checks intent, stop, daily loss, max positions, duplicate holding, buying power, regime sizing |
| Sizing | Confidence-, ATR-, liquidity-, and spread-adjusted sizing | Inverse-ATR sizing plus macro-regime reduction |
| Portfolio risk | HHI, gross/net exposure, group budgets, correlation clusters | Weights, sector exposure, HHI, pairwise correlations, candidate correlation gate |
| Auditability | DuckDB event and proposal stores; proposal state machine | Append-only JSONL decision/fill journal, state, and lessons file |
| Reconciliation | Compares proposals/orders/fills/positions and detects unprotected positions | Startup plus periodic fill reconciliation and round-trip scorecards |
| Backtest | Strategy backtester with next-open default, slippage, costs, sweeps and statistical confidence | Detector/gate replay harness, not a full execution-aware historical backtest |
| Strategies | Momentum, mean reversion, breakout scanning/strategy runtime | Current integrated momentum policy/indicator engine |

## MMR advantages worth studying

### 1. Broker-native protection is a major operational advantage
MMR supports IBKR-native stop, trailing-stop, and bracket orders. Its protective-stop module deliberately places a GTC stop designed to survive a dead data feed or strategy process, prevents overselling, and refuses an unrepresentable stop price rather than placing a stop at/above entry. Its reconciliation reports positions with no broker-side protection.

**AutoTrade gap:** AutoTrade currently submits market orders only. Its stop/target levels are internal baselines and a breach must lead to a later `execute_exit`; a daemon/feed failure, or a live approval timeout, can leave a position without broker-resident protection. This is the clearest candidate for a future AutoTrade improvement.

### 2. Proposal workflow is more explicit and durable
MMR has a persisted lifecycle: `PENDING → APPROVED → EXECUTED`, with `REJECTED`, `EXPIRED`, and `FAILED` terminal states. It uses compare-and-swap transitions to avoid concurrent approval races, then re-resolves/reprices/re-sizes before execution. Optional server-side approval tiers require an out-of-band approver key above a notional threshold.

**AutoTrade comparison:** AutoTrade has a strong last-mile human `y/n` gate for live entries and exits, but it does not currently model an independently reviewable, persisted proposal object/state machine. MMR is better for asynchronous review queues or agent/human separation; AutoTrade is better for immediate interactive supervision in its terminal UI.

### 3. Backtest and research validation are much more mature
MMR’s backtester defaults to next-bar-open fills, can model slippage/commission/borrow costs, supports live-like execution semantics, parameter sweeps, stored results, and statistical confidence tests. It contains lookahead checks, walk-forward work, and selection-bias code. AutoTrade’s tested replay harness is excellent for event correctness and safety gates but does not yet test the strategy’s historical execution and performance at MMR’s depth.

### 4. Execution authorization is unusually deliberate
MMR uses an `ApprovedOrder` capability token at the IB placement choke point. Non-exit orders must carry a passing risk-gate record; exits are treated separately so a risk check cannot prevent a risk-reducing close. The source documents residual threat model boundaries rather than claiming perfect isolation. This is a strong pattern to study for AutoTrade’s TypeScript broker interface.

### 5. Data and deployment platform breadth
MMR has distinct trading, data, and strategy services linked via ZeroMQ; DuckDB persists data/audit state; it offers Dockerized IB Gateway deployment, Massive/IB/TwelveData history paths, options/FX/universe tooling, and a wide CLI surface. AutoTrade is intentionally smaller and more integrated, which is an advantage for a single operator but limits it as a general trading platform.

## AutoTrade advantages and differentiation

### 1. A real in-product agent/operator experience
AutoTrade’s Trader and Concierge are native application components, not an external Claude Code loop driven by shell commands. It has a dedicated terminal UI, a persistent operator conversation, structured alert routing, and a deterministic event registry. MMR’s documented primary LLM integration is Claude Code using the MMR JSON CLI.

### 2. Better event escalation and attention management
AutoTrade’s scheduler, edge/hysteresis/cooldown gates, severity routing, critical re-escalation, and wake-pending handling form a mature operational attention system. It avoids both constant LLM polling and lost mid-cycle alerts. MMR describes a monitor/analyze/propose loop and strategy-service reconciliation, but its repository does not present the same event-to-agent wake/escalation product model.

### 3. Strong decision-memory design
AutoTrade distinguishes three durable records: broker-derived fills for numerical truth, journal records for decision rationale, and `LESSONS.md` for conclusions. It injects controlled evidence into each new LLM cycle. MMR has an event/proposal audit trail and snapshots/diffs, but AutoTrade’s explicit learning loop and rationale-to-outcome review are a clearer product differentiator.

### 4. Multi-broker positioning
AutoTrade is designed around both Alpaca and IBKR. MMR is deeply IBKR-specific. AutoTrade can differentiate as a broker-neutral LLM trading operating layer, retaining an IBKR-focused execution hardening path without giving up Alpaca support.

### 5. Policy model and interactive approval semantics
AutoTrade’s policy YAML has immutable ceilings, safe hot reload, and live/paper identity derived from actual broker endpoints. Its live approval flow is deterministic and cannot be answered by the Concierge. MMR has robust config and optional proposal/approver-key controls, but `require_proposal_approval` and `approver_required_above_usd` are disabled by default in its shipped config. AutoTrade’s safer live default is an important positioning point.

## Recommended competitive interpretation

MMR is not merely a competitor: it is the most relevant open-source design benchmark for AutoTrade’s execution, broker-native protection, persisted proposal review, and research/backtesting layers. The product overlap is high enough that a market comparison should treat it as a direct peer for "LLM-native IBKR algorithmic trading." However, MMR is a platform/toolkit; AutoTrade can position as the safety-first autonomous trading operator that pairs deterministic event monitoring, human oversight, a conversational interface, and evidence-backed learning with broker execution.

## Prioritized ideas to evaluate for AutoTrade

1. **Broker-native protective orders:** Add optional bracket/stop/trailing orders at entry, confirm their presence through reconciliation, and retain AutoTrade’s internal detector as a secondary monitor rather than the sole protection.
2. **Persisted proposal state machine:** Add `PENDING → APPROVED → EXECUTED/FAILED/REJECTED` objects. Preserve the current terminal approval UX as one approval method, not as the entire workflow.
3. **Execution-aware historical research:** Add `backtesting.py` as a quick first layer or adopt a dedicated simulator; test with next-open fill assumptions, costs, slippage, and no-lookahead checks before evaluating a larger engine such as NautilusTrader.
4. **Authorization capability / single execution choke point:** Adapt MMR’s `ApprovedOrder` pattern conceptually in TypeScript so an order cannot reach any broker adapter without deterministic authorization evidence.
5. **Protective-order reconciliation:** Promote “broker-native stop coverage” to a first-class health item. Current AutoTrade rightly reports venue orders and internal baseline coverage as different concepts; add a desired policy that establishes and verifies both.

## Verification performed

- Cloned MMR successfully into `/Users/georgekour/repositories/mmr`; origin points to `https://github.com/9600dev/mmr.git`; HEAD at review was `c8fde79`.
- Inspected MMR README, project config, risk gate, proposal/approval model, portfolio-risk implementation, protective-stop logic, approved-order authorization token, reconciliation, auto-executor, backtester, and defaults.
- AutoTrade baseline already verified in this session: TypeScript build passed; detector/gate replay passed all 87 checks; policy render verification passed.
- MMR’s full test suite was not run locally because this environment’s `python3` is 3.9.6 while MMR requires Python >=3.12. No dependency installation or broker/service process was started.
