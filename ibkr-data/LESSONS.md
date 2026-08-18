# LESSONS

What this system got wrong and what changed as a result. Append-only, oldest first.

A lesson is a CHANGED RULE OF THUMB, not a diary entry. "XLE gapped on an OPEC headline
nobody checked, so energy entries need a scheduled-events check" is a lesson. "The tape was
choppy" is noise. Most cycles add nothing here, and that is correct — a file that grows
every cycle is a file nobody rereads.

Hand-editing is expected: delete a lesson that turned out wrong. Nothing reads this file
but the trader's cycle context, and nothing writes it but `write_lesson`.

## 2026-08-14T06:22:54.843Z — policy v4

## XLF: Positions without recorded stops must be retrofitted, not force-exited

The XLF position (entered ~2026-08-12, avg cost $57.71, 86 shares, ~$5,000 notional) had no `intendedStop` in any journal entry — 22 consecutive hold decisions each referenced "broker bracket stop active" or "stop in place" without any of those stops being recorded in `execute_entry`. The system had no enforceable stop baseline.

**Rule going forward:** Any position that appears in `get_positions` without a corresponding `intendedStop` in the journal must be retrofitted this cycle using `annotate_position(symbol, stopLoss, thesis)` — derive a stop level from `get_signals(symbol)` (ATR-based) and write it in. Do NOT automatically exit the position. A forced market exit on a live, potentially healthy position destroys value unnecessarily. The CYCLE FRAMEWORK (step 4) already mandates this retrofit path. Automatic exit is reserved for cases where `annotate_position` itself fails or the operator has explicitly instructed an exit.

**Evidence:** XLF journal (50 entries, all `intendedStop: null`), portfolio context warning "no entry price, no stop: XLF".

## 2026-08-14T13:55:13.317Z — policy v6

## BTC/USD: Broker rejects all market exits with "invalid crypto time_in_force" — cannot enforce stop discipline at market

The BTCUSD position (entered 2026-08-12, 0.0787 BTC at $63,360) hit its recorded stop of $62,726 on 2026-08-14. Two consecutive `execute_exit` calls were rejected by the broker with `422 invalid crypto time_in_force`. The venue does not accept standard time_in_force parameters for crypto market orders via this API.

**Rule going forward:** Do not open new BTCUSD (or other crypto) positions via this system until the broker's crypto order requirements are confirmed. A position whose stop cannot be enforced by the system is a position that violates the core rule "every position carries a stop." The existing BTCUSD position must be monitored manually and exited through an alternate channel. If future crypto trading is enabled, test order routing with a minimal position first before taking full notional risk.

## 2026-08-16T08:14:08.603Z — policy v6

## IBKR connectivity: If three consecutive execute_exit calls time out in the same cycle, treat broker connectivity as degraded and do NOT open new positions for the remainder of that session

On 2026-08-14, three mandatory exits for IBM, SOXX, and SPCX were all rejected with "IBKR placeOrder timed out after 10000ms" in the same ~90-second window. Despite this, the same cycle attempted new entries in subsequent events. A broker that cannot route exits also cannot reliably route entries — and new positions opened into a degraded-connectivity session become immediately unmanageable.

**Rule going forward:** If two or more execute_exit calls in a single cycle return broker timeouts, declare the session "connectivity degraded" in the hold rationale and skip all new entries for that cycle. Note it explicitly so the next cycle can check whether the exits finally went through before adding risk.

## 2026-08-16T08:18:14.473Z — policy v6

## Positions without recorded stops persist across sessions when broker connectivity fails — retrofit must be completed the SAME cycle as the attempt

On 2026-08-14, IBM, SOXX, and SPCX were all identified as legacy positions with no recorded stops. The cycle attempted `execute_exit` on all three; all timed out ("IBKR placeOrder timed out after 10000ms"). The cycle also called `annotate_position` to retrofit stops, but the intents did not fully persist. By the 2026-08-16 weekend cycle, all three still showed "NO STOP RECORDED HERE" in the portfolio context — the machine had no level to watch — despite an entire session having passed.

**Rule going forward:** After any broker-timeout cycle, the very next cycle (even if pre-market or weekend) must verify via `get_positions` that (1) the stops are recorded in the system and (2) the intended exits actually went through. If positions remain open with no recorded stops, `annotate_position` must be called immediately — before any other reasoning — regardless of market hours. A weekend cycle is not an excuse to defer: stops recorded off-hours become active at the next open, and an unrecorded stop is invisible to the machine for however many sessions pass.

**Evidence:** IBM/SOXX/SPCX all showed `NO STOP RECORDED HERE` on 2026-08-16 despite annotate_position being called on 2026-08-14. IBM is now -16.32% from entry ($281.08 → ~$234), SOXX -6.90%, SPCX -7.37%. All three exits were supposed to happen on Aug 14; two full days of drawdown accumulated because the retrofit didn't persist and no exit was achieved.

## 2026-08-17T10:45:51.055Z — policy v6

## Pre-market retrofit must succeed before sleeping — verify annotate_position output every call

On 2026-08-17 (pre-market), IBM/VT/SOXX/SPCX/QQQ all still showed "NO STOP RECORDED HERE" despite annotate_position being called in prior cycles (2026-08-14, 2026-08-16). This is the third consecutive session these positions arrived unstopped. The cause: annotate_position returns an error if takeProfit is at or below the entry price, or if stopLoss is at or above the current price the system holds — and the caller must handle these errors and retry with corrected parameters, not assume the call succeeded.

**Rule going forward:** After every annotate_position call, check the return value for `"ok":true`. If it returns an error, immediately retry with corrected parameters (e.g., set takeProfit above the venue's current/entry price, set stopLoss below it). Do not proceed to ack_event or sleep until `"ok":true` is confirmed for each position. A single failed annotate_position leaves that position invisible to the stop-detector for the entire next session.

**Evidence:** IBM annotate failed first attempt (takeProfit $260 below entry $281.08), VT failed (stopLoss $159 above current $155.48), SOXX failed (takeProfit $590 below entry $591.41). All three succeeded on retry. IBM is now -16.3% from entry after three sessions of missed exits.

## 2026-08-17T10:53:00.339Z — policy v6

## IBM/SOXX/SPCX: Delayed exits due to pre-market timing compound losses — schedule exits for exactly 09:30 open, not as "to-do at next open"

IBM was flagged for exit on 2026-08-14 (thesis invalidated, EMA cross-down, -16% from entry). SOXX and SPCX were similarly flagged. Broker timeouts on 2026-08-14 prevented execution. However, subsequent weekend and pre-market cycles (2026-08-16, 2026-08-17 10:44) recorded "EXIT AT MARKET OPEN" as a hold decision but did NOT actually submit execute_exit — the market was closed and exits were deferred again. By 2026-08-17 market open, these positions had been "earmarked for exit" for 3 full sessions without the order being placed.

**Rule going forward:** When market is pre-market (isOpen=false) and a position is flagged for exit, call execute_exit immediately — the system will queue the order for the open. Do not record another HOLD and plan to "exit at open next cycle." The journal already showed three consecutive cycles with "EXIT AT MARKET OPEN" as rationale and zero exit attempts. If execute_exit returns ok:true in pre-market, the order is queued; if it fails, retry or escalate. Never leave a pre-market exit as a deferred intention.

**Evidence:** IBM lost ~16.3% ($281.08 → ~$234.43, ~$1,580 loss on 34 shares), SOXX lost ~6.9% ($591.41 entry, 18 shares), SPCX lost ~7.4% ($151.16, 27 shares) — all accumulated across sessions where the exit was "planned but not submitted." Exits finally submitted on operator instruction 2026-08-17T10:52.
