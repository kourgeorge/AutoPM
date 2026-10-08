# Trader decision context

The trader receives a standing decision brief and can fetch richer evidence on demand. Prices, completed daily readings, broker orders, research publication dates and macro observation periods retain separate timestamps. Missing inputs remain unknown.

## Before entering

1. Read `get_watchlist_scan` and follow `nextOffset` with the same `snapshotId`. Compact pages preserve the entire universe across pages. `details:true` retrieves full signal readings from the same snapshot. An old tick is not a current quote.
2. Research selected candidates with `get_position_review`, `get_research_updates`, `get_company_filings`, `read_source`, `get_market_context`, and company/economic calendars across the intended holding horizon.
3. Request `get_entry_plan` with supported stop and target prices. It estimates the active risk budget; the executor still validates account state and strategy rules.
4. Supply `execute_entry` with a structured thesis: setup, horizon in calendar days, catalyst-risk acceptance, and evidence-linked premises. Numeric premises require fresh observations containing the actual metric and must currently be supported. Qualitative premises remain unverified by numeric checks. Shared economic drivers are explicitly authored hypotheses with evidence.

Entries remain durable queue requests. Approval, submission, fills and confirmed protection are distinct outcomes. The original thesis survives fills and subsequent management changes. Legacy positions are not assigned invented structured theses.

## While holding

The cycle brief reuses fresh tick observations and broker read scopes, without extra network calls for its own data. It shows actual protection, current-price stop/target geometry, thesis conditions, prior material reviews, next review dates, cached macro observations and calendar availability.

`get_position_review` fetches a richer dossier, including market/sector relative performance, holding-horizon expiry, fundamental changes and measured bid/ask spread. Actual owned broker stops and intended levels are separate, including quantity coverage. A missing stop or quote yields unknown geometry.

`compare_position_actions` compares keep/reduce/exit exposure, historical volatility and estimated spread costs. An optional replacement uses a hypothetical risk budget after an assumed exit. These previews do not approve or send orders, forecast returns, or promise fills. Exposure uses current equity; planned stop downside excludes gaps.

Record material keep/reduce/exit/wait assessments with `record_position_review`, including unknowns and a future review date. Send any chosen order separately. Record material candidate wait/skip decisions with `record_candidate_review`. Repeated unchanged assessments are deduplicated.

## Research and provenance

News and SEC filings have persistent source IDs. `read_source` reads original text in stable pages. `record_research_review` preserves interpretations; support/contradiction requires reading the source first. Repeated titles, previous review status and surrounding session moves are reported without claiming independent confirmation or causation. Publication time, event time and first-seen/fetch time are separate.

Every successful observation tool has an immutable `evidenceId`. `get_evidence` retrieves the archived observation. Large receipts are retrieved through `get_tool_result`; explicitly omitted context sections through `get_saved_context`. Follow `nextOffset` until null. Omitted evidence means unknown.

Daily histories require the exact completed session and exclude unfinished daily bars. Alpaca daily equity bars request split adjustment. Mean reversion contains three readings: the duplicate Bollinger score was removed. The remaining trend and reversion readings share price history and have no established statistical independence. Correlations match dated return intervals, distinguish positive redundancy from negative correlation, and report missing coverage explicitly.

`get_intraday_volume` compares identical completed five-minute regular-session bins on prior sessions. It reports the delayed tape and comparable-session coverage. It does not compare partial-day volume against a full daily average.

Market breadth covers the approved watchlist plus holdings, with explicit measured denominators. Sector ETFs are comparison proxies. Macro data retains individual observation/vintage dates; classification confidence is heuristic. BLS/FOMC calendar failures remain explicit, and FOMC announcement times are unknown when the source provides only meeting dates.

## Follow-up and learning

`get_decision_followup` measures passive paths at 1/5/20 subsequent sessions after material reviews and entries/exits with observation snapshots. It reports favorable/adverse excursions and cost assumptions. Quote references are rebased through their recorded daily-close anchors into current split-adjusted units. Missing anchors or unfinished horizons remain unknown. Dividends, subsequent actions and execution simulation are excluded.

Use `get_scorecard` for actual fills and `get_benchmark` for account performance. Context-group averages from follow-up are descriptive: timing, candidate selection and strategy changes confound them. They do not prove that additional context improves returns.

Lessons retain supporting/counter-evidence, decision sample counts, scope, strategy hash and review dates. Decision counts are not independent completed trades. Due reviews and changes to strategy are exposed as reasons to reconsider an advisory lesson.

For evaluating a new context source, freeze historical observations available at each decision time, run paired decisions with and without that source, retain a separate chronological holdout, and compare action consistency, unknown-data handling, forecast calibration where forecasts exist, and execution outcomes after costs. Current-vintage fundamentals/news cannot reconstruct historical knowledge automatically.

## Source configuration and limits

- Existing Alpaca credentials provide quotes, bars and news under the account's feed entitlement. The tools use the subscription default and report feed ambiguity; a partial exchange feed is not consolidated market volume.
- `SEC_USER_AGENT` must identify the application and a contact email, for example `AutoTrade research contact@example.com`. No SEC request is made without it. Missing configuration is reported as unavailable coverage.
- `FRED_API_KEY` supplies macro observations. Publication timestamps unavailable from the observation response remain unknown.
- Existing `TAVILY_API_KEY` enables web search. Discovered original public HTTPS sources can be read; inaccessible or non-text documents remain explicit failures.
- BLS and Federal Reserve public calendars need no API key. Providers can reject requests or change formats. A provider outage is not a clean calendar.

These changes need no migration of account files. Restart the engine after building to load the tools. They have been checked with temporary storage, mocked broker/data providers and network-disabled replay; improved investment performance has not been established.

## Optional migration of existing account records

Existing files remain readable without conversion. To explicitly add the new metadata to legacy records, stop the engine, build, and preview the migration:

```sh
node dist/scripts/migrateDecisionContext.js --data-dir data-alpaca
```

Add `--apply` to perform it. The command acquires the engine lock, backs up the entire database under the account's `backups/` directory with SHA-256 checksums, and verifies every write. It preserves original record fields, IDs, timestamps, record versions, holdings, settings and order outcomes. A rerun reports `already_applied`.

Missing historical theses are explicitly null. Evidence references default to an empty list of recorded observations; legacy context is labeled `legacy-unrecorded`. Original theses or context labels are recovered only from explicitly linked actions/reviews. Unambiguous exact tool receipts are linked to their historical transcript results. Older lessons receive recorded-evidence counts, unknown applicability and a review date set to migration time. This date is a new review schedule, not an invented creation date.

The command creates any missing research/context record files and initializes an unavailable economic-calendar cache. It makes no broker or model requests. The migration audit and backup report record the changes.
