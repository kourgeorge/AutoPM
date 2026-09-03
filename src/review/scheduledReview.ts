/**
 * The slow loop: put the whole book in front of the model once per session close.
 *
 * Every other cycle this system runs is a reaction to a level being crossed — a stop broke,
 * an EMA crossed, a price gapped — so the model is always mid-tape, looking at one symbol at
 * one moment. `review_ready` added the one backward-looking edge, and it is still about a
 * single closed trade. Nothing ever asked the question the operator would ask: what does the
 * portfolio look like, and is that the shape anyone chose?
 *
 * Concentration is not a decision anybody makes. It accretes. Six entries that were each
 * individually defensible become four energy names and an HHI nobody picked, and the
 * measurements that would have said so (`get_exposure` since P0) sit behind a tool nothing
 * prompts the model to call until after it matters. This is the prompt.
 *
 * SYNCHRONOUS AND PURE, which is the load-bearing decision here. It measures with
 * `concentration()` — pure by contract since P0, for exactly this caller — over the same
 * `TickData` the detectors just judged, with sectors from the cache-only `getCachedSectors`.
 * It never calls the async `exposure()`. Three reasons, in order of how much they cost to
 * learn the hard way:
 *
 *  1. The "never throws" contract below would otherwise swallow the entire review whenever
 *     Yahoo hiccups — a silent skip of the one event that is supposed to be unmissable.
 *  2. It runs on the reconcile path at the close, which is already doing venue work.
 *  3. A publisher that awaits the network cannot be replayed, and the whole value of this
 *     event is that it fires exactly once, which is a claim only a replay can hold.
 *
 * What that costs is correlations and a live sector lookup for an uncached name. The evidence
 * names `get_exposure` for those rather than pretending they are not missing.
 *
 * One honest exception to "pure": `getCachedSectors` reads `data/sectors.json`. A miss there is
 * `null` and `concentration` excludes it from the sector weights with a caveat, so the file's
 * contents can change the sector breakdown but can never change whether the event fires, what
 * the weights are, or what the HHI is. That is why the replay asserts the weights and not the
 * sectors.
 *
 * `warn`, like `review_ready`: it renders as its own line in the cycle context and reaches the
 * operator, but wakes nobody. The session is over and nothing can be traded on it, so the
 * event lands on the next scheduled cycle — inside the 240-minute post-close sleep, hence
 * always before the next open. Since nothing trades after the close, the numbers measured at
 * the close are still the numbers for the whole window in which the review happens.
 */

import { etDate, etNow } from '../core/time';
import { logger } from '../core/logger';
import type { TickData } from '../features/compute';
import { publishDiscrete, type EvidenceValue, type TriggerEvent } from '../features/eventBus';
import type { Position } from '../broker/IBroker';
import type { Policy } from '../policy/types';
import { concentration } from '../strategy/exposure';
import { getCachedSectors } from '../collect/sectorCache';
import { getState, updateState } from '../state/state';

/** Friday, in `etNow`'s day numbering. The weekly review rides the week's last close. */
const FRIDAY = 5;

export type ReviewScope = 'daily' | 'weekly';

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/**
 * The book as `concentration` wants it, from the tick that observed the close.
 *
 * `marketValue` is left UNDEFINED where the price is missing, never reconstructed from
 * `entryPrice`. `Position.marketValue` is optional in `IBroker` precisely so this case has
 * somewhere honest to go: `concentration` raises a caveat naming the affected symbols and
 * says the weights understate the book. A value invented from the entry price would instead
 * produce a confident weight for a position nobody can currently price — the same mistake as
 * averaging a real number with a blank.
 *
 * `stale` is deliberately not consulted. A stale price is a real, if old, market value, and a
 * second opinion on staleness belongs to `observe()`; what breaks a weight is having no
 * number at all.
 */
function bookOf(tick: TickData): Position[] {
  return Object.values(tick.positions).map((p) => ({
    symbol: p.symbol,
    qty: p.qty,
    avgCost: p.entryPrice,
    marketValue: p.price === null ? undefined : p.qty * p.price,
  }));
}

/**
 * Announce the shape of the book, once per session close.
 *
 * Returns what it published so the caller can route it — `[]` when today has already been
 * reviewed, and `[]` on any failure. Never throws: this runs on the same path as fill
 * reconciliation at the close, and a book summary is not worth costing the operator their
 * ledger.
 *
 * `now` is injectable so a replay can drive it at a virtual date.
 */
export function publishPortfolioReview(
  tick: TickData,
  policy: Policy,
  now: Date = new Date(),
): TriggerEvent[] {
  try {
    const today = etDate(now);
    const watermark = getState().lastPortfolioReviewAt;

    // Compared by ET DATE, not by value. The close is an event on the exchange's calendar, and
    // a raw ISO comparison would fire a second time for the same close the moment anything
    // re-entered this function with a later timestamp.
    //
    // An unreadable watermark is treated as never reviewed, and fails OPEN. `etDate` throws on
    // an invalid date, the catch below would log it and return `[]`, and the result would be a
    // review that is silent at every close forever with only a warn line to show for it. A
    // duplicate announcement is noise; a permanently missing one defeats the whole event.
    const watermarkMs = watermark === '' ? NaN : new Date(watermark).getTime();
    if (Number.isFinite(watermarkMs) && etDate(new Date(watermarkMs)) === today) return [];

    // NO adopt-on-first-run, unlike `review_ready`. That one adopts because a months-old fills
    // ledger would otherwise announce its whole backlog on the first start. There is no backlog
    // here — this describes the book as it stands — so adopting would silently skip the first
    // close and gain nothing at all for it.

    const scope: ReviewScope = etNow(now).day === FRIDAY ? 'weekly' : 'daily';
    const book = bookOf(tick);
    // `?? NaN` rather than `?? 0`: zero equity is a reading someone could act on, and an
    // unknown one is not. `concentration` treats both as uncomputable and says so in a caveat.
    const shape = concentration(book, tick.account.equity ?? NaN, getCachedSectors(Object.keys(tick.positions)));

    // The one thing in a book that is unambiguously wrong rather than a matter of judgement:
    // a position the machine is not watching a level for. Cheap to spot, and PLAYBOOK.md already
    // requires it fixed or exited in the cycle it is noticed.
    const unstopped = Object.values(tick.positions)
      .filter((p) => p.stopLevel === null)
      .map((p) => p.symbol)
      .sort();

    const evidence: Record<string, EvidenceValue> = {
      scope,
      closedAt: tick.tickAt,
      session: tick.session,
      positionCount: book.length,
      equity: tick.account.equity ?? 'unknown',
      dayPnLPct: tick.account.dayPnLPct === null ? 'unknown' : +tick.account.dayPnLPct.toFixed(2),
      grossDeployedPct: +shape.grossDeployedPct.toFixed(1),
      cashPct: +shape.cashPct.toFixed(1),
      maxWeightPct: +shape.maxWeightPct.toFixed(1),
      maxWeightSymbol: shape.maxWeightSymbol ?? 'none',
      hhi: +shape.hhi.toFixed(3),
      maxSectorWeightPct: +shape.maxSectorWeightPct.toFixed(1),
      maxSectorName: shape.maxSectorName ?? 'unknown',
      bySector: Object.fromEntries(
        Object.entries(shape.bySector).map(([name, b]) => [
          name,
          { symbols: b.symbols, weightPct: +b.weightPct.toFixed(1) },
        ]),
      ),
      positionsWithoutStop: unstopped,
      concentrationCaveats: shape.caveats,
      // Same convention as `review_ready`'s omittedNote: name the tool that reaches what is
      // absent, so a gap reads as a pointer rather than an invitation to fill it in.
      omittedNote:
        'Held-vs-held correlations and live sector lookups are not in here — get_exposure has them. What actually worked is not in here either — get_scorecard has that.',
    };

    // An empty book still fires, on purpose. "You have been flat all week" is exactly what a
    // portfolio review is for, and `concentration([])` returns a coherent reading of it.
    const headline =
      book.length === 0
        ? `${scope === 'weekly' ? 'Weekly' : 'Daily'} portfolio review — flat at the close, ${pct(shape.cashPct)} cash`
        : `${scope === 'weekly' ? 'Weekly' : 'Daily'} portfolio review — ${book.length} position(s), ${pct(shape.grossDeployedPct)} deployed, largest ${shape.maxWeightSymbol} at ${pct(shape.maxWeightPct)}, HHI ${shape.hhi.toFixed(2)}` +
          (unstopped.length > 0 ? `, ${unstopped.length} with NO STOP` : '');

    // `publishDiscrete`, not `processHits`: this is already an edge. There is no level to
    // recross, so arming and hysteresis are meaningless, and a cooldown entry per close would
    // grow `state.json` forever. The dedup is the watermark above, and it is ours to own.
    const event = publishDiscrete(
      'portfolio_review',
      {
        symbol: null, // the book, not a name
        cooldownKey: 'portfolio_review',
        severity: 'warn',
        headline,
        evidence,
        suggestedAction: 'reflect',
      },
      policy,
    );

    // AFTER publishing. A throw in between would lose the announcement permanently, where
    // re-announcing the same close is merely noisy.
    updateState({ lastPortfolioReviewAt: now.toISOString() });
    logger.info(`[ScheduledReview] ${scope} portfolio review published for ${today}`);

    return [event];
  } catch (err: any) {
    logger.warn(`[ScheduledReview] Skipped: ${err.message}`);
    return [];
  }
}
