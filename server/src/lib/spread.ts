import { createHash } from 'node:crypto'

/**
 * A deterministic fan-out for instants OTTO chose, so several of them do not land on one millisecond.
 *
 * Two instants in this system carry no per-item variation at all, and both are pile-ups the owner
 * experiences as a burst: the exclusive END of a quiet window, which `deferPastQuietHours` returns
 * with no spread at all, and the daily tail rung, which is the same `dayStartHour` for every ladder
 * that has run out of chases. Three reminders held overnight resolve to the identical instant, and
 * the scheduler fires all three inside one 15-second tick.
 *
 * The fix is an offset that is a pure function of the reminder's own id. That is the whole design
 * constraint, and it is why this is a hash rather than an allocator: the ladder recomputes a rung
 * from scratch every time it is re-entered, so anything that depended on the OTHER pending rungs
 * would reshuffle every reminder's instant the moment one of them was completed.
 */

/** How wide the fan is. Wide enough that a real backlog does not read as a burst; narrow enough
 * that everything released still lands unambiguously inside the owner's morning. From a noon day
 * start this ends at 15:00. */
export const MORNING_SPREAD_MS = 3 * 60 * 60 * 1000

/**
 * One slot every fifteen minutes across the span.
 *
 * Fifteen minutes is chosen against the two spacing constants either side of it: comfortably wider
 * than `minRungGapMs('relentless')` (3 minutes), so two DIFFERENT reminders read as two messages
 * rather than one stutter; and narrower than `MIN_RUNG_GAP_MS` (30 minutes), so two rungs of the
 * SAME reminder stay governed by `spacingFloor` and this never becomes the thing deciding them.
 */
export const SPREAD_BUCKETS = 12

/**
 * A stable offset into the span for one key. STRICTLY POSITIVE — never zero.
 *
 * That is load-bearing rather than tidy. The release edge, the day-start hour and the morning brief
 * all sit on the same instant for an owner whose quiet window ends when their day begins, so a
 * bucket of zero would put a released rung back on exactly the two instants this exists to clear.
 * Buckets are therefore 1..N, and the narrowest possible result is one whole bucket width.
 *
 * ELAPSED milliseconds, deliberately, against this repo's general rule of never adding fixed
 * millisecond offsets to an instant. The rule is about wall-clock TIMES — a "+9h" that must still
 * mean 07:00 after a DST change. This is a DURATION ("fan out across the next three hours"), and
 * the instant it is added to was itself computed as wall-clock, which is where the correctness
 * lives. A transition inside the span would make the fan 2h or 4h wide instead of 3h, which is
 * harmless, and for any day start after 03:00 it cannot happen at all.
 *
 * Whole minutes, so results stay on the minute the way `nextLocalTimeAt` produces them and a test
 * assertion reads as a clock time rather than a millisecond count.
 */
export function spreadOffsetMs(
  key: string,
  spanMs: number = MORNING_SPREAD_MS,
  buckets: number = SPREAD_BUCKETS,
): number {
  const digest = createHash('sha256').update(key).digest()
  const n = digest.readUInt32BE(0)
  const bucket = (n % buckets) + 1
  const width = Math.round(spanMs / buckets / 60_000) * 60_000
  return bucket * width
}
