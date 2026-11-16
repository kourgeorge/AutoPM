# Model route efficiency: reasoning with tools, prompt caching, batched reads (T-23)

**Short answer.** The rule in the code comment is still OpenAI's rule. On `/chat/completions`,
GPT-6 Luna takes function tools only with `reasoning_effort: "none"`. But the live route
(LiteLLM `chatgpt/…`) calls the Responses API underneath anyway, and Responses allows tools
*with* reasoning. So "low" reasoning is possible, either through LiteLLM's bridge or by
calling `/responses` directly. On caching: OpenAI caches automatically, but the ChatGPT
backend only gets cache hits when it sees a stable session id. **We also never read the
cached-token field on this code path.** So "no cached tokens recorded" tells us nothing yet.
Both changes need a measurement on the live model. The replay harness has no model in it and
cannot do this A/B.

Dates: checked 2026-11-16. Web sources are quoted as they read on that day. Third-party
pages are marked as such.

---

## 1. Reasoning with tools

### What the code does

- `src/core/modelProvider.ts:304-328` sends `reasoning_effort: 'none'` to any `gpt-5…9`
  model when tools are present. The comment quotes the error for `gpt-5.6-luna`. The comment
  and the rule came in commit `0945a26` (2026-08-26, "fix(core): a missing key is only fatal
  where a key is actually needed"). That was when the model was `azure/gpt-5.6-luna` through
  the LiteLLM proxy. `git log -S "Function tools with reasoning_effort"` finds only this
  commit and T-21's note. The rule has not been revisited since, and in particular not for
  `chatgpt/gpt-6-luna`.
- `:341` also sends `temperature: 0` whenever the host is not `api.openai.com`. That is
  always true through LiteLLM.

### What OpenAI says (official)

- "GPT-6 Sol and GPT-6 Luna support function calling in Chat Completions only with
  `reasoning_effort: "none"`." "Use Responses for reasoning with tools."
  "GPT-6 Astra and GPT-6.1 Sol do not support the `none` reasoning effort; … GPT-6 Luna
  [does]." Source: [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model).
- On the same page: "When reasoning effort is not `none`, remove `temperature`, `top_p`, and
  `top_logprobs`." This means the `temperature: 0` at `:341` must go if reasoning is turned on.
- "GPT-6.1 Sol, GPT-6 Sol, and GPT-6 Luna also default to `medium` reasoning effort."
  Reasoning tokens "are billed as output tokens." In tool loops, "pass back the reasoning
  items returned with the function calls along with the tool outputs". This is done with
  `previous_response_id`, or with `encrypted_content` when `store: false`. Source:
  [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning).
- An OpenAI support reply (2026-09-07) says the rule is deliberate: "Responses supports the
  tool workflow, but we haven't confirmed a fix for this exact Chat Completions combination."
  Source: [community thread](https://community.openai.com/t/gpt-5-6-chat-completion-reasoning-effort-bug-behavior-change/1386454).

### What LiteLLM says

- `chatgpt/` provider: "ChatGPT subscription access is native to the Responses API".
  Endpoints: "`/responses`, `/chat/completions` (bridged to Responses for supported models)".
  The backend "rejects token limit fields (`max_tokens`, … ) and `metadata`", and "LiteLLM
  strips these fields". The page names `gpt-6-luna` as an example model. It says nothing
  about `reasoning_effort`, tools or caching. Source:
  [LiteLLM ChatGPT Subscription](https://docs.litellm.ai/docs/providers/chatgpt).
- `openai/` provider: LiteLLM "auto-routes these requests to `/v1/responses` when both
  `tools` and `reasoning_effort` are set". You can also force this with an
  `openai/responses/<model>` prefix. Its own example uses tools with
  `reasoning_effort="low"`. Source: [LiteLLM OpenAI](https://docs.litellm.ai/docs/providers/openai).
- Known bridge bugs: `gpt-6-*` names did not trigger the bridge until commit `ab515dbc90`
  (2026-09-03, [issue #40123](https://github.com/BerriAI/litellm/issues/40123)). A named
  `tool_choice` was not translated
  ([#27611](https://github.com/BerriAI/litellm/issues/27611)). This matters because the
  trader uses `tool_choice` (`modelProvider.ts:335`).

### What I could not check

- I could not see which LiteLLM version runs on the server. I also could not see its proxy
  config, or whether `chatgpt/gpt-6-luna` passes a non-`none` `reasoning_effort` through. The
  live app is on a server. The local data folders are off-limits for this task.
- Whether LiteLLM's chat→Responses bridge keeps the model's reasoning items between rounds.
  The issue pages say nothing about it. **Guess:** it does not, because our chat-format
  history has no place for those items. If so, each round reasons from scratch. That costs
  output tokens and keeps less of the plan from round to round.
- Whether reasoning actually leads to fewer rounds. Nobody has measured this for this
  workload.

### What it would cost per call

The only official per-token figures for the ChatGPT plan are credit rates for GPT-6 Luna:
**2.5 input / 0.25 cached input / 12.5 output credits per 1M tokens**
([ChatGPT pricing](https://learn.chatgpt.com/docs/pricing)). The same page warns: "Credit
prices alone don't determine included subscription usage." So treat the figures below as
proportions only.

- Fixed part today: ~47k input tokens per call ≈ **0.12 credits per call**, uncached.
- Low reasoning, *guess* of 300–1,500 extra output tokens per call: ≈ 0.004–0.019 credits.
  That is roughly 3–15% on top of the input cost of one call. Reasoning adds time per call.
  How much is not measured.
- So reasoning pays for itself if it cuts rounds by more than ~15%. Caching (section 2) is
  the bigger lever.

---

## 2. Prompt caching

### What exists

- OpenAI: "Prompt caching is enabled by default for supported OpenAI models." The minimum is
  1,024 tokens for GPT-5.6 and later. "The entire rendered prefix" must match, and tool
  definitions are part of the prefix. For GPT-5.6+, "OpenAI handles cache routing
  automatically; the key is not needed to optimize caching". There, `prompt_cache_key` is
  mainly for keeping each customer's cache separate. Reads cost "0.1× the ordinary input
  rate on most of these models". Writes cost 1.25× for the 30-minute TTL. "Cached input
  tokens still count toward tokens-per-minute limits." The guide documents the Responses
  field `usage.input_tokens_details.cached_tokens`. Source:
  [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- LiteLLM reports cache hits in the OpenAI chat format, as
  `usage.prompt_tokens_details.cached_tokens`. "OpenAI prompt caching is automatic".
  Through the proxy, `prompt_cache_key` is passed in `extra_body`. Source:
  [LiteLLM prompt caching](https://docs.litellm.ai/docs/completion/prompt_caching).
- ChatGPT/Codex backend (third party, not official): the Codex CLI source comment "ChatGPT
  derives cache affinity from the Responses session-id header". A proxy that did not forward
  a `session-id` header got `cached_tokens` 0/0/0. After the fix it got 0/19,072/19,072
  (99%). In production, the proxy got "2–6% cached input" versus ~75% on the OpenAI API.
  Source: [openai-oauth #46](https://github.com/EvanZhouDev/openai-oauth/issues/46). A
  similar report: [pi #3196](https://github.com/earendil-works/pi/issues/3196).

### In this project

- `modelProvider.ts:384-387` reads only `prompt_tokens` and `completion_tokens`. It never
  reads `prompt_tokens_details.cached_tokens`. Only the Anthropic path sets
  `cachedInputTokens` (`:162`). So T-21's "no cached tokens recorded" is **not evidence that
  nothing is cached**. The field is simply never looked at.
- I did not find out whether LiteLLM's `chatgpt/` provider sends a stable `session-id` to the
  ChatGPT backend. Its docs don't say. If it does not, hits will be low no matter what we
  send (inferred from the reports above).

### Does a ChatGPT plan's limit count cached tokens?

- Official: plans share one allowance, "measured in tokens"
  ([Help Center](https://help.openai.com/en/articles/20001625-understanding-chatgpt-and-codex-usage-limits)).
  The credit table charges cached input at **one tenth** of the input rate for GPT-6 Luna
  (0.25 vs 2.5), and "Weekly limits may also apply"
  ([pricing](https://learn.chatgpt.com/docs/pricing)). OpenAI does not publish how the
  included weekly allowance weighs cached tokens.
- A user report: cached tokens do use up the weekly allowance. One Pro user spent 26% of a
  week on 75M tokens, 96% of them cache reads. There is no OpenAI reply
  ([openai/codex #36488](https://github.com/openai/codex/issues/36488)).
- Conclusion: cached tokens count, very likely at a reduced weight. That last part is a
  guess based on the credit table.

Expected effect: if ~45k of the ~47k fixed tokens hit the cache, input cost per call drops
from ≈0.12 to ≈0.016 credits (about −85%) by the credit table. Round count does not change.

---

## 3. Asking for parallel reads

- Supported. "The model may choose to call multiple functions in a single turn". You can turn
  it off with `parallel_tool_calls: false`. We don't send that field, so it stays on. Source:
  [Function calling](https://developers.openai.com/api/docs/guides/function-calling).
- T-21 saw batches of up to 15 calls (`docs/research/trader-token-use.md:41-44`). So the
  route and the harness already handle them. `src/agents/agentLoop.ts:178` runs the calls of
  one batch one after another.
- There is no batching hint in the trader prompt today. A grep of `src/agents` found none.
- Worth trying. It is a one-line prompt change with no extra cost per call. A model with
  reasoning off may follow it less reliably (guess). That is why it belongs in the same A/B
  as reasoning.

---

## Recommendation

1. **Measure first (smallest change).** In `OpenAICompatibleProvider` (`modelProvider.ts:384`),
   set `cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0`. Let it run
   for a day. This tells us whether the current route caches at all.
2. **If cache hits are near zero:** send a stable `prompt_cache_key` per agent, e.g.
   `autotrade-trader` (through LiteLLM it goes in the request body). Check the LiteLLM
   version on the server, and whether its `chatgpt/` provider sends a `session-id` header.
   If it doesn't, that is a LiteLLM/proxy fix, not ours. Keep the system prompt and tool list
   byte-identical, in a fixed order, across calls. Any change moves the cache break point.
3. **Reasoning A/B on the live model, not `npm run replay`.** The replay harness has "no LLM"
   (`src/scripts/replay.ts:5`), so it cannot show a model behaviour change. Add a setting to
   choose the reasoning effort, and keep `none` as the default. With `low`: drop
   `temperature`, check that LiteLLM routes the call to Responses and keeps a named
   `tool_choice`, and run a few days alternating `none` / `low` / `none + batch hint` /
   `low + batch hint`. Compare rounds per turn, share of rounds with more than one call,
   output tokens per call, seconds per call, and decisions per turn. Calling `/responses`
   directly with `previous_response_id`, so reasoning carries over between rounds, is the
   bigger version of this. Do it only if `low` shows a gain.
4. **Expected effect.** Caching: roughly −85% input cost per round, no change in rounds (if
   hits work). Reasoning `low`: +3–15% cost per call, unknown change in rounds. Worth it only
   if rounds fall by more than ~15%. Batch hint: free. The effect is unknown until measured.
