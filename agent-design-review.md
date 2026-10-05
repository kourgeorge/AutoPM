# Trader and concierge design review

Status: all ten findings below have been addressed in the current working tree. The original findings are retained as review history.

Implementation: both roles now use `src/agents/turnRunner.ts` and `toolRegistry.ts`; `src/core/commands.ts` stores attributed requests and outcomes; proposal creation stores idempotent mutation receipts and rejects conflicting inputs; incident handling survives restart and links actions; journal intents and execution/protection projections are separate; annotation logic lives in the strategy layer; charts share the verified performance calculation; context reads reuse broker observations; and the dashboard provides request status and lesson editing/retirement. Runtime behavior is defined separately from account strategy prose.

Regression coverage is in `tests/agents.test.cjs`, with API attribution/permissions and browser request/lesson workflows covered by the API and browser suites. All verification uses temporary account storage and mocked model/broker calls. Deployment and live broker acceptance remain separate from these code fixes.

The durable execution queue and deterministic broker guards are useful foundations. The remaining problems concentrate in the agent boundary: deciding which calls are permitted, preserving requests through failures, distinguishing intent from completion, and supplying consistent facts to both agents.

Before implementation, ten isolated diagnostic probes reproduced the behaviors described below. They ran with a temporary SQLite database, fake credentials, blocked external network access, and mocked model/broker responses. These probes demonstrate failures in the current implementation; they are not passing regression tests for fixes. The local diagnostic script is `/private/tmp/autotrade-agent-audit.test.cjs`.

## 1. High: concierge tool permissions are not enforced at dispatch

`src/agents/concierge.ts:116` constructs a limited tool catalog, but `executeTool` at line 276 falls through to the full trader dispatcher at line 309. A returned tool name need not belong to the concierge catalog. The model provider forwards names and arguments without checking that contract.

The probe supplied an undeclared `execute_exit` call and reached the trader's exit handler; an undeclared `write_lesson` also persisted a lesson. Trading still passes through the existing broker guards and approval policy, but the intended separation between the two agents is unenforced. Neither provider behavior nor prompt instructions should be the authorization boundary.

**Simplification:** one registry containing each tool's definition, runtime input validator, allowed roles, and handler. Dispatch only through that registry. Validate before invoking any handler; return a structured error for unknown names, disallowed roles, and malformed input. Keep execution approval outside the model.

## 2. High: trader handoffs can disappear and lack accountable outcomes

`src/agents/trader.ts:39` stores instructions only in memory; line 181 removes them before context construction and the model request succeed. The probe queued an instruction, failed the model call, and observed an empty instruction queue. Restart also loses queued instructions, including instructions received while paused.

`src/agents/concierge.ts:295` reports success after calling a void callback. Its prompt promises an immediate cycle even when the trader is paused or already busy. There is no command ID or result channel for reporting that the trader declined, failed, queued a proposal, or completed the requested work. `src/server/api.ts:340` also discards the authenticated principal before handing chat to the UI, so the initiating actor does not follow the request into the agent or proposal.

**Simplification:** a durable command inbox with ID, account, actor, text, timestamps, status, and linked action IDs. Return the actual accepted/queued/paused status. Mark a command handled only after its decision and any proposals are saved. Resume unfinished commands with idempotency; do not blindly replay effects. Show command outcomes in the existing activity feed.

## 3. High: a tool exception can corrupt future concierge conversations

`src/agents/concierge.ts:251` adds the assistant's tool calls to history. Results are appended only after every call succeeds at line 272. A throwing chart or owned tool skips that append; `drain` nevertheless removes the queued request and persists history at lines 217–219.

The probe completed a handoff, then failed the chart call. The saved conversation contained two unanswered tool calls and no results, while the request was removed. Providers requiring paired calls/results can reject subsequent messages. A restart before the final persistence can instead repeat already-completed handoffs. Text is also published before tool execution, allowing success claims to precede failures.

**Simplification:** give both agents one turn runner that records tool attempts/results, catches errors per call, and always completes the conversation protocol. Separate progress text from the final response. On restart, recover pending attempts and reconcile writes before deciding whether to retry.

## 4. High: acknowledging an event is mistaken for resolving its work

`src/features/eventBus.ts:247` removes an event from pending and suppresses escalation for any acknowledgment. `src/tools/traderTools.ts:1312` permits `acting` without a linked action and deliberately writes no journal decision for that disposition. A subsequent order can fail, expire, or never be attempted while the critical event remains silent.

The probe acknowledged a critical stop event as `acting` without creating any action: no pending event, no journal decision, and no later escalation. The acknowledgment was absent from the durable event log, which records only the event's initial state. A separate probe restored the suppression latch after clearing in-memory registries and confirmed that a pending urgent event disappeared until a recross or latch reset.

**Simplification:** persist open incidents and their handling separately from detector cooldowns. Distinguish observed, action pending, deliberately declined, and resolved. An action-pending incident must reference a proposal and regain attention if the proposal fails or expires. Keep acknowledgment history durable.

## 5. High: different trade intents silently reuse the same proposal

`src/core/proposals.ts:29` treats every open proposal with the same kind and symbol as a duplicate, regardless of quantity, prices, rationale, or event. The probe requested an exit of one share and then ten shares; both returned the first proposal, containing one share.

This can make a trader or concierge report acceptance of revised instructions while the executor later performs the old instructions. `annotate_position` can additionally return the newly requested levels alongside an ID whose saved parameters still contain older levels.

**Simplification:** use command/tool-attempt identity for idempotency. Reuse only an identical intent. Return a clear conflict for a materially different open action, with its actual parameters. Any replacement must explicitly invalidate the previous approval and preserve the change history.

## 6. High: journal projections blur intent, submission, fill, and protection

`src/strategy/proposalExecutor.ts:123` records `executed: true` at submission. A canceled unfilled order retains intended quantity/price. `src/agents/trader.ts:635` renders those fields as an ENTRY/EXIT without displaying `orderStatus`; the probe showed a canceled unfilled entry as `ENTRY AAPL 5sh @ $100`.

`src/tools/traderTools.ts:1084` records a stop adjustment before broker confirmation and overwrites `entryDecisionId` at line 1108. That replaces the original entry thesis with the latest management rationale. The record lacks the adjustment proposal ID and confirmed protection result. The probe refused a stop move yet found the adjustment classified as trading activity by `src/journal/types.ts:92`; `src/daemon.ts:91` labels such activity “Stop/target updated.” Deferred execution failures also update proposals without consistently writing the guard/broker journal records that the prompt tells agents to expect.

**Simplification:** keep the immutable decision and its original thesis, plus a linked execution outcome. Model requested quantity and filled quantity separately; use explicit submission, fill, and protection states. Retain `entryDecisionId` and store the latest management decision separately. Derive agent history, dashboard activity, and journal views from the same outcome projection. Record concise reasons and evidence references, not private model reasoning.

## 7. High: the agent-facing contract still describes the old execution model

`src/tools/traderTools.ts:88` describes an immediate market buy, immediate fill reporting, and a target that is never sent. The implementation now queues an action and later submits an IOC limit entry and manages broker protection separately. Annotation prose promises immediate state/broker changes despite the queue. `src/agents/trader.ts:619` tells the model that every open proposal waits on a human, including automatic/submitted/unknown actions. The concierge cannot inspect proposals through its intended catalog and its `get_state` omits pause and unresolved execution status.

`policy/PLAYBOOK.md:18` also treats `ok: true` as completion of a mutation, while the tools return that flag for successful queuing. Other context text still advises annotating unmanaged holdings although validation requires explicit human adoption.

**Simplification:** make tool names and outputs reflect the workflow: propose an action, inspect its status, report its outcome. Place fixed platform behavior in one generated runtime contract, separate from account-owned strategy prose. A settings revision should not control whether a tool submits immediately, requires adoption, or returns a queue receipt. Preserve account strategies while updating incompatible runtime claims.

## 8. High: a concierge chart bypasses the canonical performance rules

`src/tools/chartTools.ts:112` fetches raw account equity and lines 188–200 publish its percentage change and excess over a symbol. This path does not check cash movements. By contrast, `src/review/benchmark.ts:325` withholds performance when cash flows exist or cannot be verified.

The diagnostic supplied equity rising from 100 to 200 and a flat benchmark; the chart returned 100% account growth and 100 percentage points of excess without verifying whether the equity increase was a deposit. Both agents can also access raw portfolio history, so its meaning must remain explicit.

**Simplification:** use one account-performance calculation for charts and tools. Display raw equity as equity; publish investment returns and excess performance only when the accounting supports them.

## 9. Medium: cycle termination and resource limits have inconsistent semantics

`src/agents/trader.ts:221` keeps executing the rest of a tool batch after `sleep`. The probe persisted a lesson after that supposedly terminal call. Both loops treat token exhaustion or a round cap as a normal finish without an explicit incomplete outcome. `stop()` has no cancellation/drain contract for an active trader turn, and shutdown does not drain the concierge.

The concierge trims history only after the entire turn (`src/agents/concierge.ts:231`). Tool results can therefore exceed the context cap during a turn. Several tool schemas advertise limits that handlers do not enforce, such as raw bars/news inputs. `src/core/modelBudget.ts:7` shares a single request pool between chat and trading, so conversation traffic can consume the budget needed for later trader reasoning.

**Simplification:** shared runner outcomes of completed, waiting, interrupted, and failed; an overall deadline and cancellation signal; a terminal completion operation; validated input/output bounds and compaction before each request. Reserve part of the model budget for trader work. Keep the deterministic execution/protection loop independent.

## 10. Medium: persistent learning and module boundaries make drift harder to control

`src/journal/lessons.ts:20` stores prose with a policy version but no source decisions, evaluation period, or retirement state. The trader rereads the newest 20 lessons indefinitely. Their advisory status prevents policy activation, but unsupported conclusions can still influence repeated decisions. The promised operator edit/delete workflow is missing from the application. Full lesson/history reads also grow with the database despite showing only small excerpts.

The code boundaries reinforce duplication: the execution layer imports annotation business logic from the model tool adapter (`src/strategy/proposalExecutor.ts:11`); API chat passes through a UI callback; and the trader combines scheduling, context assembly, tool execution, and UI updates. Account/positions/orders are assembled from separate live reads, so one context can combine different observations.

**Simplification:** move annotation validation/execution into the strategy layer; give API/terminal adapters a shared application service; build a timestamped account snapshot once for agent context; query records by ID or bounded pages. Store lessons with evidence IDs and active/retired state, plus a small operator review surface. Keep measured results separate from model interpretations.

## Recommended implementation order

1. Enforce tool roles and runtime schemas; correct fixed tool contracts and status projections.
2. Introduce the shared turn runner and durable command inbox; cover exceptions, restart, pause, and incomplete turns.
3. Link incidents, decisions, proposals, broker orders, and fills; correct deduplication and journal truthfulness.
4. Consolidate performance/context reads and add bounded, reviewable lessons.

Retain two roles and the single deterministic executor. The useful reduction is shared lifecycle machinery and shared facts. A generic multi-agent framework or additional agents would add complexity without solving these failures.
