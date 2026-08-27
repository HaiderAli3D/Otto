import { and, desc, eq, gte, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { alarmEvents, reminders } from '../db/schema.js'
import { epochMillisToLocalHuman } from './time.js'

/**
 * The evidence Otto is allowed to be blunt about.
 *
 * The persona tells him his sharpness is a function of the record rather than his mood; this module
 * is that record. It exists so "fourth move" is a fact read out of SQLite instead of a flourish the
 * model invented — a coach who bluffs gets ignored, and a coach who invents a history the owner
 * knows is wrong gets switched off.
 *
 * Everything here is rendered into the VOLATILE tail of the system prompt, after the cache
 * breakpoint (see agent/prompt.ts). That placement is deliberate: these numbers change constantly,
 * and in front of the breakpoint they would invalidate the cached prefix on every single request.
 */

/** Long enough to show a habit, short enough to forgive one bad week. */
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** The weekly review's window. Strictly seven days, half-open, so two reviews never double-count. */
const WEEK_MS = 7 * DAY_MS

export type OwnerRecord = {
  alarmsRang: number
  alarmsSnoozed: number
  snoozeTotal: number
  alarmsMissed: number
  /** Dismissed the alarm and then went back to sleep — a wake-check that ran out of rounds. */
  sleptThroughAfterDismiss: number
  remindersFinished: number
  remindersDropped: number
  remindersOpen: number
  longestOpen: { title: string; days: number; chased: number; moved: number } | null
}

/**
 * Completions Otto actually witnessed, as opposed to ones he assumed.
 *
 * KEPT FOR THE ROWS THAT PREDATE THE REVERSAL, and that is now the whole of its job. Otto used to
 * CLOSE a reminder whose due rung fell inside a meeting, writing `assumedAttendedAtMillis` to the
 * same instant as `completedAtMillis` — equality being the tell. He no longer does: he asks, the
 * reminder stays OPEN, and `assumedAttendedAtMillis` records when the QUESTION was put. So for
 * anything written since, the two columns can never be equal and this guard always passes, which is
 * correct — every completion now is one the owner reported.
 *
 * Do not delete it on that basis. Rows closed on an assumption before the reversal still carry the
 * equal pair, and counting them would retroactively inflate the record they were excluded from.
 *
 * This is here rather than in the caller because THE_RECORD tells the model these numbers are the
 * whole of its evidence and to never round them up. "You finished twelve things this week" when
 * five of them were guesses is exactly the bluff the persona forbids.
 */
function notAssumed() {
  return or(
    isNull(reminders.assumedAttendedAtMillis),
    ne(reminders.assumedAttendedAtMillis, reminders.completedAtMillis),
  )
}

function scalar(query: { get: () => { n: number } | undefined }): number {
  return query.get()?.n ?? 0
}

/**
 * Count alarm_events of one kind for a device inside the window.
 *
 * `until` is optional so `ownerRecord` keeps its open-ended "since" semantics untouched while
 * `weeklyRecord` gets the strict half-open week it needs. Private, so widening it is not an API
 * change for anyone.
 */
function events(deviceId: string, event: string, since: number, distinctAlarms = false, until?: number): number {
  return scalar(
    db
      .select({ n: distinctAlarms ? sql<number>`count(distinct ${alarmEvents.alarmId})` : sql<number>`count(*)` })
      .from(alarmEvents)
      .where(
        and(
          eq(alarmEvents.deviceId, deviceId),
          eq(alarmEvents.event, event),
          gte(alarmEvents.atMillis, since),
          until === undefined ? undefined : lt(alarmEvents.atMillis, until),
        ),
      ),
  )
}

export function ownerRecord(deviceId: string, nowMillis: number = Date.now()): OwnerRecord {
  const since = nowMillis - WINDOW_MS

  // A recurring reminder rolls back to OPEN after each occurrence but keeps completedAtMillis, so
  // completions are counted off that timestamp rather than off state — otherwise every recurring
  // finish would be invisible here.
  const remindersFinished = scalar(
    db
      .select({ n: sql<number>`count(*)` })
      .from(reminders)
      .where(and(eq(reminders.deviceId, deviceId), gte(reminders.completedAtMillis, since), notAssumed())),
  )

  const remindersDropped = scalar(
    db
      .select({ n: sql<number>`count(*)` })
      .from(reminders)
      .where(and(eq(reminders.deviceId, deviceId), eq(reminders.state, 'CANCELLED'), gte(reminders.updatedAt, since))),
  )

  const open = db
    .select()
    .from(reminders)
    .where(and(eq(reminders.deviceId, deviceId), eq(reminders.state, 'OPEN')))
    .all()

  const oldest = open.reduce<(typeof open)[number] | null>((acc, r) => (!acc || r.createdAt < acc.createdAt ? r : acc), null)

  return {
    alarmsRang: events(deviceId, 'RANG', since),
    alarmsSnoozed: events(deviceId, 'SNOOZED', since, true),
    snoozeTotal: events(deviceId, 'SNOOZED', since),
    alarmsMissed: events(deviceId, 'MISSED', since),
    sleptThroughAfterDismiss: events(deviceId, 'WAKE_CHECK_FAILED', since),
    remindersFinished,
    remindersDropped,
    remindersOpen: open.length,
    longestOpen: oldest
      ? {
          title: oldest.title,
          days: Math.floor((nowMillis - oldest.createdAt) / DAY_MS),
          chased: oldest.nagCount,
          moved: oldest.deferCount,
        }
      : null,
  }
}

/**
 * The record as prompt text.
 *
 * When there is nothing on file this says so explicitly rather than rendering a wall of zeroes.
 * A fresh install otherwise reads as "0 finished, 0 open" — which a coach primed to keep score can
 * easily turn into an accusation about a history that does not exist.
 */
export function renderRecord(deviceId: string, nowMillis: number = Date.now()): string {
  const r = ownerRecord(deviceId, nowMillis)
  // `sleptThroughAfterDismiss` belongs in this predicate, not just in the line below: a device whose
  // only signal is a failed wake-check would otherwise render "nothing on file yet" — which forbids
  // Otto from mentioning the thing he watched happen an hour ago.
  const nothing =
    r.alarmsRang === 0 &&
    r.snoozeTotal === 0 &&
    r.sleptThroughAfterDismiss === 0 &&
    r.remindersFinished === 0 &&
    r.remindersDropped === 0 &&
    r.remindersOpen === 0
  if (nothing) {
    return 'The record (last 14 days): nothing on file yet. You have no history to hold against them, so do not imply you do.'
  }

  const lines: string[] = []

  if (r.alarmsRang > 0 || r.snoozeTotal > 0 || r.alarmsMissed > 0 || r.sleptThroughAfterDismiss > 0) {
    const parts = [`${r.alarmsRang} rang`]
    if (r.snoozeTotal > 0) parts.push(`${r.alarmsSnoozed} of them snoozed, ${r.snoozeTotal} snoozes in total`)
    if (r.alarmsMissed > 0) parts.push(`${r.alarmsMissed} slept through entirely`)
    if (r.sleptThroughAfterDismiss > 0) {
      parts.push(`dismissed and went back to sleep ${r.sleptThroughAfterDismiss}×`)
    }
    lines.push(`- Alarms: ${parts.join('; ')}.`)
  }

  lines.push(`- Reminders: ${r.remindersFinished} finished, ${r.remindersDropped} dropped, ${r.remindersOpen} still open.`)

  if (r.longestOpen && r.longestOpen.days >= 1) {
    const o = r.longestOpen
    const detail = [`${o.days} day${o.days === 1 ? '' : 's'} old`]
    if (o.chased > 0) detail.push(`chased ${o.chased}×`)
    if (o.moved > 0) detail.push(`moved ${o.moved}×`)
    lines.push(`- Oldest open item: "${o.title}" — ${detail.join(', ')}.`)
  }

  return `The record (last 14 days):\n${lines.join('\n')}`
}

/**
 * One week of evidence, for the Sunday review.
 *
 * Deliberately NOT `ownerRecord` with a different constant. That one's 14-day window and its
 * unwindowed `remindersOpen` are load-bearing for the conversational prompt (and pinned by a dozen
 * tests), and a review needs a different shape anyway: titles for texture, and the specific items
 * that are slipping.
 */
export type WeeklyRecord = {
  finished: number
  dropped: number
  created: number
  /** Open RIGHT NOW, not "open at the end of the week" — the review is read in the present tense. */
  stillOpen: number
  alarmsRang: number
  alarmsSnoozed: number
  snoozeTotal: number
  alarmsMissed: number
  wakeChecksFailed: number
  /** Up to five, newest first. Texture for the model, so the review is not four bare numbers. */
  finishedTitles: string[]
  /** Up to three items that keep moving without getting done. */
  slippers: Array<{ title: string; moved: number; chased: number }>
}

/** A reminder has to have been pushed back or chased this hard before it counts as slipping. */
const SLIPPING_MOVES = 2
const SLIPPING_CHASES = 3

export function weeklyRecord(deviceId: string, nowMillis: number = Date.now()): WeeklyRecord {
  const since = nowMillis - WEEK_MS
  const until = nowMillis

  const finishedRows = db
    .select()
    .from(reminders)
    .where(
      and(
        eq(reminders.deviceId, deviceId),
        gte(reminders.completedAtMillis, since),
        lt(reminders.completedAtMillis, until),
        notAssumed(),
      ),
    )
    .orderBy(desc(reminders.completedAtMillis))
    .all()

  const dropped = scalar(
    db
      .select({ n: sql<number>`count(*)` })
      .from(reminders)
      .where(
        and(
          eq(reminders.deviceId, deviceId),
          eq(reminders.state, 'CANCELLED'),
          gte(reminders.updatedAt, since),
          lt(reminders.updatedAt, until),
        ),
      ),
  )

  const created = scalar(
    db
      .select({ n: sql<number>`count(*)` })
      .from(reminders)
      .where(and(eq(reminders.deviceId, deviceId), gte(reminders.createdAt, since), lt(reminders.createdAt, until))),
  )

  const open = db
    .select()
    .from(reminders)
    .where(and(eq(reminders.deviceId, deviceId), eq(reminders.state, 'OPEN')))
    .all()

  // Filtering on state='OPEN' is what STRUCTURALLY enforces the persona's "never raise a pattern
  // they have already fixed": a reminder that was slipping all week and then got done simply cannot
  // appear in this list. That rule is not delegated to the model — a review is unprompted, so the
  // one thing guaranteed to make the owner stop reading it is being told off for something they
  // already sorted. Being unable to say it is stronger than being told not to.
  // The two arms are not symmetric, and undated reminders are what makes that show.
  //
  // Being MOVED is the owner's own doing, and it counts whether or not the thing has a date —
  // "later, later, later" about the loft is exactly what this list is for. Being CHASED is Otto's
  // doing, and for an undated reminder it is automatic: one every morning, so it crosses
  // SLIPPING_CHASES inside three days and would then sit in the top three for good, crowding out
  // the dated things that genuinely are sliding. "Chased fourteen times about the loft" is true and
  // useless — the fourteen is the ladder's number, not the owner's.
  const slippers = open
    .filter((r) => r.deferCount >= SLIPPING_MOVES || (r.dueAtMillis !== null && r.nagCount >= SLIPPING_CHASES))
    .sort((a, b) => b.deferCount - a.deferCount || b.nagCount - a.nagCount)
    .slice(0, 3)
    .map((r) => ({ title: r.title, moved: r.deferCount, chased: r.nagCount }))

  return {
    finished: finishedRows.length,
    dropped,
    created,
    stillOpen: open.length,
    alarmsRang: events(deviceId, 'RANG', since, false, until),
    alarmsSnoozed: events(deviceId, 'SNOOZED', since, true, until),
    snoozeTotal: events(deviceId, 'SNOOZED', since, false, until),
    alarmsMissed: events(deviceId, 'MISSED', since, false, until),
    wakeChecksFailed: events(deviceId, 'WAKE_CHECK_FAILED', since, false, until),
    finishedTitles: finishedRows.slice(0, 5).map((r) => r.title),
    slippers,
  }
}

/**
 * Is there anything in this week worth interrupting them for?
 *
 * A review of a week in which nothing happened is the fastest possible way to teach the owner that
 * the Sunday message is noise, and once they have learned that they stop reading the ones that
 * matter. `stillOpen` alone is deliberately NOT enough: a standing list they have not touched is
 * not news. Something has to have moved, or something has to be visibly stuck.
 */
export function isWorthSaying(r: WeeklyRecord): boolean {
  return (
    r.finished > 0 ||
    r.dropped > 0 ||
    r.created > 0 ||
    r.alarmsRang > 0 ||
    r.snoozeTotal > 0 ||
    r.alarmsMissed > 0 ||
    r.wakeChecksFailed > 0 ||
    r.slippers.length > 0
  )
}

/**
 * The parenthetical shown after a reminder title, e.g.
 * `today 18:00, OVERDUE, chased 4× since it was due, moved 3×`.
 *
 * Shared by the prompt's chase-list and the nudge writer so the two can never disagree about what
 * Otto is entitled to say about a given reminder.
 *
 * `leadCount` splits `nagCount` into warnings and chases, and getting this wrong is worse than
 * leaving it out. A deadline warns several times in the run-up, so a reminder that is not due for
 * another three days can already have a `nagCount` of five — rendered as "chased 5×" the persona
 * reads that as licence to be uncomfortable about something nobody is late for yet. "Warned 4×
 * beforehand and they still hadn't started" is both true and stronger, and it is a sentence Otto
 * could not say at all before.
 */
export function reminderEvidence(
  r: { dueAtMillis: number | null; nagCount: number; deferCount: number },
  zone: string,
  nowMillis: number = Date.now(),
  leadCount = 0,
): string {
  const parts = [r.dueAtMillis === null ? 'no date' : epochMillisToLocalHuman(r.dueAtMillis, zone)]
  if (r.dueAtMillis !== null && r.dueAtMillis < nowMillis) parts.push('OVERDUE')
  const warned = Math.min(r.nagCount, leadCount)
  const chased = Math.max(0, r.nagCount - leadCount)
  if (warned > 0) parts.push(`warned ${warned}× beforehand`)
  if (chased > 0) parts.push(leadCount > 0 ? `chased ${chased}× since it was due` : `chased ${chased}×`)
  if (r.deferCount > 0) parts.push(`moved ${r.deferCount}×`)
  return parts.join(', ')
}
