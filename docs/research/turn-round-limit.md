# Re-check of the 40-round trader turn limit (T-27, data of 2026-11-19 … 11-20)

**Short answer: keep the cap at 40 rounds and 2M input tokens.** In one day of live turns only
1 of 26 trader turns hit the round limit, and none hit the token limit. Raising the round cap
alone would buy about 2–3 rounds, because the 2M token limit is reached near round 42–43 anyway.
The weak spot is the warning: it comes 5 rounds before the end, and the turns that got it needed
4–5 rounds to wrap up. Warning a few rounds earlier (`warnRounds` 5 → 8) is the cheap fix if the
one capped turn really left open decisions.

## Data

From the server, `data-alpaca/db/trajectories.jsonl`. The owner ran it on 2026-11-20 with a node
script that keeps the last saved write of each turn from the last 24h. The data covers
2026-11-19 09:00Z … 2026-11-20 05:18Z.

- 26 trader turns: 20 `completed`, 6 `failed`.
- `model-calls.jsonl`: 483 model calls in the same 24h. The rounds of the 26 turns also add up
  to exactly 483 (450 in completed turns + 33 in failed ones), so the two files match.
- Rounds per completed turn, sorted: 5, 6, 9, 10, 12, 12, 13, 13, 21, 22, 22, 28, 30, 30, 31,
  33, 35, 39, 39, 40. The median is 22 and the average 22.5. 8 of 20 turns used 30 rounds or more.
- Input tokens per round are about 45–47k (e.g. `70dce853`: 1,876,408 over 40 rounds), the same
  as T-21 measured.

Not confirmed: when T-22, T-24 and T-25 went live on the server. The commits are dated
2026-11-16 (`80e159f` T-22, `10d0a6d` T-24, `9968c14` T-25), and the owner did not say which
commit the engine runs. Before those fixes, big turns ran for hundreds of rounds (see
`trader-token-use.md`). Here, turns stay under 40 and the warned ones finish with `sleep`,
which fits the fixes being live. But I did not check the engine version.

## Turns that reached the limit area

The warning is sent at round 35 (`maxRounds - warnRounds`) or at 1.6M tokens (80% of 2M), see
`src/agents/agentLoop.ts:398-402`. The limits are set in `src/agents/trader.ts:17`.

| turn | rounds | in tokens | warned | end |
|---|---|---|---|---|
| `d674178d` | 35 | 1,664,594 | yes | completed (sleep) |
| `ce56f12c` | 39 | 1,800,704 | yes | completed (sleep) |
| `686dfa92` | 39 | 1,806,585 | yes | completed (sleep) |
| `70dce853` | 40 | 1,876,408 | yes | **round_limit** |
| `83b42707` | 33 | 1,573,749 | no | completed (sleep) |

- 3 of 4 warned turns ended on their own with `sleep`, two of them only one round before the
  cap. The warning works, but the margin is thin.
- When a turn ends at the limit, any open decisions are journalled as "Cycle ended with no
  reason recorded" (`src/journal/reviewDecisions.ts:355-363`). I could not check whether
  `70dce853` actually left any. That needs `journal` rows with `requestId` =
  `70dce853-dd93-4f75-95de-1786fdbf06a0` from the server.
- No `token_limit` and no `stale_resume` ends.

## Why not raise or lower the cap

- **Lower** (e.g. 30): 6 of 20 completed turns needed 31–40 rounds and ended properly. They
  would have been cut off.
- **Raise** (e.g. 50): at ~46k tokens per round, the 2M token limit stops a turn at about round
  43, so the round cap would barely matter. Raising both caps goes back towards the long,
  expensive turns that T-18 was written to stop. One capped turn a day does not justify that.
- The comment above `TRADER_TURN_LIMITS` (`src/agents/trader.ts:10-16`) says "a normal review
  takes about 10–20 model round trips". That is now out of date: the median is 22, and busy
  turns take 28–40.

## Something else this data shows

6 of 26 turns (23%) ended `failed` after only 1–11 rounds. These are not limit stops, since
they have no `endReason`. The data I got does not include their `error` field, so the cause is
unknown. It is a bigger loss than the one capped turn.

## Recommended next step

1. On the server, check the journal for `70dce853` to see whether it left decisions marked "no
   reason recorded". If it did, change `warnRounds` from 5 to 8 in `TRADER_TURN_LIMITS`, so the
   warning comes at round 32 or 1.6M tokens. Keep `maxRounds` 40 and `maxInputTokens` 2M, and
   update the "10–20 rounds" comment.
2. Pull the `error` field of the 6 failed turns (`bd5d2d11`, `eb94a45e`, `f08e886a`,
   `051985cc`, `2e5f2daa`, `4c807a0f`) and look into them as a separate task.
3. Repeat this count after another week, and record the engine commit with it.
