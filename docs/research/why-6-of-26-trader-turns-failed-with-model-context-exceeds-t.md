# Why 6 of 26 trader turns failed with "Model context exceeds the account request limit" (T-69)

**Question.** In one day of live turns, 6 of 26 trader turns ended with the error
"Model context exceeds the account request limit". Why, and could those turns have gone on?

**Short answer.** All 6 turns failed because of one large batch of tool results. The trim
can't make that batch smaller: it never goes below 3 messages (the cycle message, the last
assistant batch and its results), and it never shrinks a result that is already inline. The
system prompt plus the tool list use about half of the 200,000-character cap, and the cycle
context uses another ~35k. That leaves roughly 60k for the newest batch, and each of these
batches had 13–21 tool calls of up to 16k each. Turn 051985cc did not fail on its first
request: that request worked. It failed on the second, right after its first 15-call batch.

The cause is certain: the code, the saved data and a re-run with the real prompt builders
all agree. The exact size of each result is an estimate, because the receipts (the saved
full tool results) are on the server.

---

## Where it happens

- `src/agents/agentLoop.ts:203`:
  `while (JSON.stringify(messages).length + pinnedSize > limit && messages.length > 3)`.
  Once 3 messages are left the loop stops, even if they are still over the limit.
  `compactMessages` then returns a conversation that is too big, and `runAgentLoop` sends it
  anyway (`agentLoop.ts:405`, then the chat call).
- `src/agents/agentLoop.ts:375` (and `boundedResult` at line 73): each result is capped on
  its own at `INLINE_RESULT_LIMIT = 16_000` (`src/agents/savedResults.ts:12`). Nothing caps
  the whole batch: 15 results × 16k = 240k, more than the full cap.
- `src/core/modelBudget.ts:106` then throws "Model context exceeds the account request limit".
- The size is not counted differently in two places. `turnMessageLimit`
  (`agentLoop.ts:147`) measures `JSON.stringify({systemPrompt, tools})` plus a 2,000 margin,
  and `compactMessages` measures `JSON.stringify(messages)`. Together that matches
  `JSON.stringify(params)`. The provider adds nothing before the check: `withModelBudget`
  wraps the raw provider (`src/core/modelProvider.ts:443,458`). So the trim does what it was
  written to do; it just has nothing left to drop.

## What the saved data shows

Source: the failed turns, saved to `/tmp/t-failed/failed-turns.json` during T-69.

- Every failed turn has exactly 3 saved messages, so the trim was already at its floor.
- Message 0 (cycle context plus the TURN PROGRESS block) is about 32.6–35.4k characters.
- The last batch had 15, 13, 13, 15, 16 and 21 calls (counted from the highest receipt
  index). They were mostly `get_position_review`, `get_calendar`, `get_research_updates` and
  `get_news`. In 051985cc they were `get_watchlist_scan`, `get_positions`,
  2 × `get_position_review`, `get_scorecard`, `get_benchmark`, `get_economic_calendar` and
  others.
- 051985cc has `rounds: 1` and `inTokens: 31732`. So the first request (about 133k
  characters) went through, and the request after the 15 results failed.
- In bd5d2d11 and 2e5f2daa the TURN PROGRESS block shows the same reads "read 3 times" /
  "read 2 times". Earlier trims had removed those results, the model read them all again in
  one big batch, and that batch went over the cap.

## Size math (re-run with the real builders)

`traderSystemPrompt()` and the trader tool registry built from `TRADER_TOOLS` were run with
an empty temporary `DATA_DIR` and the repo's v8 policy. The live playbook may be a bit bigger.

- System prompt: 50,307 characters (51,180 as JSON).
- Tool list: 53 tools, 48,821 characters as JSON.
- `turnMessageLimit` = 97,973. Message 0 takes ~35k of that, which leaves about 60k for the
  newest batch (~4k per result over 15 calls). A normal position review is 10–10.7k
  (see [trader-token-use.md](trader-token-use.md)).
- The real `compactMessages` was fed a 33k cycle message, one older round, and 15 results of
  4k / 6k / 8k (and 21 × 5k). It always kept 3 messages, and the full request came to
  198k / 228k / 258k / 244k characters. Only the 4k case was under the cap.

## Could the turn have gone on?

Yes. Every result was already saved in full as a receipt. Replacing some inline results with
the existing pointer note (`{truncated:true, receiptId, ...}`, which `get_tool_result` reads)
loses no evidence. It is a pointer, not shortened text. The model would read what it needs
next round instead of the whole turn failing.

## Recommended fix

1. In `compactMessages`: when the floor of 3 messages is reached and it is still over
   `limit`, swap the largest `tool_result` contents in the newest exchange for the
   `boundedResult`-style receipt note, largest first, until it fits. If that is still not
   enough (only possible if the cycle message alone is too big), fail with a clear error
   before calling the model.
2. Optionally, in `runAgentLoop` at line 375: keep a running total of inline result size for
   the batch, and send results past the room left as receipt notes right away.
3. Worth thinking about: the system prompt plus tools (~100k) and `CYCLE_CONTEXT_BUDGET`
   (40k, `savedResults.ts:23`) leave the conversation very little room. A line in the prompt
   asking for smaller tool batches would also help.

## Tests that would prove it

Next to `tests/turn-limit.test.cjs` / `tests/turn-progress.test.cjs`:

- `compactMessages` of [35k cycle message, a 15-call batch, 15 × 10k results] with limit
  97,973 returns messages whose JSON is ≤ limit − pinned. Every `tool_use` still has a
  matching `tool_result`, and the swapped ones carry their `receiptId`.
- An end-to-end `runAgentLoop` test with a fake provider: the first response asks for
  15 tools, each returning a 12k result. Every `chat` call gets
  `JSON.stringify(params).length ≤ 200,000`, the turn reaches the model's sleep, and it never
  ends `failed` with the request-limit error.

## How it was found

T-69 read the trim and budget code (`agentLoop.ts`, `savedResults.ts`, `modelBudget.ts`,
`modelProvider.ts`), went through the saved messages of the 6 failed turns, and re-ran the
real prompt and tool builders plus `compactMessages` with test inputs to measure sizes. Line
numbers refer to the code as it was during T-69.

**Not checked:**

- The real result sizes of these batches (the tool-calls receipts are on the server).
- The live playbook's exact length.
- The old local `data-alpaca` copy was not used, as told.
- No project files were changed; the scratch scripts were deleted.

## Next step

Do fix 1 together with the two tests above as a small change task. Then check the next day of
server turns for any "request limit" failures.
