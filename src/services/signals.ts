import { and, eq, gte, sql } from 'drizzle-orm'
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

export type OwnerRecord = {
  alarmsRang: number
  alarmsSnoozed: number
  snoozeTotal: number
  alarmsMissed: number
  remindersFinished: number
  remindersDropped: number
  remindersOpen: number
  longestOpen: { title: string; days: number; chased: number; moved: number } | null
}

function scalar(query: { get: () => { n: number } | undefined }): number {
  return query.get()?.n ?? 0
}

/** Count alarm_events of one kind for a device inside the window. */
function events(deviceId: string, event: string, since: number, distinctAlarms = false): number {
  return scalar(
    db
      .select({ n: distinctAlarms ? sql<number>`count(distinct ${alarmEvents.alarmId})` : sql<number>`count(*)` })
      .from(alarmEvents)
      .where(and(eq(alarmEvents.deviceId, deviceId), eq(alarmEvents.event, event), gte(alarmEvents.atMillis, since))),
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
      .where(and(eq(reminders.deviceId, deviceId), gte(reminders.completedAtMillis, since))),
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
  const nothing =
    r.alarmsRang === 0 && r.snoozeTotal === 0 && r.remindersFinished === 0 && r.remindersDropped === 0 && r.remindersOpen === 0
  if (nothing) {
    return 'The record (last 14 days): nothing on file yet. You have no history to hold against them, so do not imply you do.'
  }

  const lines: string[] = []

  if (r.alarmsRang > 0 || r.snoozeTotal > 0 || r.alarmsMissed > 0) {
    const parts = [`${r.alarmsRang} rang`]
    if (r.snoozeTotal > 0) parts.push(`${r.alarmsSnoozed} of them snoozed, ${r.snoozeTotal} snoozes in total`)
    if (r.alarmsMissed > 0) parts.push(`${r.alarmsMissed} slept through entirely`)
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
 * The parenthetical shown after a reminder title, e.g. `today 18:00, OVERDUE, chased 4×, moved 3×`.
 *
 * Shared by the prompt's chase-list and the nudge writer so the two can never disagree about what
 * Otto is entitled to say about a given reminder.
 */
export function reminderEvidence(
  r: { dueAtMillis: number | null; nagCount: number; deferCount: number },
  zone: string,
  nowMillis: number = Date.now(),
): string {
  const parts = [r.dueAtMillis === null ? 'no date' : epochMillisToLocalHuman(r.dueAtMillis, zone)]
  if (r.dueAtMillis !== null && r.dueAtMillis < nowMillis) parts.push('OVERDUE')
  if (r.nagCount > 0) parts.push(`chased ${r.nagCount}×`)
  if (r.deferCount > 0) parts.push(`moved ${r.deferCount}×`)
  return parts.join(', ')
}
