import { DateTime, type WeekdayNumbers } from 'luxon'
import { composeWeeklyReview } from '../agent/review.js'
import { config, parseWeeklyReview, type WeeklyReviewSlot } from '../config.js'
import { log } from '../lib/log.js'
import type { Device } from './devices.js'
import { cancelJobsForDevice, ensureSingletonJob } from './jobs.js'
import { enqueueAndTryFlush } from './outbox.js'
import { getSettings, markWeeklyReviewSent } from './settings.js'
import { isWorthSaying, weeklyRecord } from './signals.js'

/**
 * The Sunday-evening review: what happened, and at most two patterns.
 *
 * Every guard below is a SILENCE rule rather than an error path. This message is unprompted and
 * weekly, which means the failure mode that actually kills it is not crashing — it is arriving
 * when it has nothing to say, or arriving on Tuesday. Either one teaches the owner to skim past it,
 * and after that the reviews that do matter are unread too.
 */

/** Sunday's review must never turn up on Tuesday. Later than this and the week has moved on. */
const LATE_GRACE_MS = 12 * 60 * 60 * 1000

/** Long enough to survive a shut 24h window overnight, short enough to still be "this week". */
const REVIEW_TTL_MS = 36 * 60 * 60 * 1000

/**
 * The device's review slot: its column, else the server default.
 *
 * Same shape as `quietHoursFor`, and for the same reason — the fallback is keyed on the column
 * being ABSENT, not on the parse returning null, so an explicit "off" is honoured as off rather
 * than silently reinstating the default.
 */
export function weeklyReviewSlot(device: Device): WeeklyReviewSlot {
  const column = getSettings(device.deviceId).weeklyReviewAt
  if (column === null) return parseWeeklyReview(config.weeklyReviewDefault)
  return parseWeeklyReview(column)
}

/**
 * The next slot instant, strictly after `nowMillis`, or null when reviews are off.
 *
 * Wall-clock in the device zone via luxon (`set({ weekday })` lands inside the current ISO week),
 * never "+7 days" from a UTC instant — otherwise an 18:00 review drifts to 17:00 or 19:00 for half
 * the year.
 */
export function nextWeeklyReviewAt(device: Device, nowMillis: number): number | null {
  const slot = weeklyReviewSlot(device)
  if (slot === null) return null
  const from = DateTime.fromMillis(nowMillis, { zone: device.timezone })
  // `parseWeeklyReview` only ever yields 1–7 (it indexes a seven-name table), which is exactly
  // luxon's WeekdayNumbers — the cast just tells the compiler what the parser already guarantees.
  let target = from.set({
    weekday: slot.weekday as WeekdayNumbers,
    hour: slot.hour,
    minute: slot.minute,
    second: 0,
    millisecond: 0,
  })
  // `<=` not `<`: a review that ran exactly on its own boundary must not re-fire immediately.
  if (target <= from) target = target.plus({ weeks: 1 })
  return target.toMillis()
}

/**
 * How recently a review must have gone out before another one counts as a duplicate.
 *
 * Deliberately a COOLDOWN and not the ISO week number, which is what this used to be. The slot
 * defaults to SUN:18:00 but an ISO week rolls at Monday 00:00 — six hours later — while
 * `LATE_GRACE_MS` is twelve. That left a six-hour hole in which a re-run passed both gates: the
 * review goes out Sunday 18:00, the process is SIGKILLed between `markWeeklyReviewSent` and the
 * scheduler's `rescheduleJob`, the machine comes back at Monday 01:00, and the still-due job
 * delivers a second identical review because "different week". Keying on the ISO week put the
 * dedupe boundary somewhere the slot has no relationship to.
 *
 * Six days rather than seven because the legitimate gap between consecutive reviews is not exactly
 * a week: a wall-clock Sunday-to-Sunday hop is seven days minus an hour across a spring-forward,
 * and either end may have been delivered up to `LATE_GRACE_MS` late, so the worst honest gap is
 * about 6d 11h. Six days clears that and still catches a same-evening replay ten times over. It
 * also matches what the review actually IS: `weeklyRecord` looks back exactly seven days, so two
 * reviews closer together than that report overlapping evidence.
 *
 * A consequence worth naming: an owner who moves their slot from Sunday to Wednesday gets their
 * first Wednesday review the FOLLOWING Wednesday, not two days later. That is the right trade —
 * one week's evidence, reported once.
 */
const REVIEW_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000

/**
 * Has a review already gone out for this stretch of evidence?
 *
 * `null` reads as "never sent" and must not suppress, or the first review never runs. A `lastAt`
 * in the FUTURE (clock skew, a restored backup) reads as recent and suppresses — for an unprompted
 * weekly message, staying quiet is the safe side of that judgement.
 */
function sentRecently(lastAt: number | null, nowMillis: number): boolean {
  if (lastAt === null) return false
  return nowMillis - lastAt < REVIEW_COOLDOWN_MS
}

/**
 * Run one review for a device. Returns whether anything was queued.
 *
 * `scheduledAtMillis` is the job's own run time rather than "now", so lateness is measured against
 * when the review was SUPPOSED to go out — a backlog drained after two days of downtime is silently
 * dropped instead of arriving as a Sunday review on Tuesday evening.
 */
export async function deliverWeeklyReview(
  device: Device,
  scheduledAtMillis: number,
  nowMillis: number = Date.now(),
): Promise<boolean> {
  // Are reviews still ON? Read live, at delivery, not trusted from whenever the job row was written.
  //
  // The brief has had this gate from the start (`runBrief` bails on `slotForRunAt` returning null)
  // and this one did not, which made "drop the weekly thing" a lie for up to a week: `setPreferences`
  // wrote 'off', handed back `weeklyReview: 'off'` for Otto to confirm, and the already-queued job
  // row delivered one more review anyway — the only thing that ever cancelled it was `seedWeeklyReview`,
  // reachable at boot and from a gc pass up to six hours away. The chain is now moved eagerly (see
  // `rescheduleWeeklyReviewChain`); this is the backstop for a row that is already in flight.
  if (weeklyReviewSlot(device) === null) {
    log.info({ deviceId: device.deviceId }, 'weekly review: switched off since this run was scheduled; staying quiet')
    return false
  }

  const waUserId = device.whatsappNumber
  if (!waUserId) {
    log.debug({ deviceId: device.deviceId }, 'weekly review: no WhatsApp number linked')
    return false
  }

  if (sentRecently(getSettings(device.deviceId).lastWeeklyReviewAt, nowMillis)) {
    log.debug({ deviceId: device.deviceId }, 'weekly review: one already went out recently')
    return false
  }

  if (nowMillis - scheduledAtMillis > LATE_GRACE_MS) {
    log.warn({ deviceId: device.deviceId, lateBy: nowMillis - scheduledAtMillis }, 'weekly review: too late to send')
    return false
  }

  const record = weeklyRecord(device.deviceId, nowMillis)
  if (!isWorthSaying(record)) {
    log.info({ deviceId: device.deviceId }, 'weekly review: nothing happened this week; staying quiet')
    return false
  }

  const body = await composeWeeklyReview(record, device.timezone)
  await enqueueAndTryFlush({
    waUserId,
    deviceId: device.deviceId,
    kind: 'weekly',
    body,
    // The SLOT this delivery is for, not the week it happens to land in — a replay of the same job
    // row carries the same `runAtMillis`, so the outbox's unique index backs up the cooldown above
    // instead of rolling over at Monday 00:00 exactly when the replay is most likely.
    dedupeKey: `weekly:${device.deviceId}:${scheduledAtMillis}`,
    ttlMs: REVIEW_TTL_MS,
  })
  markWeeklyReviewSent(device.deviceId, nowMillis)
  return true
}

/**
 * Move the chain NOW, because the owner just changed (or cleared) their review slot.
 *
 * The peer of `brief.rescheduleBriefChain`, and missing until now for no better reason than that the
 * two features were built on different branches and `preferences.ts` is the file neither could see
 * the other in. It fixes both directions of the same hole: switching reviews OFF left a pending row
 * to fire once more, and switching them back ON seeded nothing until the next gc pass — up to six
 * hours later, by which point `nextWeeklyReviewAt` could only offer the FOLLOWING week.
 *
 * Cancel-then-ensure with no await between them, exactly like the brief: better-sqlite3 is
 * synchronous, so a tick cannot land in the middle, and a `settle` racing the delete updates an id
 * that no longer exists.
 */
export function rescheduleWeeklyReviewChain(device: Device, nowMillis: number = Date.now()): void {
  cancelJobsForDevice('weekly_review', device.deviceId)
  const at = nextWeeklyReviewAt(device, nowMillis)
  if (at === null) return
  ensureSingletonJob('weekly_review', at, { deviceId: device.deviceId })
}
