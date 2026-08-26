import { log } from '../lib/log.js'
import type { Device } from './devices.js'
import { hasGoogle, tryListCalendarEvents, type CalendarEvent } from './google.js'
import { eventEndMillis, eventStartMillis, localIsoOf, overlapsWindow } from './leaveBy.js'

/**
 * Is the owner in the middle of something with other people in it?
 *
 * Quiet hours are a clock. This is their calendar, and it is the only thing in the system that
 * reads one to decide whether Otto may speak. The rule it serves is deliberately harder than quiet
 * hours: inside a commitment Otto says nothing at all, and what he would have said is DROPPED
 * rather than queued, because a meeting you walk out of to a burst of six saved-up nudges is the
 * same interruption arriving late.
 *
 * READ LIVE, never cached, and that is the load-bearing decision here. Every caller
 * (`flushOutbox`, `sweepOutbox`, `runNudge`, `runWakeCheck`) is already async and already running
 * in a job handler where nobody is waiting, so the cost is one narrow calendar read at the moment
 * of the decision. A cached window would need a refresh cadence, a too-stale-to-trust rule, and a
 * story for the hole between back-to-back meetings — three new ways to be wrong about something
 * every use point can simply ask.
 *
 * It is NOT wired into `lib/nagLadder.ts`. That module schedules; it does not interrupt. Feeding it
 * a calendar would make the `nagCount` -> rung mapping a function of when Google was last polled,
 * which is exactly the guarantee `lib/rungPlan.ts` says must not move under the ladder.
 */
export type Commitment = {
  summary: string
  startMillis: number
  endMillis: number
}

/**
 * Titles that mean "this is a thing I have to be at" even with nothing else on the entry.
 *
 * DELIBERATELY INCOMPLETE, and it will always be slightly wrong. It exists for one shape the other
 * three tests cannot catch: a bare `Dinner` block the owner typed into their own calendar, with no
 * attendees and no location. Without it the rule would miss the example that prompted the whole
 * feature. Matched on a word boundary so "classic" is not a class and "recall" is not a call.
 */
export const COMMITMENT_WORDS: readonly string[] = [
  'dinner',
  'lunch',
  'brunch',
  'breakfast',
  'drinks',
  'appointment',
  'interview',
  'meeting',
  'standup',
  'dentist',
  'doctor',
  'gp',
  'class',
  'lesson',
  'session',
  'viewing',
  'consultation',
]

const COMMITMENT_WORD_SET = new Set(COMMITMENT_WORDS)

/**
 * Whole words only, by splitting rather than by an alternation with word boundaries.
 *
 * A substring test would read "Classic car auction" as a class and "Recall the old build" as a
 * call, and a wrongly-protected event is invisible: Otto simply goes quiet and nothing errors.
 */
function titleNamesCommitment(summary: string): boolean {
  return summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => COMMITMENT_WORD_SET.has(word))
}

/**
 * Past this, an entry has stopped being a meeting and become a day.
 *
 * A timed 09:00-18:00 "Conference" with a location would otherwise silence Otto for nine hours,
 * push every rung to 18:00, and drop the morning brief — which `markBriefSent` records as sent
 * regardless, so it never retries. A day Otto cannot speak on is a day his reminders quietly die,
 * and that is a worse failure than one nudge arriving in hour five of a conference.
 */
export const MAX_COMMITMENT_MS = 4 * 60 * 60 * 1000

/**
 * Does this event mean the owner is unavailable, as opposed to merely busy on their own?
 *
 * Four tests, any of which is enough. The owner chose this shape over "every timed event" because
 * that one silences their own gym and deep-work blocks, and over "attendees only" because a dinner
 * booked into a calendar usually has nobody on it.
 *
 * `attendeeCount` INCLUDES the owner, so `>= 2` is "one other person".
 *
 * The `attendeeCount >= 1` guard on the organiser test is load-bearing. `toCalendarEvent` writes
 * `organizerSelf: e.organizer?.self === true`, so an event Google returned with no `organizer`
 * field at all reads as `false` — and without the guard every one of those, including every test
 * fixture that omits it, would be somebody else's meeting.
 *
 * A video-call link in `location` counts, and that is intended: a Zoom call is a commitment. Google's
 * own generated entries are not — birthdays, out-of-office and focus time are excluded by
 * `eventType`, the same test `agent/tools/calendarEdits.ts` makes before it will edit anything.
 */
export function isProtectedEvent(e: CalendarEvent): boolean {
  if (e.isAllDay || e.status === 'cancelled') return false
  // DECLINED is the owner saying, in the calendar's own vocabulary, that they will not be there.
  // Every test below is a guess at whether they are busy; this is the one place they have answered
  // the question directly, and it was not being read — so an invitation they had turned down still
  // silenced Otto for its whole hour, and dropped whatever he would have said.
  if (e.selfResponse === 'declined') return false
  if (e.eventType !== null && e.eventType !== 'default') return false
  if (e.attendeeCount >= 2) return true
  if (e.attendeeCount >= 1 && !e.organizerSelf) return true
  if (e.location !== null && e.location.trim() !== '') return true
  return titleNamesCommitment(e.summary)
}

/**
 * The commitment covering `atMillis`, or null.
 *
 * FAILS OPEN. `tryListCalendarEvents` returns null for an unreachable calendar or a revoked grant,
 * and this returns null in turn — Otto speaks. That is this codebase's settled posture (see
 * `handlers/leaveBy.ts`: an outage never cancels an alarm), and the alternative is an assistant
 * that goes permanently silent the day a refresh token expires, which is the worse failure.
 *
 * The probe is one minute wide because Google's `timeMin`/`timeMax` are an OVERLAP filter, not a
 * containment one: it returns every event whose span crosses the window, however early it began. So
 * no lookback is needed, and a window this narrow cannot fill the un-paginated 50-row page. The
 * exact answer is then decided locally by `overlapsWindow`, which is closed at the start and open
 * at the end — 14:00 is inside a 14:00-15:00 meeting, 15:00 is not.
 */
export async function commitmentAt(device: Device, atMillis: number): Promise<Commitment | null> {
  if (!hasGoogle(device.deviceId)) return null
  const zone = device.timezone
  const events = await tryListCalendarEvents(
    device.deviceId,
    localIsoOf(atMillis, zone),
    localIsoOf(atMillis + 60_000, zone),
  )
  if (events === null) {
    log.warn({ deviceId: device.deviceId }, 'commitments: calendar unreachable; not holding anything back')
    return null
  }
  for (const e of events) {
    if (!isProtectedEvent(e)) continue
    if (!overlapsWindow(e, atMillis, atMillis + 1, zone)) continue
    const startMillis = eventStartMillis(e, zone)
    const endMillis = eventEndMillis(e, zone)
    if (startMillis === null || endMillis === null) continue
    if (endMillis - startMillis > MAX_COMMITMENT_MS) {
      log.debug({ deviceId: device.deviceId, summary: e.summary }, 'commitments: too long to be a meeting; ignoring')
      continue
    }
    return { summary: e.summary, startMillis, endMillis }
  }
  return null
}

/**
 * The one sentence the post-event check-in sends.
 *
 * Deterministic, like `nudgeTextFor` — this fires from a scheduler on a machine that may have no
 * working model credentials, and it has to be answerable in one word.
 *
 * It ASKS. It used to announce that the reminder had been marked done, and nothing in that path
 * consulted the timing kind while `createReminder` defaults every dated reminder to `deadline` — so
 * "send the invoice by 16:00" plus a 16:00 meeting closed the invoice and invited the owner to
 * correct it. Being in a meeting when something was due is evidence it did not get done. The
 * question costs the same single message, cannot be wrong, and leaves the reminder open so silence
 * keeps the ladder running rather than ending it.
 */
export function attendedCheckInText(title: string, commitmentSummary: string): string {
  return `You were at ${commitmentSummary} when "${title}" was due — did that get done?`
}
