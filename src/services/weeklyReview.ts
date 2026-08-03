import { DateTime, type WeekdayNumbers } from 'luxon'
import { composeWeeklyReview } from '../agent/review.js'
import { config, parseWeeklyReview, type WeeklyReviewSlot } from '../config.js'
import { log } from '../lib/log.js'
import type { Device } from './devices.js'
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
 * `2026-W31` in the device zone.
 *
 * weekYear as well as weekNumber, because ISO week 1 of a year routinely starts in December: on
 * 2026-12-28 the calendar year is 2026 and the week year is 2027, and keying on the calendar year
 * would collide that week with the one twelve months earlier.
 */
function weekKey(ms: number, zone: string): string {
  const dt = DateTime.fromMillis(ms, { zone })
  return `${dt.weekYear}-W${dt.weekNumber}`
}

function sameLocalWeek(a: number | null, b: number, zone: string): boolean {
  // null reads as "never sent", which must not count as the same week or the first review never runs.
  if (a === null) return false
  return weekKey(a, zone) === weekKey(b, zone)
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
  const waUserId = device.whatsappNumber
  if (!waUserId) {
    log.debug({ deviceId: device.deviceId }, 'weekly review: no WhatsApp number linked')
    return false
  }

  if (sameLocalWeek(getSettings(device.deviceId).lastWeeklyReviewAt, nowMillis, device.timezone)) {
    log.debug({ deviceId: device.deviceId }, 'weekly review: already sent this week')
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
    dedupeKey: `weekly:${device.deviceId}:${weekKey(nowMillis, device.timezone)}`,
    ttlMs: REVIEW_TTL_MS,
  })
  markWeeklyReviewSent(device.deviceId, nowMillis)
  return true
}
