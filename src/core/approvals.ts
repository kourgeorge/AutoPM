/**
 * The operator approval gate — the human in the loop, and the plumbing that reaches them.
 *
 * Two things live here, and nothing else:
 *  - `approvalRequired`, the pure policy question: does THIS action on THIS venue need a
 *    human? Sync and side-effect-free, so any caller can ask it without arming anything.
 *  - `requestApproval`, the request/response itself: ask whoever is listening, wait, and
 *    settle — by answer, by deadline, or by there being nobody to ask.
 *
 * WHY A REGISTERED CHANNEL RATHER THAN A DIRECT UI CALL. `src/ui/ui.ts` builds a blessed
 * screen AT IMPORT: it clears the terminal and holds the event loop open forever. This
 * module is imported by `strategy/orderManager.ts`, which is imported by the replay harness
 * and by probe scripts — so a direct import would make every one of those a TUI. `daemon.ts`
 * is the only place that owns both halves, so it does the wiring.
 *
 * The consequence is deliberate and it is the safe one: a process that registers no channel
 * has nobody to ask, so an armed gate refuses (`approval_unavailable`) rather than assuming
 * consent. A headless run against a live account cannot trade. That is the intended reading
 * of "the operator must approve".
 *
 * This module never throws. `GuardRejection` belongs to the strategy layer, and importing it
 * would close the loop `orderManager → approvals → orderManager`; the caller translates an
 * outcome into its own refusal instead.
 */

import { config } from './config';
import { logger } from './logger';
import { getPolicy } from '../policy/load';
import type { ApprovalPolicy } from '../policy/types';

/** The actions with an enforcement point. One per `policy.approval.require` key. */
export type ApprovalAction = 'entry' | 'exit';

/** What the operator is being shown. Every field is a number someone can check against. */
export interface ApprovalRequest {
  action: ApprovalAction;
  symbol: string;
  /** `paper` or `live`, from `config.venue`. Rendered first: it is the reason to care. */
  venue: 'paper' | 'live';
  /** The qty that will actually reach the venue — after regime sizing, not as requested. */
  qty: number;
  price: number | null;
  notional: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Unrealized P&L on an exit, when the venue reported one. */
  pnl: number | null;
  /** The model's own one-liner for the trade. */
  reason: string;
  /** Absolute epoch ms. Both sides count down against this same number. */
  deadline: number;
}

/** The answer. `deny` covers an explicit refusal only — a lapse is the gate's own business. */
export type ApprovalAnswer = 'approve' | 'deny';

/**
 * Whoever can reach a human. Returns their answer; may be ABANDONED when the deadline
 * passes, so an implementation must not assume its promise is still awaited.
 */
export type ApprovalChannel = (req: ApprovalRequest) => Promise<ApprovalAnswer>;

export type ApprovalOutcome =
  | { granted: true; by: 'operator' | 'not_required' | 'timeout' }
  | { granted: false; rule: ApprovalRule; message: string };

/**
 * Refusal reasons, as stable machine names.
 *
 * These reach `journal.jsonl` as `vetoRule` through `orderManager`'s `reject()`, so
 * `grep '"vetoRule":"approval_timeout"'` has to be able to answer "how many trades did I
 * miss by not being at the desk" months from now. Never reword them.
 */
export type ApprovalRule =
  | 'approval_denied'
  | 'approval_timeout'
  | 'approval_unavailable'
  | 'approval_busy';

let channel: ApprovalChannel | null = null;

/** One at a time. See the note in `requestApproval`. */
let pending: ApprovalRequest | null = null;

/** Wire up the operator channel. `daemon.ts` calls this once; pass `null` to tear it down. */
export function setApprovalChannel(ch: ApprovalChannel | null): void {
  channel = ch;
}

/** Is a channel registered? For the boot banner — never as a reason to skip the gate. */
export function hasApprovalChannel(): boolean {
  return channel !== null;
}

/**
 * Does this action need a human right now? Pure.
 *
 * The venue defaults to `config.venue`, which is DERIVED from the endpoint rather than
 * configured — so `live_only` cannot be wrong about which account is live. Both arguments are
 * injectable for the probe, and for no other reason.
 */
export function approvalRequired(
  action: ApprovalAction,
  approval: ApprovalPolicy = getPolicy().approval,
  venue: 'paper' | 'live' = config.venue,
): boolean {
  if (approval.mode === 'off') return false;
  if (approval.mode === 'live_only' && venue !== 'live') return false;
  return approval.require[action];
}

/** One line for the log and the boot banner: what the gate is doing, in words. */
export function approvalSummary(
  approval: ApprovalPolicy = getPolicy().approval,
  venue: 'paper' | 'live' = config.venue,
): string {
  const armed = (['entry', 'exit'] as const).filter((a) => approvalRequired(a, approval, venue));
  if (armed.length === 0) {
    return `disarmed (mode ${approval.mode}, venue ${venue})`;
  }
  return `armed on ${venue} for ${armed.join(', ')} — ${approval.timeoutMs / 60_000} min to answer, then ${approval.onTimeout}`;
}

/**
 * Ask the operator, and wait.
 *
 * Returns `{granted: true, by: 'not_required'}` when the gate is disarmed for this action, so
 * a caller is one call rather than a branch plus a call — there is no path where a caller
 * decides for itself that it need not ask.
 *
 * The deadline is stamped HERE and travels in the request, so the operator's countdown and
 * this timer are the same number. On a lapse the channel's promise is abandoned rather than
 * cancelled: it has no cancellation in its contract, and a late answer must not resolve an
 * outcome that has already been journalled.
 */
export async function requestApproval(
  action: ApprovalAction,
  details: Omit<ApprovalRequest, 'action' | 'venue' | 'deadline'>,
): Promise<ApprovalOutcome> {
  const approval = getPolicy().approval;
  if (!approvalRequired(action, approval)) {
    return { granted: true, by: 'not_required' };
  }

  if (!channel) {
    // Fail closed. The alternative — proceeding because nobody is listening — turns an
    // unattended live daemon into exactly the thing the gate exists to prevent.
    const message = `${action} on ${details.symbol} needs operator approval and no operator channel is attached (headless run?)`;
    logger.warn(`[Approval] ${message}`);
    return { granted: false, rule: 'approval_unavailable', message };
  }

  // The trader's cycle is serial and the concierge cannot place orders, so a second
  // concurrent request is unreachable today. It is refused rather than queued anyway,
  // because the failure it would otherwise produce is the worst kind available here: two
  // prompts on screen at once and one `y` that cannot be attributed to either.
  if (pending) {
    const message = `${action} on ${details.symbol} refused: an approval for ${pending.action} ${pending.symbol} is already awaiting the operator`;
    logger.warn(`[Approval] ${message}`);
    return { granted: false, rule: 'approval_busy', message };
  }

  const req: ApprovalRequest = {
    ...details,
    action,
    venue: config.venue,
    deadline: Date.now() + approval.timeoutMs,
  };
  pending = req;

  const where = `${action} ${details.symbol} × ${details.qty}`;
  logger.trade(`[Approval] ${where} — awaiting operator (${approval.timeoutMs / 60_000} min)`);

  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race<ApprovalAnswer | 'timeout'>([
      // A channel that throws is a broken operator link, not a decision. Treated as no
      // answer, so it settles by policy instead of escaping as an unhandled error.
      channel(req).catch((err: any) => {
        logger.error(`[Approval] operator channel failed: ${err?.message ?? err}`);
        return 'timeout' as const;
      }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), approval.timeoutMs);
      }),
    ]);

    if (answer === 'approve') {
      logger.trade(`[Approval] GRANTED by operator: ${where}`);
      return { granted: true, by: 'operator' };
    }

    if (answer === 'deny') {
      const message = `Operator denied ${where}`;
      logger.warn(`[Approval] DENIED by operator: ${where}`);
      return { granted: false, rule: 'approval_denied', message };
    }

    // Lapsed. `allow` is a documented operator choice, and it is logged as loudly as a
    // refusal — an order that went in unapproved must never be quiet.
    if (approval.onTimeout === 'allow') {
      logger.warn(`[Approval] NO ANSWER in ${approval.timeoutMs / 60_000} min — proceeding unapproved (onTimeout: allow): ${where}`);
      return { granted: true, by: 'timeout' };
    }

    const message = `No operator answer within ${approval.timeoutMs / 60_000} min — ${where} refused`;
    logger.warn(`[Approval] TIMED OUT: ${where}`);
    return { granted: false, rule: 'approval_timeout', message };
  } finally {
    if (timer) clearTimeout(timer);
    pending = null;
  }
}
