# AutoTrade — market research & competitive landscape

**Date:** 2026-10-19. **Method:** GitHub API (stars, last push, license, all fetched live on this date), project READMEs, and vendor homepages/pricing pages fetched live. Existing repo context: `README.md`, `competition-research-brief.md`, `mmr-comparison-review.md`.

**Confidence labels:** **[V]** = verified from a source fetched in this session. **[K]** = from general knowledge, not re-verified today (treat as a lead, not a fact). I had no general web-search tool, so coverage of closed-source commercial products is thinner than for open source.

## 1. What AutoTrade is (the frame for "competition")

A local, single-user, LLM-supervised equity trading app for Alpaca and IBKR. Its distinguishing traits, all from the repo:

- Deterministic execution queue with durable action states (`pending → approved → executing → submitted → executed`), a stable client order ID, and no blind retry.
- Approvals bound to strategy revision, quantity and expiry. Manual approval is the default for new accounts.
- Hard risk checks below the LLM (stops, daily-loss halt, volatility targeting, sector/gross caps, earnings blackout, IOC-limit entries).
- Resting broker-side stops with a self-healing sweep.
- Append-only journals, fills as the source of P&L, and a lessons loop.
- Separate Trader, Researcher and Assistant agents, with a TUI and a web UI.
- Local-only, with no SaaS, no custody and no login.

Competition therefore splits into five segments (§2–§6). The relevant question for each is "who else lets an LLM act on a real brokerage account, and under what controls?"

## 2. Segment A — Direct: open-source LLM trading agents

| Project | Stars | Last push | License | What it is | Real-money execution? |
|---|---:|---|---|---|---|
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) **[V]** | 112,005 | 2026-10-16 | Apache-2.0 | Multi-agent LLM framework (analysts → debate → trader → portfolio manager). | Research framework; orders go to a *simulated exchange*. README: "designed for research purposes". |
| [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) **[V]** | 64,085 | 2026-10-02 | MIT | "AI Hedge Fund Team": persona agents (Buffett-style etc.). Has paper-trading funds with an approval step and a hash-chained ledger. | No. README: "not intended for real trading". |
| [ginlix-ai/LangAlpha](https://github.com/ginlix-ai/LangAlpha) **[V]** | 1,823 | 2026-10-19 | Apache-2.0 | "The harness for agentic trading". Agents research, build a thesis and trade *your own brokerage account within permissions you set*. Claims host-enforced limits, an approval queue, and an order that runs exactly once. | **Yes. Closest conceptual rival to AutoTrade's safety positioning.** Python 3.13, LangChain; also a hosted version at langalpha.ai. |
| [JakeNesler/OpenProphet](https://github.com/JakeNesler/OpenProphet) **[V]** | 113 | 2026-10-19 | not checked | Autonomous heartbeat-loop agent, Claude via OpenCode, Node + Go backend, 45+ MCP tools with permission gates, web dashboard, Alpaca paper/live (options-oriented). Bloomberg coverage (May 2026). Sells paid setup guides and templates. | Yes, but README says "paper trading only" and "research project". |
| [huygiatrng/AlpacaTradingAgent](https://github.com/huygiatrng/AlpacaTradingAgent) **[V]** | 277 | 2026-10-08 | not checked | TradingAgents fork wired to Alpaca live and paper, crypto, margin and shorting, web UI. | Yes, "educational" disclaimer. |
| [9600dev/mmr](https://github.com/9600dev/mmr) **[V]** | 131 | 2026-09-14 | NOASSERTION | IBKR-first Python platform driven by Claude Code via a JSON CLI. Proposal state machine, bracket/trailing orders, deep backtest validation. | Yes. Detailed comparison in `mmr-comparison-review.md`. |
| [yebof/quant-agent](https://github.com/yebof/quant-agent) **[V]** | 11 | 2026-10-09 | – | 9-agent LLM system for US equities. | Not checked |
| [euriska/opentrader](https://github.com/euriska/opentrader) **[V]** | 7 | 2026-07-19 | – | Multi-broker (Tradier, Alpaca, Webull) with LLM. | Not checked |
| [renee-jia/trading-bot](https://github.com/renee-jia/trading-bot) **[V]** | 94 | 2026-10-07 | – | Multi-agent macro bot with multi-factor scoring and momentum portfolio construction. | Not checked |
| TradingGoose, swarm-trader, matthewchung74/llm_trader, googly0/TradingAgent **[V]** | 1–80 | various | – | Small TradingAgents-style or persona-agent projects. | Mostly hobby-grade |
| [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) **[V]** | 21,422 | 2026-09-23 | MIT | Finance-tuned LLMs and sentiment. | Component, not an executor |
| [AI4Finance-Foundation/FinRL](https://github.com/AI4Finance-Foundation/FinRL) **[V]** | 16,744 | 2026-10-13 | MIT | Reinforcement-learning trading research. | Research |

**Takeaways**
- Mindshare is dominated by research frameworks that **do not trade real money** (TradingAgents, ai-hedge-fund). Those are not substitutes for a real execution layer, but they set user expectations and supply the "multi-agent analyst" narrative AutoTrade deliberately rejects (see `roadmap.md` §3).
- The executing projects are mostly small (≤ ~300 stars) and few of them document safeguards. **LangAlpha is the one to watch.** It is actively maintained (pushed today), explicitly positions on "limits that hold whatever the model does", and also ships a hosted product.
- Thin wrappers around broker MCP servers are a growing long tail: OpenProphet, `pedrobraiti/agentic-trading-mcp`, `GaoChX/ibkr-mcp-server`, `jinyiabc/ibkr-mcp`, `lukeplausin/mcp-server-trading212` **[V]**, all < 120 stars.

## 3. Segment B — Broker-native AI agents & MCP (the biggest strategic threat)

| Player | Evidence | Why it matters |
|---|---|---|
| **Public.com** **[V]** | Homepage: "Build AI trading agents". `public.com/ai-agents` shows a prompt-to-agent builder and a marketplace (e.g. covered calls, CPI hedge, idle-cash sweep), a Trading API, and a "Public MCP: trade through ChatGPT, Claude". Disclaimer: "Agentic Brokerage". | A US broker now ships natural-language agents that trade inside the account. It is the mainstream, zero-setup version of AutoTrade's pitch. Custodial and hosted. |
| **Alpaca** **[V]** | Official [`alpaca-mcp-server`](https://github.com/alpacahq/alpaca-mcp-server) (MIT, 1,027★, pushed 2026-10-12) lets an LLM trade stocks, ETFs, crypto and options and pull data. Also `alpaca-py` (1,557★). | AutoTrade's own broker supplies the raw "LLM can place orders" capability. This **commoditises bare LLM→order plumbing**. Differentiation has to be the controls, queue, audit and lifecycle on top. |
| **Composer by SoFi** **[V]** | Pricing page: Starter $0, Advanced $10/mo. "Build trading algorithms with AI, backtest them, then execute". No-code strategy editor, "Trade with AI", automated strategies. | Retail no-code AI automation, now free to start and owned by SoFi. Strategy-as-logic-tree rather than a free-running agent. |
| **Interactive Brokers** | IBKR's own MCP or AI offerings: **not verified**, no evidence found in this session. | Worth checking directly; it would be the IBKR-side analogue of Alpaca's MCP server. |
| Robinhood, Schwab, Webull, tastytrade, Tradier | Third-party MCP wrappers for Robinhood and Schwab exist **[V]** (`open-stocks-mcp`, 11★). First-party agent features **not verified**. | Assume every large retail broker ships an agent or MCP interface within ~12 months. |

## 4. Segment C — Algo-trading platforms (strategy automation without an LLM at the core)

| Platform | Evidence | Notes |
|---|---|---|
| [QuantConnect / LEAN](https://github.com/QuantConnect/Lean) **[V]** | 22,095★, Apache-2.0, pushed 2026-10-18. quantconnect.com claims 555,300 quants; research, backtest, live. | Gold standard for backtest-to-live in multiple asset classes. Code-first, cloud or self-hosted. Also AI-assisted coding **[K]**. |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) **[V]** | 30,331★, LGPL-3.0, pushed today. "Production-grade Rust-native trading engine with deterministic event-driven architecture". IBKR adapter listed as stable **[V]**. | Same "deterministic core" philosophy, institutional focus, no LLM operator. |
| [Freqtrade](https://github.com/freqtrade/freqtrade) **[V]** | 55,604★, GPL-3.0. | Crypto only, but has FreqAI (ML) **[K]**. Very large community. |
| [OctoBot](https://github.com/Drakkar-Software/OctoBot) **[V]** | 6,826★, GPL-3.0. Pitch includes "automate AI, Grid, DCA and TradingView strategies". | Crypto, with an AI angle. |
| [Hummingbot](https://github.com/hummingbot/hummingbot) **[V]** | 20,577★, Apache-2.0. | Crypto market-making and HFT. |
| [Jesse](https://github.com/jesse-ai/jesse) **[V]** | 8,670★, MIT. | Crypto research and live. |
| [Microsoft Qlib](https://github.com/microsoft/qlib) **[V]** | 49,507★, MIT. | AI-oriented quant research platform. |
| Backtesting libs **[V]** | vectorbt 9,429★ (NOASSERTION); backtesting.py 9,074★ (AGPL); zipline-reloaded 1,965★; backtrader 23,516★ but **last push 2024-08-19, effectively unmaintained**. | Research tools; no execution safety layer. |
| [ccxt](https://github.com/ccxt/ccxt) **[V]** | 44,463★, MIT. | Crypto exchange abstraction. Not equities. |
| [alpaca-py](https://github.com/alpacahq/alpaca-py) **[V]** | 1,557★. | SDK. |

AutoTrade's backtester (`src/backtest/`) is a first layer and lacks commissions, significance testing and walk-forward PBO (per `mmr-comparison-review.md`). This segment is stronger on validation, but none of these products has a first-class LLM trader/assistant with approvals and an audit trail.

## 5. Segment D — Retail AI signal / research / scanning platforms (adjacent)

| Product | Evidence | Positioning |
|---|---|---|
| **Trade Ideas** **[V]** | Homepage: "Real-time AI stock scanning, automated trades, entry/exit signals & trade alerts… backtest". | Incumbent AI scanner with automation. |
| **TrendSpider** **[V]** | Homepage: "all-in-one platform for real-time data, time-saving automation & sophisticated market research". | Technical analysis automation plus bots **[K]**. |
| **TradingView** **[V]** | "Super-charting platform and social network". | Charting plus Pine Script alerts, often used as a webhook trigger into bots such as OctoBot **[V]**. Not an agent. |
| **Kavout** **[V]** | "AI Financial Research Agents… InvestGPT, Smart Money Tracker, AI Stock Picker" across 11,000+ assets. | Research and picking, no execution mentioned. |
| **Tickeron**, **StockTwits**, **TradeSync** **[K]** | Sites were bot-protected during fetch, unverified. | AI pattern and signal vendors, and social. |
| **OpenBB** **[V]** | Repo now `openbq-org/OpenBB`, 74,433★, "Open Data Platform for analysts, quants and AI agents". | Data layer for agents. A potential **integration**, not a rival. |
| **Numerai** **[V]** | "quant hedge fund built on thousands of crowdsourced ML models". | Different model entirely (crowd ML), shown for completeness. |

## 6. Segment E — Crypto bot SaaS (not the target market, but sets retail expectations)

Cryptohopper **[V]** and 3Commas **[V]** sell hosted bots with DCA, trailing and copy-trading. AutoTrade explicitly excludes crypto for automated entries (whole-share long equities only), so overlap is small; they matter only as the category retail users compare against.

## 7. Comparison matrix

Legend: ● yes / strong, ◐ partial or unverified, ○ no. The cells for other projects reflect README claims fetched today, not my own testing.

| Capability | AutoTrade | LangAlpha | MMR | OpenProphet | TradingAgents | Public Agents | Composer | LEAN / Nautilus |
|---|---|---|---|---|---|---|---|---|
| LLM acts as trader | ● | ● | ● (via Claude Code) | ● | ● (simulated) | ● | ◐ (AI builds strategies) | ○ |
| Real brokerage execution | ● | ● | ● | ◐ (paper advised) | ○ | ● | ● | ● |
| Equities (Alpaca + IBKR) | ● | ◐ | IBKR only | Alpaca | ○ | Public only | Alpaca/SoFi | ● |
| Local / self-hosted, no custody | ● | ● (also hosted) | ● | ● | ● | ○ | ○ | ● (LEAN also cloud) |
| Human approval gate bound to revision/qty/expiry | ● | ● (governed path, claimed) | ◐ (off by default) | ◐ (permission gates) | ◐ | ◐ | ○ | ○ |
| Durable action state machine, no blind retry | ● | ● ("runs exactly once") | ● | ◐ | ○ | ◐ | ◐ | ● (Nautilus) |
| Broker-resident protective stop, self-healing | ◐ (stop only, no TP leg) | ◐ | ● (stop, trailing, bracket) | ◐ | ○ | ◐ | ◐ | ● |
| Audit trail of decision → fill → outcome | ● | ◐ | ● | ◐ | ◐ | ◐ | ○ | ◐ |
| Learning loop (lessons from outcomes) | ● | ◐ | ◐ | ◐ | ○ | ○ | ○ | ○ |
| Backtest validation rigor | ◐ | ◐ | ● | ○ | ○ | ○ | ◐ | ● |
| Zero-setup for non-technical users | ○ | ◐ (hosted) | ○ | ○ (paid setup) | ○ | ● | ● | ○ |

## 8. Where AutoTrade is differentiated

1. **Safety-as-architecture on a real account.** Few open-source LLM traders combine an approval bound to revision/qty/expiry, a durable queue with explicit unknown-outcome states, and a deliberate no-blind-retry rule. Most research frameworks have none of this. The credible comparators are LangAlpha and MMR.
2. **Evidence discipline.** The "never name a noun in the prompt without a tool that returns it" rule, `caveats[]`, and fills-based P&L are unusual in a segment where repos mostly have the model write prose.
3. **Dual-broker, equities-only, local.** Alpaca + IBKR in one engine; no custody, no vendor lock-in.
4. **Operator experience.** Persistent Assistant, Researcher worker and live TUI/web UI, as opposed to a CLI driven by an external coding agent (MMR) or a hosted chat (Public).

## 9. Where AutoTrade is exposed

1. **Commoditisation of "LLM places orders".** Alpaca's official MCP server and Public's agent builder make the basic capability free. AutoTrade's value must be the controls and lifecycle, which must be communicated, not assumed.
2. **LangAlpha** is a fast-moving, positioned-the-same competitor with a hosted option and Apache-2.0 license. It should be reviewed in depth the way MMR was (§10).
3. **Setup friction.** Node 22.13+, API keys for broker and model, and single-user local operation put it with OpenProphet (which already sells paid setup) rather than Public or Composer.
4. **Validation gap.** Backtest has no commission, significance or PBO checks (see `mmr-comparison-review.md`), so "does it make money" is hard to demonstrate. This matters most given reputable press (Bloomberg, May 2026, "mixed results" for AI stock-trading tools, as cited in the OpenProphet README) **[V, secondhand]**.
5. **No take-profit leg at the broker**, no persisted proposal object, and no single execution authorization token (the three open items in `mmr-comparison-review.md`).
6. **Stars-based mindshare is elsewhere.** TradingAgents has ~112k stars and ai-hedge-fund ~64k, but both are non-executing. Users searching "AI trading bot" will meet these first.

## 10. Recommended next steps

1. **Deep-review LangAlpha** (clone, read its "governed orders" path, compare to `orderManager` and the executor). It is the most direct safety-positioning rival.
2. **Check IBKR first-party AI/MCP offerings** and Robinhood, Schwab, Webull and tastytrade agent features; I could not verify these.
3. **Decide the positioning statement.** Suggested: *"the safety-first execution and audit layer for LLM trading on your own Alpaca/IBKR account"*, rather than "an AI that picks stocks".
4. **Close the highest-value gaps** from the MMR review: broker-resident take-profit/bracket, backtest significance and commission modelling, and a persisted proposal object.
5. **Consider integrating, not competing,** with OpenBB (data) and the Alpaca MCP server (agent interop), such as exposing AutoTrade's approval-gated queue as an MCP surface.
6. **Publish verifiable evidence** (paper-trading track record from fills, benchmark vs SPY via `get_benchmark`) because every competitor in the open-source segment is either "educational" or unproven.

## 11. Limits of this research

- No general web search was available. Closed-source vendors (Tickeron, TradeSync, StockTwits) blocked fetching, and many commercial claims are from homepage copy only.
- Star counts and push dates are a snapshot from 2026-10-19 and are popularity proxies, not usage or quality.
- Competitor safety claims (e.g. LangAlpha's "runs exactly once") are from READMEs and were not code-verified.
- Pricing was verified only for Composer (Starter $0, Advanced $10/mo).
- Nothing here is investment advice.
