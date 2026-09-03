#!/usr/bin/env bash
# Push a Slack notification when a Claude Code session needs attention.
#
# Wired to the Notification and StopFailure hooks in ~/.claude/settings.json.
# Posts four text fields to a Slack Workflow Builder webhook trigger:
#
#   source   folder the session was started in  (which instance needs you)
#   message  short summary of what's needed
#   summary  the session recap, when one is available — see "recap" below.
#            Empty string when there is none, so the field is always present
#            and the Slack-side template can treat it as optional.
#   type     one of a fixed set, for Slack-side icon/colour decoration:
#              permission_prompt   blocked waiting for tool approval
#              idle_prompt         waiting for your input
#              agent_needs_input   a background agent needs you
#              agent_completed     a background agent finished
#              session_failed      turn died on an API error (detail in message)
#              unknown             type could not be determined (see debug log)
#
# Design notes:
#   - Presence gate: silent if you've touched the keyboard recently, so it only
#     pings when you've actually walked away. Fails OPEN — if the idle check
#     can't run, the notification is sent rather than dropped.
#   - In-flight gate: an idle_prompt raised while background work is still
#     running is premature, so it is dropped. Only idle_prompt is gated — a
#     permission_prompt blocks the main loop and needs you regardless of what
#     else is running. Fails OPEN.
#   - Recap: Claude Code writes a session recap into the transcript as a
#     system/away_summary record — a couple of sentences on what you were doing
#     and what is next. That is far more use on a phone than "waiting for your
#     input", so idle_prompt carries it in the summary field.
#
#     Timing is the catch. Measured over 127 recaps, the record appears
#     184-262s after the turn ends (median 192s) — a timer, keyed to turn end,
#     not to your last input (that spread runs to 16h, so it is unrelated).
#     idle_prompt fires well before that, so the recap does not exist yet when
#     the hook first runs, and no setting controls the notification's timing.
#
#     So the hook defers its own post instead: it re-executes itself, detached,
#     once the recap is due, and the deferred run applies every gate afresh —
#     if you came back in the meantime the presence gate drops it, and if work
#     started the in-flight gate does. Detached rather than sleeping in place so
#     no hook timeout can kill it mid-wait.
#   - Debounce: one push per source+type per window, so a run of permission
#     prompts doesn't become a run of phone buzzes.
#   - Type detection is defensive. The exact input field carrying the
#     notification type is not documented in the version of the docs we could
#     read, so we try named fields, then scan the payload for a known token,
#     then infer from the message text. Raw payloads are logged so the real
#     field name can be confirmed and this simplified.
#   - Never fails loudly: a Slack outage is not worth interrupting work over.
#     Always exits 0.
#
# Env overrides (see .slack-env):
#   CLAUDE_NOTIFY_IDLE_MS         presence threshold in ms (default 120000)
#   CLAUDE_NOTIFY_DEBOUNCE        min seconds between same source+type (def 90)
#   CLAUDE_NOTIFY_FORCE=1         bypass the presence gate
#   CLAUDE_NOTIFY_DRYRUN=1        print the payload instead of POSTing
#   CLAUDE_NOTIFY_DEBUG=0         disable raw payload logging
#   CLAUDE_NOTIFY_STALE_TASK_SECS age at which an uncompleted background task
#                                 stops counting as in flight (default 1800)
#   CLAUDE_NOTIFY_IGNORE_TASKS=1  bypass the in-flight gate
#   CLAUDE_NOTIFY_RECAP_WAIT      seconds after turn end to wait for a recap
#                                 before posting anyway (default 285; measured
#                                 worst case is 262). 0 disables deferral, so
#                                 the recap is included only if already present.
#   CLAUDE_NOTIFY_SUMMARY_MAX     max chars of recap to send (default 600)
#   CLAUDE_NOTIFY_NOTION_SYNC=0   don't also save the recap to this session's
#                                 Notion page (see notion-session-logger/sync_recap.sh)

set -uo pipefail

CONF="${HOME}/.claude/hooks/.slack-env"
STATE_DIR="${HOME}/.claude/hooks/.state"
DEBUG_LOG="${HOME}/.claude/hooks/hook-payloads.jsonl"

[ -r "$CONF" ] && . "$CONF" 2>/dev/null

IDLE_THRESHOLD_MS="${CLAUDE_NOTIFY_IDLE_MS:-120000}"
DEBOUNCE_SECS="${CLAUDE_NOTIFY_DEBOUNCE:-90}"
DRYRUN="${CLAUDE_NOTIFY_DRYRUN:-0}"
STALE_TASK_SECS="${CLAUDE_NOTIFY_STALE_TASK_SECS:-1800}"
RECAP_WAIT="${CLAUDE_NOTIFY_RECAP_WAIT:-285}"
SUMMARY_MAX="${CLAUDE_NOTIFY_SUMMARY_MAX:-600}"
SELF=$(readlink -f "${BASH_SOURCE[0]:-$0}" 2>/dev/null || printf '%s' "$0")

input=$(cat)
jqr() { jq -r "$1 // empty" <<<"$input" 2>/dev/null; }

# --- debug capture -----------------------------------------------------------
# Logged before the presence gate so suppressed notifications are captured too.
# This is how we learn the real field names; set CLAUDE_NOTIFY_DEBUG=0 to stop.
if [ "${CLAUDE_NOTIFY_DEBUG:-1}" = "1" ]; then
  mkdir -p "$(dirname "$DEBUG_LOG")" 2>/dev/null || true
  # _logged_at is ours, not the harness's. Without it the log says nothing about
  # *when* a notification fired, which is what you need to compare against
  # transcript timestamps — e.g. how long after a turn ends idle_prompt arrives,
  # and whether the away_summary recap has been written by then.
  jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson deferred "$([ "${CLAUDE_NOTIFY_DEFERRED:-0}" = 1 ] && echo true || echo false)" \
        '. + {_logged_at: $at} + (if $deferred then {_deferred: true} else {} end)' \
    <<<"$input" >> "$DEBUG_LOG" 2>/dev/null || true
  if [ "$(wc -l < "$DEBUG_LOG" 2>/dev/null || echo 0)" -gt 400 ]; then
    tail -n 200 "$DEBUG_LOG" > "${DEBUG_LOG}.tmp" 2>/dev/null \
      && mv "${DEBUG_LOG}.tmp" "$DEBUG_LOG" 2>/dev/null || true
  fi
fi

event=$(jqr '.hook_event_name')
cwd=$(jqr '.cwd')
sid=$(jqr '.session_id')
msg=$(jqr '.message')
transcript=$(jqr '.transcript_path')

# source: folder the session was started in.
if [ -n "$cwd" ]; then source_name=$(basename "$cwd"); else source_name="unknown"; fi

# --- type detection ----------------------------------------------------------
NOTIF_TOKENS='permission_prompt|idle_prompt|auth_success|agent_needs_input|agent_completed|elicitation_dialog|elicitation_url_dialog|elicitation_complete|elicitation_response'
ERROR_TOKENS='rate_limit|overloaded|authentication_failed|oauth_org_not_allowed|billing_error|invalid_request|model_not_found|server_error|max_output_tokens'

# Scan every string value in the payload for one of a known token set.
scan_for() {
  jq -r '[.. | strings] | .[]' <<<"$input" 2>/dev/null \
    | grep -oxE "$1" 2>/dev/null | head -n 1
}

if [ "$event" = "StopFailure" ]; then
  err=$(jqr '.error_type // .errorType // .error // .reason // .stop_reason')
  [ -n "$err" ] || err=$(scan_for "$ERROR_TOKENS")
  [ -n "$err" ] || err="unknown error"
  type="session_failed"
  msg="session failed: ${err}"
elif [ "$event" = "Stop" ]; then
  # A Stop payload carries none of the fields/tokens the cascade below looks
  # for, so it always fell through to "unknown" and skipped the idle_prompt-only
  # recap logic entirely -- posting instantly with no summary. A Stop is the
  # same "waiting for you" condition idle_prompt describes (the Notification
  # hook fires its own idle_prompt ~60s later for the same halt), so classify
  # it that way up front: it then shares the in-flight gate, the recap-wait
  # deferral, and the debounce key, so this and the later real idle_prompt
  # collapse into a single deferred post instead of one instant empty one.
  type="idle_prompt"
  [ -n "$msg" ] || msg="Claude is waiting for your input"
else
  type=$(jqr '.notification_type // .notificationType // .type // .kind // .notification')
  [ -n "$type" ] || type=$(scan_for "$NOTIF_TOKENS")
  if [ -z "$type" ]; then
    # Last resort: infer from the message text.
    lower=$(printf '%s' "$msg" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      *permission*|*approve*|*allow*) type="permission_prompt" ;;
      *waiting*|*idle*)               type="idle_prompt" ;;
      *)                              type="unknown" ;;
    esac
  fi
  # Normalise to the underscore vocabulary above.
  type=$(printf '%s' "$type" | tr '[:upper:]-' '[:lower:]_')
  [ -n "$msg" ] || msg="needs attention"
fi

# --- in-flight gate ----------------------------------------------------------
# "Claude is waiting for your input" only deserves a buzz if nothing is still
# working. Background agents and background shells both announce themselves
# when they land (agent_completed / a task completion), so an idle_prompt
# raised while they run is just early — drop it and let the completion be the
# thing that pings you.
#
# Liveness is read from the transcript, not the process table. A lingering
# `npm run dev &` would sit in the process tree forever and mute this session
# for good, and an in-process subagent puts no process there to find. What the
# transcript has instead is a durable marker per launch and a matching one per
# completion:
#
#   agent  toolUseResult.status == "async_launched"  -> .agentId
#   shell  toolUseResult.backgroundTaskId
#   done   <task-id>ID</task-id> inside a <task-notification>
#
# so in-flight is launched minus completed. Two details are load-bearing:
#
#   1. The async_launched guard. A *synchronous* Agent result carries an
#      agentId too, and counting those marks every subagent the session ever
#      ran as still running.
#   2. Completions are matched structurally, not by grepping the file. The
#      transcript also stores assistant tool_use inputs and command stdout, so
#      any command, pasted log, or read file containing the literal
#      <task-id>..</task-id> would otherwise forge a completion and defeat the
#      gate. Assistant records and tool-result records are therefore excluded,
#      which leaves only the harness-delivered notification. Where that lands
#      varies by build (an "attachment" record with .attachment.prompt in
#      current ones, a "user" or "queue-operation" record in older ones), so
#      every remaining string in the record is searched rather than one field.
#
# A launch whose completion never arrives (turn died mid-flight, task killed)
# would otherwise mute the session permanently, so launches older than
# STALE_TASK_SECS stop counting. Anything unparseable — no transcript, no jq,
# no timestamp — fails OPEN and the notification goes out.
epoch_of() {
  # macOS/BSD date has no -d; GNU date does. Try GNU first, then fall back
  # to BSD's -j -f with the fractional seconds stripped (it can't parse them).
  local ts="$1" clean out
  [ -n "$ts" ] || return 1
  out=$(date -d "$ts" +%s 2>/dev/null) && { printf '%s\n' "$out"; return 0; }
  clean="${ts%%.*}"
  case "$ts" in *Z) clean="${clean}Z" ;; esac
  case "$clean" in
    *Z) out=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$clean" +%s 2>/dev/null) ;;
    *)  out=$(date -j -f '%Y-%m-%dT%H:%M:%S' "$clean" +%s 2>/dev/null) ;;
  esac
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

pending_tasks() {
  local t="$1" now completed id ts launched_at
  [ -r "$t" ] || return 0
  now=$(date +%s)
  completed=$(jq -rc 'select(type == "object")
          | select(.type != "assistant")
          | select(has("toolUseResult") | not)
          | ([.. | strings] | join("\n"))
          | select(test("<task-notification>"))
          | [scan("<task-id>([A-Za-z0-9_-]+)</task-id>")]
          | flatten | .[]' "$t" 2>/dev/null | sort -u)
  jq -rc 'select(type == "object")
          | select((.toolUseResult | type) == "object")
          | (if (.toolUseResult.status == "async_launched"
                 or .toolUseResult.isAsync == true)
             then .toolUseResult.agentId
             else .toolUseResult.backgroundTaskId end) as $id
          | select($id != null and $id != "")
          | [$id, (.timestamp // "")] | @tsv' "$t" 2>/dev/null \
  | while IFS=$'\t' read -r id ts; do
      printf '%s\n' "$completed" | grep -qxF "$id" && continue
      # date -d "" silently yields midnight, so require a timestamp first.
      [ -n "$ts" ] || continue
      launched_at=$(epoch_of "$ts") || continue
      case "$launched_at" in ''|*[!0-9]*) continue ;; esac
      [ "$(( now - launched_at ))" -lt "$STALE_TASK_SECS" ] && printf '%s\n' "$id"
    done | sort -u
}

if [ "$type" = "idle_prompt" ] && [ "${CLAUDE_NOTIFY_IGNORE_TASKS:-0}" != "1" ] \
   && [ -n "$transcript" ]; then
  inflight=$(pending_tasks "$transcript")
  if [ -n "$inflight" ]; then
    printf 'notify-slack: idle_prompt dropped, %s background task(s) in flight: %s\n' \
      "$(printf '%s\n' "$inflight" | wc -l | tr -d ' ')" \
      "$(printf '%s' "$inflight" | tr '\n' ' ')" >&2
    exit 0
  fi
fi

# --- recap -------------------------------------------------------------------
# The newest away_summary in the transcript, but only if it belongs to the
# current idle stretch: a recap older than the last assistant message is left
# over from an earlier pause and would describe the wrong situation.

last_assistant_ts() {
  jq -r 'select(type == "object") | select(.type == "assistant")
         | .timestamp // empty' "$1" 2>/dev/null | tail -n 1
}

current_recap() {
  local t="$1" rec rec_ts rec_epoch asst_epoch
  [ -r "$t" ] || return 0
  rec=$(jq -c 'select(type == "object")
               | select(.type == "system" and .subtype == "away_summary")' \
        "$t" 2>/dev/null | tail -n 1)
  [ -n "$rec" ] || return 0
  rec_ts=$(jq -r '.timestamp // empty' <<<"$rec" 2>/dev/null)
  rec_epoch=$(epoch_of "$rec_ts") || return 0
  asst_epoch=$(epoch_of "$(last_assistant_ts "$t")") || asst_epoch=0
  [ "$rec_epoch" -ge "$asst_epoch" ] 2>/dev/null || return 0
  # Trailing "(disable recaps in /config)" is UI copy, not part of the summary.
  jq -r '.content // empty' <<<"$rec" 2>/dev/null \
    | sed -e 's/[[:space:]]*(disable recaps in \/config)[[:space:]]*$//' \
    | tr '\n' ' ' | sed -e 's/[[:space:]]\{2,\}/ /g' -e 's/^ *//' -e 's/ *$//'
}

# Seconds still to wait before the recap for this turn is due. 0 = due now.
recap_eta() {
  local t="$1" asst_epoch now
  asst_epoch=$(epoch_of "$(last_assistant_ts "$t")") || { echo 0; return; }
  now=$(date +%s)
  local left=$(( asst_epoch + RECAP_WAIT - now ))
  # Never wait longer than the window itself: a clock skew or a doctored
  # timestamp should not park a notification indefinitely.
  [ "$left" -gt "$RECAP_WAIT" ] && left="$RECAP_WAIT"
  [ "$left" -lt 0 ] && left=0
  echo "$left"
}

summary=""
if [ "$type" = "idle_prompt" ] && [ -n "$transcript" ]; then
  summary=$(current_recap "$transcript")
  if [ -z "$summary" ] && [ "${CLAUDE_NOTIFY_DEFERRED:-0}" != "1" ] \
     && [ "$RECAP_WAIT" -gt 0 ] 2>/dev/null; then
    eta=$(recap_eta "$transcript")
    if [ "$eta" -gt 0 ] 2>/dev/null; then
      if [ "$DRYRUN" = "1" ]; then
        printf 'notify-slack: would defer %ss awaiting recap\n' "$eta" >&2
        exit 0
      fi
      # Hand the payload to a detached copy of ourselves that wakes when the
      # recap is due. setsid so no hook timeout reaches it; the child re-runs
      # every gate, so returning or starting work still cancels the post.
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      if pending=$(mktemp "$STATE_DIR/deferred.XXXXXX" 2>/dev/null); then
        printf '%s' "$input" > "$pending"
        setsid nohup bash -c '
          sleep "$1"
          CLAUDE_NOTIFY_DEFERRED=1 "$2" < "$3"
          rm -f "$3"
        ' _ "$eta" "$SELF" "$pending" >/dev/null 2>&1 &
        printf 'notify-slack: idle_prompt deferred %ss awaiting recap\n' "$eta" >&2
        exit 0
      fi
      # mktemp failed: fall through and post now without a recap.
    fi
  fi
fi

if [ -n "$summary" ] && [ "${#summary}" -gt "$SUMMARY_MAX" ] 2>/dev/null; then
  summary="${summary:0:$SUMMARY_MAX}…"
fi

# Save the same recap to this session's Notion page. Independent of the Slack
# presence/debounce gates below — those decide whether to buzz your phone, not
# whether the recap is worth recording.
if [ "$type" = "idle_prompt" ] && [ -n "$summary" ] && [ -n "$sid" ] \
   && [ "$DRYRUN" != "1" ] && [ "${CLAUDE_NOTIFY_NOTION_SYNC:-1}" = "1" ]; then
  "$HOME/.claude/notion-session-logger/sync_recap.sh" "$sid" "$summary" >/dev/null 2>&1 || true
fi

# --- presence gate -----------------------------------------------------------
get_idle_ms() {
  ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000); exit}' 2>/dev/null
}

if [ "${CLAUDE_NOTIFY_FORCE:-0}" != "1" ] && [ "$DRYRUN" != "1" ]; then
  idle_ms=$(get_idle_ms)
  if [ -n "$idle_ms" ] && [ "$idle_ms" -lt "$IDLE_THRESHOLD_MS" ] 2>/dev/null; then
    exit 0
  fi
fi

# --- debounce ----------------------------------------------------------------
# Keyed on session so two instances in the same folder don't mask each other.
if [ "$DRYRUN" != "1" ]; then
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  key=$(printf '%s-%s' "${sid:-nosession}" "$type" | tr -c 'A-Za-z0-9._-' '_')
  stamp="$STATE_DIR/$key"
  now=$(date +%s)
  if [ -f "$stamp" ]; then
    last=$(cat "$stamp" 2>/dev/null || echo 0)
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ "$(( now - last ))" -lt "$DEBOUNCE_SECS" ]; then
      exit 0
    fi
  fi
  printf '%s\n' "$now" > "$stamp" 2>/dev/null || true
  find "$STATE_DIR" -type f -mtime +1 -delete 2>/dev/null || true
fi

# --- send --------------------------------------------------------------------
payload=$(jq -nc \
  --arg source "$source_name" \
  --arg message "$msg" \
  --arg summary "$summary" \
  --arg type "$type" \
  '{source: $source, message: $message, summary: $summary, type: $type}') || exit 0

if [ "$DRYRUN" = "1" ]; then
  printf '%s\n' "$payload"
  exit 0
fi

case "${SLACK_WEBHOOK_URL:-}" in
  https://hooks.slack.com/*) ;;
  *) exit 0 ;;   # not configured yet — stay silent rather than post nowhere
esac

curl -sf -m 15 -X POST \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "$SLACK_WEBHOOK_URL" >/dev/null 2>&1 || true

exit 0
