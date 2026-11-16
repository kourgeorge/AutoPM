# Why trader turns take hundreds of AI round trips (study of 2026-11-10 … 11-13)

**Short answer.** The huge turns are a memory failure caused by the harness, not a model that
wants to do more work. On the old server build, `compactMessages` trims the oldest exchanges
almost every round. Each time, it adds one *more* "Earlier exchanges omitted … unknown, not
empty" note to the first message and never removes the old ones. So the room for real
conversation keeps shrinking until the model can only see its last round. It then forgets
what it has read and decided, and starts the routine again: page the saved cycle context,
page the scan four rows at a time, re-read positions and events. In the end the request goes
over the 200,000-character cap and the turn fails. All six big turns ended this way, and none
of them ended with a successful `sleep`. The 30–40-round turns follow the same pattern on a
smaller scale. About half of their rounds go to paging and re-reading, and they only finish
because they reach `sleep` before the trimming starts to hurt.

Evidence: `data-alpaca/token-study-2026-11-16/` (copied from the server, git-ignored). Code
references are to `1eacb22` (the build the server ran) unless marked "master".
Analysis scripts were throwaway, in `/tmp`.

---

## 1. What the rounds are spent on

Method: I took each receipt in `tool-calls-<turn>.jsonl`. I kept only receipts whose
`requestId` is that turn, because the files also hold some receipts from other turns. I
grouped them by round (the middle part of the receipt id `turn:round:index`) and gave each
round the type of most of its calls. Each round re-sends the whole request (about 47k input
tokens), so the share of rounds is roughly the share of input tokens.

| What the round did | 6 big turns (2,343 rounds) | 3 normal turns (109 rounds) |
|---|---|---|
| Paging the scan / market context with a `snapshotId` | 38% | 25% |
| Starting a new scan / market context from offset 0 | 4% | 1% |
| State re-reads (`get_pending_events`, `get_market_status`, `get_account`, `get_positions`, `get_open_orders`, `get_exposure`, `get_macro_regime`, `get_economic_calendar`, `get_lessons`) | 18% | 17% |
| Paging the saved cycle context (`get_saved_context …:context-1`) | 11% | 12% |
| Paging an oversized result (`get_tool_result`) | 7% | 1% |
| Research reads (position review, signals, calendar, news, research updates …) | 12% | 14% |
| Errors (the call came back `ok:false`) | 4% | 6% |
| Actually deciding (`record_*_review`, `ack_event`, `get_entry_plan`, `sleep` …) | **6%** | 25% |

Other measurements:

- **One tool per round.** 97% of rounds in the big turns had exactly one tool call (94% in
  normal turns). Batches do happen (up to 15 calls in one round; 12 in `2917f1eb` round 31), so
  parallel calls are allowed. They are just rare.
- **Re-reading.** 36% of all calls in the big turns were an exact repeat (same tool, same
  input) of an earlier call in the same turn. In normal turns it was 10%.
- **The whole scan, again and again.** Each big turn started a fresh `get_watchlist_scan` 10–17
  times and paged it to the end each time. The scan returned **3–4 rows per page**
  (~3,000 chars) even though `limit: 50` was asked for, so one full read took 12–17 rounds.
  Example `ca7bc33b`: full passes at rounds 6–18, 30–47 and 63–75, all within five
  minutes, and the third pass re-paged the very same snapshot (`…:30:4`) as the second.
- **The same dossier, again and again.** `get_position_review GE` was read 17 times in
  `a5b2c34e`, 18 in `185ef31a` and 15 in `19a7b227`. GE's dossier was just over the inline
  cap (10,026–10,657 chars against `raw.length <= 10000` in `boundedResult`), so each read also
  cost three `get_tool_result` pages. All 154 `get_tool_result` rounds in the big turns were
  re-reads of the turn's own oversized receipts: almost all position reviews, a few
  `get_orders` / `get_news`.
- **Paging the cycle context.** At the start of every turn the model paged the *whole* saved
  context (25–31k chars) in 4,000-character pages. That is 7–8 rounds, even though about 20k of
  it was already in the first message. The only section actually left out was
  `=== LESSONS — YOUR MEMORY (13) ===` (7,881 chars), plus `RECENT DECISIONS` in `ca7bc33b`.
  The first call often failed: `get_saved_context {limit: 12000}` → `"input.limit: invalid
  number"` (`2917f1eb` round 1, `ca7bc33b` rounds 1 and 21), because the schema caps `limit` at
  4000 (`savedResults.ts:7-10`).
- **Polling events.** `get_pending_events` was called 30–46 times per big turn and 2–3 times
  per normal turn. The events did not change much. The model had simply lost the previous read.
- **`get_requests`** was called **0 times** in all nine picked turns.
- **No text at all.** None of the kept assistant messages contains any text. The output is
  about 60–70 tokens per call, i.e. one tool call. The model never writes down a plan or what
  it has done so far, so once a round is trimmed, nothing of it is left.

### The loop after trimming (the main cause)

Every trajectory keeps the trimming notes inside its first message:

| Turn | Rounds | Trimming notes left in message 1 | Note text, total | How it ended |
|---|---|---|---|---|
| a5b2c34e | 464 | 294 | 75,452 chars | `failed: Model context exceeds the account request limit` |
| 19a7b227 | 441 | 266 | – | same |
| ca7bc33b | 416 | 288 | 73,910 chars | same |
| 3c3a3e58 | 360 | 225 | – | same |
| 39737f35 | 346 | 217 | 55,663 chars | same |
| 185ef31a | 318 | 177 | – | same |
| 2917f1eb | 38 | 13 | – | completed (sleep) |
| 6c9e96c9 | 40 | 8 | – | completed (sleep) |
| eea4bdd3 | 32 | 5 | – | completed (sleep) |

How it happens, in `1eacb22:src/agents/agentLoop.ts`:

- `runAgentLoop` calls `compactMessages(current.messages, limit)` before **every** model call
  (line 184).
- `limit` is what is left of the 200,000-char cap (`modelBudget.ts`, `REQUEST_CHAR_LIMIT`)
  after the system prompt and tool list (`turnMessageLimit`, line 83). I measured the old
  build: the runtime contract is 4,778 chars, `prompts/TRADER.md` 38,005 chars, and the 53
  tool definitions 41,629 chars. The user playbook and the policy block from the server come
  on top, and I could not read them. That leaves roughly **100k chars for the whole
  conversation**. The final messages agree: when `ca7bc33b` failed, they added up to about
  98k chars.
- The cycle context takes ~20k of that (it is cut at 22,000 by `boundedCycleContext`,
  `savedResults.ts:46`). A position review is 5–10k and a market-context page is ~9k. So
  trimming started early: by round 6–7 in `ca7bc33b` and `a5b2c34e`, and 13 times even in
  the normal 38-round `2917f1eb`.
- Each trimming adds a **new** note: `messages[0].content.push(note)` (line 116, still the
  same on master `agentLoop.ts:133`). Old notes are never replaced, and the trim loop never
  removes them, because it always keeps `messages[0]`. Each note is ~260 chars and trimming
  ran ~once per round, so the notes grew to 55–75k chars. That ate most of the ~100k room.
- So the window kept shrinking. At the last trimming of each big turn, the newest round
  removed was the one just before the current round (`ca7bc33b`: removed up to round 415 of
  416; `a5b2c34e`: 463 of 464). The model was working with the cycle context, a pile of "you
  have forgotten things" notes, and only its latest exchange.
- Every note ends with *"Omitted evidence is unknown, not empty."* With nothing else to go on,
  the model does the safe thing the prompt asks for. It re-reads the saved context, re-scans
  and re-checks events. Then those reads get trimmed too.
- When the first message plus one exchange no longer fit, `withModelBudget` throws
  `Model context exceeds the account request limit` and the turn fails.

Clear example, `19a7b227`. At round 164 the model called `sleep`. It was refused:
*"Decisions are still open … open: PG"*. At round 171 it recorded the PG review, which was
exactly what it needed to do, and it acknowledged the heartbeat at 172. But it never called
`sleep` again. By then the refusal had been trimmed away. It went on to a fresh full scan at
round 186, another at 213, and 277 more rounds until the context failure. `3c3a3e58` shows the
same thing: sleep refused at round 281, then 79 more rounds without another sleep. The other
four big turns never tried to sleep at all.

Effect on decisions: the six big turns spent about 112M input tokens. Only 6% of their rounds
were decisions, and every one ended `failed`, so `journalUnresolved` wrote any open decisions
as "no reason recorded". Across Nov 11–13, turns of 200+ rounds took about 363M of the
~609M trader input tokens, about 60% (from `turns.json`).

## 2. Why one turn "lasted 24 hours"

`39737f35` (created 2026-11-12 11:03 UTC) did **not** work for 24 hours. Its own receipts run
from 11:03:55 to 20:19:25 UTC. That is 9 h 15 min, and 8 h 56 min of it is a single silent
gap between round 65 (11:07:40) and round 66 (20:03:17). Outside that gap the turn worked for
about 20 minutes, at ~3 seconds per round. The other big turns lasted 17–28 minutes.

What the gap looks like: the call at round 66 continued the scan page that was already in
progress (`snapshotId …:35:0, offset 40`). It ran at 20:03 and got back data from the
**11:05 snapshot** (`tickAt 2026-11-12T11:05:52`), nine hours old. That fits
`runAgentLoop`'s resume path. A trajectory saved as `running` is picked up again, and a saved
assistant batch is executed as it is (lines 129–147). Most likely the engine stopped at about
11:07 and the restart carried on with the old turn. **This is a guess.** I have no engine log
for that window. A hung model call is ruled out (150 s timeout with 2 retries,
`modelProvider.ts:14-16`), and a budget error would have failed the turn instead of pausing
it. Nothing in the evidence shows events or operator requests keeping it alive: no
`get_requests` calls, and no operator text in the conversation. It ended the same way as the
others, with the context-limit failure, right after round 346. I could not see the request's
own finish time. The "24 h" figure probably comes from request created-to-finished times
that I could not see.

## 3. What in the prompt pushes this behaviour (quotes)

- Cycle context header (`1eacb22:src/agents/savedResults.ts:51`):
  *"An omitted section is UNKNOWN, not empty. Read omitted portfolio/protection evidence before
  trading."* The section left out was LESSONS, not portfolio or protection. But the header
  only says "Retrieve … with get_saved_context" and gives no offset or section name, so the
  model pages the whole 25–31k text from offset 0.
- `TRADER.md:136`: *"The LESSONS block is your memory: read it before deciding, and act on
  it."* That is the very block that gets left out.
- `TRADER.md:162`: *"Follow all nextOffset pages needed for a decision. … Omitted evidence is
  unknown, never an empty set."* Also `runtimeContract.ts:14`: *"omission means unknown. Never
  infer that an unreturned row or section is empty."* Also both saved-result tool
  descriptions (`savedResults.ts:6,9`): *"follow nextOffset until null"*.
- `TRADER.md:100` (scan): *"Start a scan here and follow nextOffset with snapshotId until
  null"*. `TRADER.md:33` says the opposite: *"get_watchlist_scan() reads the whole watchlist in
  ONE call"*. In reality it took 12–17 pages.
- `get_watchlist_scan` description (`traderTools.ts:315`): *"Follow nextOffset with snapshotId
  until null."*
- The trimming note itself (`agentLoop.ts:115`): *"Earlier exchanges omitted to fit context.
  Retrieve … with get_saved_context; … Omitted evidence is unknown, not empty."* This is the
  strongest push. It is added almost every round and tells the model it has forgotten
  something it must not assume.
- `TRADER.md:73`: *"Below the target, work the scan's best-ranked candidates … every cycle the
  market is open: enter, or record why not."* Together with the sleep refusal ("For an
  under-invested account with no scan, run get_watchlist_scan", `traderTools.ts:1196`), every
  under-invested review (0% invested against an 80% target in all these turns) must start
  with a full scan.
- None of these lines is wrong on its own. Together they make "re-read everything" the right
  move whenever the model cannot see its earlier reads, and the harness made that happen
  almost every round.

## 4. What in the harness pushes this behaviour

1. **Trimming notes pile up** (`agentLoop.ts:113-118`, master `:130-135`). This is the main
   cause, described above. One saved context is created per trimming (`ca7bc33b` has 289
   saved contexts). The model read back only 5 of them across all big turns
   (`saved_trimmed_history` row). It mostly re-fetched the live data instead.
2. **The room is small and fixed.** System prompt plus tools take about half of the 200k-char
   cap on every call, and nothing is cached (no cached tokens were recorded on this
   OpenAI-style route).
3. **Scan pages were sized on full rows but returned compact rows**
   (`1eacb22:src/tools/paging.ts` `recordPage` measured `JSON.stringify(candidate) > 9000`
   before the rows were projected to compact form in `traderTools.ts:410-418`). So 3–4 rows
   came back per page instead of ~50. **T-17 fixed this.**
4. **Inline result cap of 10,000 chars** (`boundedResult`, `agentLoop.ts:44`). The GE dossier
   was 10.0–10.7k chars, so every read needed three more `get_tool_result` rounds at a maximum
   of 4,000 chars each (`savedResults.ts:7`).
5. **Saved-context pages max out at 4,000 chars** while the context is 25–31k. That is 7–8
   rounds per read, and the model's first try with a larger page failed.
6. **The cycle context is cut at 22,000 chars** (`boundedCycleContext` default budget), even
   though the conversation has ~100k of room. The lessons (7.9k) were left out in every
   picked turn.
7. **The model runs with reasoning switched off.** `1eacb22:src/core/modelProvider.ts:318-320`
   sends `reasoning_effort: 'none'` to any `gpt-5…9` model that has tools on
   `/chat/completions` (master `:327`). The code comment says the provider rejects tools with
   reasoning on that endpoint. So `gpt-6-luna` picked one tool per call with no planning and
   no visible text. **I have not checked** how much this changes the behaviour, or the
   provider's claim itself (no OpenAI docs checked). It does fit the "one reflex call per
   round" pattern.
8. **How a turn ends.** A turn ends only on a successful `sleep` (or no tool calls, an error,
   or a stop). A refused sleep is a normal tool result and can be trimmed away like any other.
   There was no round limit before T-18.
9. **Resume after a restart** runs the saved batch with old snapshot ids (see section 2).
10. **Errors that cost a round each** (4–6%): `limit` over the schema maximum,
    `"Evidence belongs to a different symbol"` / `"Unknown observation evidence ID"` on
    `record_candidate_review` (`2917f1eb` rounds 17–19, `3c3a3e58` 8 times),
    `"Unknown snapshot for this tool"` on `get_research_updates`, when a receipt or evidence id
    from another tool was passed as its `snapshotId` (`a5b2c34e` 9 times), and `"unknown or already-acked event id"`.

## 5. Are the normal turns (30–40 rounds) efficient?

No. They show the same pattern, just shorter:

- `2917f1eb` (38 rounds): 1 failed + 7 rounds paging the saved context. Then 3 scan pages,
  4 failed `record_candidate_review` tries (wrong evidence ids, `premises[1].metric:
  unsupported value`), and one refused sleep. Roughly 15 rounds carried the actual work.
- `6c9e96c9` (40 rounds): 13 scan pages and 12 state reads.
- `eea4bdd3` (32 rounds): 13 scan pages and 4 saved-context pages.

They were already being trimmed (13, 8 and 5 notes). They finished because they reached
`sleep` before the window got small. With T-17, the scan part (12–13 rounds) should shrink
to 1–2 pages.

---

## Ranked changes (none made in this task)

Savings are rough estimates from the shares above. Each round costs about 47k input tokens.

| # | Change | Where | Expected saving | Risk to decision quality |
|---|---|---|---|---|
| 1 | **Keep one trimming note, not one per trimming.** Replace the earlier note (or keep a single counter "N earlier exchanges saved as …"), so notes never eat the window. | harness, `compactMessages` | Removes the death spiral, i.e. most of the ~60% of tokens spent in 200+-round turns. Big turns would likely look like normal ones (guess: 30–60 rounds, not 300–460). | None. The notes carry no evidence. |
| 2 | **A pinned "turn progress" block that is never trimmed.** The harness writes it from the receipts: which reads were done (with receipt ids and snapshot ages), reviews recorded, events acked, and the last sleep refusal with its open list. Rebuilt each round in place, not appended. | harness (`compactMessages` / `runAgentLoop`) | Stops the re-read loops (36% exact repeats, 10–17 rescans, 30–46 `get_pending_events`) even when trimming does happen. 30–50% of rounds in long turns. | Low. It is a list of facts from the receipts. It must list items, not summarize the model's reasons, so no reason text gets shortened. |
| 3 | **Change the wording of "unknown, not empty"** in the trimming note and the cycle header to something like: "Omitted ≠ empty, but you do not need to re-read what the TURN PROGRESS block shows you already read in this turn; re-read only when you need fresher data for an order." Fix `TRADER.md:33` vs `:100` so they agree. | prompt (`agentLoop.ts` note, `savedResults.ts:51`, `TRADER.md:33,100,162`, `runtimeContract.ts:14`) | Supports #2. Alone, maybe 10–20% (guess). | Low. Freshness before an order is still required by `TRADER.md:28`. |
| 4 | **Do not leave LESSONS out of the cycle context.** Either raise the 22k budget (there are ~100k of room), or show fewer *rows* of other blocks first (never shorter text). If a section must be left out, let `get_saved_context` take a `section` name, or put the section's offset in the header, and allow pages as big as the context. | harness (`boundedCycleContext`, `savedResults.ts`) | 7–8 rounds per turn (≈20% of a normal turn, 11% of a big one). | Positive. The model gets its lessons in front of it. |
| 5 | **Raise the inline result cap** (`boundedResult` 10,000) to fit a normal dossier (~11–12k), or make `get_position_review` smaller by leaving out whole rows. | harness / tool | 3 rounds per oversized review. 7% of big-turn rounds; a GE holding hits it every read. | None if whole rows are dropped, never shortened text. |
| 6 | **Scan pages sized on the rows actually returned.** | tool | 12–16 rounds per scan pass; 25% of normal-turn rounds, 42% of big. | None. **Done in T-17.** |
| 7 | **Fix schema traps that cost a round:** allow `get_saved_context` / `get_tool_result` `limit` up to the page budget, or clamp instead of failing; say in `get_research_updates` that `snapshotId` is only its own page id; give the right evidence id in the `record_candidate_review` error. | tools | 4–6% of rounds. | None. |
| 8 | **Make the refused sleep stick.** Show the open list in the progress block (#2) until it is resolved, and say "then call sleep" when the last open item is recorded. | harness / `toolSleep` | Ends turns like `19a7b227` at ~172 rounds instead of 441. With #1 and #2, sooner. | None. |
| 9 | **Do not resume an old turn as is after a restart.** If a running trajectory is older than a few minutes, end it and start a fresh cycle, or at least drop the saved batch's snapshot ids. | harness (`runAgentLoop` resume) | Avoids multi-hour turns that act on 9-hour-old data (`39737f35`). | Positive. |
| 10 | **Let the model plan.** Try the Responses API (or another route) that allows tools *with* low reasoning effort, or ask for parallel reads in one batch in the prompt ("read everything you need for this step in one batch"). | provider / prompt | Unknown. Possibly fewer, batched rounds (guess). | Uncertain. More output tokens per call and slower calls. Needs an A/B on replay. |
| 11 | **Prompt caching / smaller fixed part.** The ~90k chars of system prompt and tools are re-sent unchanged ~47k tokens every call. Check whether the LiteLLM/ChatGPT route reports cached tokens. If not, a provider with caching cuts the cost per round, not the round count. | provider | Cost per round, potentially large. Not measured. | None. |

### What T-17, T-18 and T-20 already cover

- **T-17** (`3bee243`, scan and market context in big pages, up to `REQUEST_CHAR_LIMIT / 6`
  ≈ 33k chars and 200 rows) covers **#6**, the biggest single share of rounds. One side effect
  to watch: a 33k page fills about a third of the ~100k window. With the note pile-up (#1)
  still on master, trimming may start even sooner (guess, not measured).
- **T-18** (`48f554e`, 40 rounds / 2M input tokens per trader turn, warning 5 rounds before)
  **limits the damage but does not fix the cause.** The model still loses its memory, so a
  turn can now hit the cap mid-loop and end with open decisions journalled as "no reason
  recorded". 40 rounds is also exactly the size of today's normal turns (`6c9e96c9` slept at
  round 40), so normal reviews may hit the warning until #4/#5/#7 shrink them.
- **T-20** (`d87f4f6`, `get_requests` returns only what changed) does not touch these nine
  turns. The trader called `get_requests` zero times in all of them. It may help other turns
  (direct turns), which I did not study.
- Not covered by any of them: **#1, #2, #3, #4, #5, #7, #8, #9, #10, #11.** The note pile-up
  is still on master (`src/agents/agentLoop.ts:133`), as are the 10,000 inline cap
  (`:60`), the 4,000 saved-page cap (`src/agents/savedResults.ts:7,10`) and the 22,000
  cycle budget (`:46`).

## What I could not check

- The server's user playbook and policy block (part of the system prompt). I only measured
  the shipped core prompt and the tools.
- The cause of the 8 h 56 min gap in `39737f35` (no engine log). The restart-resume
  explanation is a guess that fits the receipts.
- Whether `gpt-6-luna` would plan better with reasoning on. Whether the LiteLLM route offers
  prompt caching.
- Exact turn end times. `turns.json` has rounds and tokens but no timestamps, and the receipt
  files hold only part of the other turns' receipts.
- The model's own "why": it wrote no text, so every reason above is inferred from what it
  called and what it could see.

## Recommended next step

Do **#1 and #2 together** as one small harness change in `compactMessages`/`runAgentLoop`:
one replaceable trimming note plus a pinned, harness-built turn-progress list. Test it with a
replay-style test that runs 60+ rounds and checks that the first message stays the same size
and that a refused-then-resolved sleep is still visible after trimming. Then do #4 and #5
(cheap constant/budget changes), and check a day of live turns against T-18's 40-round cap
before changing that cap.
