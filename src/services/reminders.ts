import { and, asc, eq, isNotNull, lte, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { reminders } from '../db/schema.js'
import { newAlarmId, newReminderId } from '../lib/ids.js'
import { nextNagAt, type NagPolicy } from '../lib/nagLadder.js'
import { log } from '../lib/log.js'
import { armAlarm, cancelAlarm } from './alarms.js'
import type { Device } from './devices.js'
import { cancelNudges, enqueueJob } from './jobs.js'
import { nextOccurrence } from './recurrence.js'

export type Reminder = typeof reminders.$inferSelect

export function getReminder(reminderId: string): Reminder | undefined {
  return db.select().from(reminders).where(eq(reminders.reminderId, reminderId)).get()
}

export function listReminders(
  deviceId: string,
  opts: { state?: 'open' | 'done' | 'all'; overdueOnly?: boolean } = {},
): Reminder[] {
  const state = opts.state ?? 'open'
  const rows = db
    .select()
    .from(reminders)
    .where(
      state === 'all'
        ? eq(reminders.deviceId, deviceId)
        : and(eq(reminders.deviceId, deviceId), eq(reminders.state, state === 'open' ? 'OPEN' : 'DONE')),
    )
    .orderBy(asc(reminders.dueAtMillis))
    .all()
  if (!opts.overdueOnly) return rows
  const now = Date.now()
  return rows.filter((r) => r.dueAtMillis !== null && r.dueAtMillis <= now)
}

/** Every OPEN reminder whose next nudge is due — the scheduler's work list. */
export function dueNags(nowMillis: number): Reminder[] {
  return db
    .select()
    .from(reminders)
    .where(
      and(eq(reminders.state, 'OPEN'), isNotNull(reminders.nextNagAtMillis), lte(reminders.nextNagAtMillis, nowMillis)),
    )
    .orderBy(asc(reminders.nextNagAtMillis))
    .all()
}

/**
 * Create a reminder, schedule its first nudge, and optionally arm a ringing alarm for the due time.
 *
 * The alarm is ALWAYS armed with `recurrence: null` even for a recurring reminder. The reminder
 * owns the recurrence. This is what stops `advanceRecurrence` — which fires on any DISMISSED or
 * MISSED event — from silently rolling a nagging series forward when the owner just swipes the
 * ring away. With no rule on the alarm it hits its existing guard and no-ops.
 */
export async function createReminder(
  device: Device,
  params: {
    title: string
    detail?: string | null
    dueAtMillis?: number | null
    recurrence?: string | null
    nagPolicy?: NagPolicy
    ring?: boolean
    escalateWithAlarm?: boolean
    waUserId?: string | null
  },
): Promise<Reminder> {
  const now = Date.now()
  const reminderId = newReminderId()
  const dueAtMillis = params.dueAtMillis ?? null
  const nagPolicy = params.nagPolicy ?? 'gentle'

  let alarmId: string | null = null
  if (params.ring && dueAtMillis !== null) {
    alarmId = newAlarmId()
    await armAlarm(device, {
      alarmId,
      triggerAtMillis: dueAtMillis,
      label: params.title,
      recurrence: null, // deliberate — see the doc comment above
    })
  }

  const firstNag = nextNagAt({ policy: nagPolicy, nagCount: 0, dueAtMillis, zone: device.timezone, nowMillis: now })

  const row: Reminder = {
    reminderId,
    deviceId: device.deviceId,
    waUserId: params.waUserId ?? device.whatsappNumber,
    title: params.title,
    detail: params.detail ?? null,
    state: 'OPEN',
    dueAtMillis,
    recurrence: params.recurrence ?? null,
    nagPolicy,
    nextNagAtMillis: firstNag,
    nagCount: 0,
    lastNaggedAtMillis: null,
    deferCount: 0,
    escalateWithAlarm: params.escalateWithAlarm ?? false,
    alarmId,
    completedAtMillis: null,
    completedCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(reminders).values(row).run()
  if (firstNag !== null) enqueueJob('nudge', firstNag, { reminderId, deviceId: device.deviceId })
  log.info({ reminderId, dueAtMillis, nagPolicy, ring: Boolean(alarmId) }, 'reminder created')
  return row
}

/**
 * Mark the current occurrence done and stop chasing it.
 *
 * For a recurring reminder this rolls forward to the next occurrence rather than ending: state
 * returns to OPEN with a fresh due time and a reset ladder. Only `cancelReminder` ends a series,
 * mirroring how cancelling a recurring alarm behaves so there is one mental model.
 */
export async function completeReminder(
  device: Device,
  reminderId: string,
): Promise<{ completed: boolean; rolledTo?: number; reminder?: Reminder }> {
  const r = getReminder(reminderId)
  if (!r || r.state !== 'OPEN') return { completed: false }
  const now = Date.now()

  await releaseAlarm(device, r)
  cancelNudges(reminderId)

  const next =
    r.recurrence && r.dueAtMillis !== null
      ? nextOccurrence(r.recurrence, r.dueAtMillis, device.timezone, now)
      : null

  if (next !== null) {
    let alarmId: string | null = null
    if (r.alarmId) {
      alarmId = newAlarmId()
      await armAlarm(device, { alarmId, triggerAtMillis: next, label: r.title, recurrence: null })
    }
    const firstNag = nextNagAt({
      policy: r.nagPolicy as NagPolicy,
      nagCount: 0,
      dueAtMillis: next,
      zone: device.timezone,
      nowMillis: now,
    })
    db.update(reminders)
      .set({
        state: 'OPEN',
        dueAtMillis: next,
        nagCount: 0,
        nextNagAtMillis: firstNag,
        lastNaggedAtMillis: null,
        alarmId,
        completedAtMillis: now,
        completedCount: r.completedCount + 1,
        updatedAt: now,
      })
      .where(eq(reminders.reminderId, reminderId))
      .run()
    if (firstNag !== null) enqueueJob('nudge', firstNag, { reminderId, deviceId: device.deviceId })
    log.info({ reminderId, next }, 'reminder occurrence completed; series rolled forward')
    return { completed: true, rolledTo: next, reminder: getReminder(reminderId) }
  }

  db.update(reminders)
    .set({
      state: 'DONE',
      nextNagAtMillis: null,
      alarmId: null,
      completedAtMillis: now,
      completedCount: r.completedCount + 1,
      updatedAt: now,
    })
    .where(eq(reminders.reminderId, reminderId))
    .run()
  log.info({ reminderId }, 'reminder completed')
  return { completed: true, reminder: getReminder(reminderId) }
}

/** Drop a reminder entirely. On a recurring reminder this ends the whole series. */
export async function cancelReminder(device: Device, reminderId: string): Promise<boolean> {
  const r = getReminder(reminderId)
  if (!r || r.state === 'CANCELLED') return false
  await releaseAlarm(device, r)
  cancelNudges(reminderId)
  db.update(reminders)
    .set({ state: 'CANCELLED', nextNagAtMillis: null, recurrence: null, alarmId: null, updatedAt: Date.now() })
    .where(eq(reminders.reminderId, reminderId))
    .run()
  log.info({ reminderId }, 'reminder cancelled')
  return true
}

/**
 * Push the next follow-up back without completing. "Snoozed" is just a future nextNagAtMillis.
 *
 * This is the only deferral path in the system — there is no reschedule tool — so it is the only
 * place `deferCount` moves. That counter is what lets Otto say "fourth move" and be telling the
 * truth rather than bluffing.
 */
export function snoozeReminder(reminderId: string, untilMillis: number): boolean {
  const r = getReminder(reminderId)
  if (!r || r.state !== 'OPEN') return false
  db.update(reminders)
    .set({ nextNagAtMillis: untilMillis, deferCount: r.deferCount + 1, updatedAt: Date.now() })
    .where(eq(reminders.reminderId, reminderId))
    .run()
  cancelNudges(reminderId)
  enqueueJob('nudge', untilMillis, { reminderId, deviceId: r.deviceId })
  return true
}

/** Undo a completion — the owner says the wrong thing got ticked off, or it wasn't finished. */
export function reopenReminder(device: Device, reminderId: string): boolean {
  const r = getReminder(reminderId)
  if (!r || r.state === 'OPEN') return false
  const now = Date.now()
  const nag = nextNagAt({
    policy: r.nagPolicy as NagPolicy,
    nagCount: r.nagCount,
    dueAtMillis: r.dueAtMillis,
    zone: device.timezone,
    nowMillis: now,
  })
  db.update(reminders)
    .set({ state: 'OPEN', completedAtMillis: null, nextNagAtMillis: nag, updatedAt: now })
    .where(eq(reminders.reminderId, reminderId))
    .run()
  if (nag !== null) enqueueJob('nudge', nag, { reminderId, deviceId: r.deviceId })
  return true
}

/**
 * A reminder's alarm rang and the owner dismissed it (or missed it). That is NOT completion — the
 * task still has to be done — so start the chat follow-up rather than touching state.
 */
export function onReminderAlarmEvent(alarmId: string, event: string, zone: string): void {
  const r = db.select().from(reminders).where(eq(reminders.alarmId, alarmId)).get()
  if (!r || r.state !== 'OPEN') return
  const now = Date.now()
  const nag = nextNagAt({
    policy: r.nagPolicy as NagPolicy,
    nagCount: Math.max(r.nagCount, 1), // the ring itself counts as rung 0
    dueAtMillis: r.dueAtMillis,
    zone,
    nowMillis: now,
  })
  if (nag === null) return
  db.update(reminders)
    .set({ nextNagAtMillis: nag, updatedAt: now })
    .where(and(eq(reminders.reminderId, r.reminderId), ne(reminders.state, 'DONE')))
    .run()
  cancelNudges(r.reminderId)
  enqueueJob('nudge', nag, { reminderId: r.reminderId, deviceId: r.deviceId })
  log.info({ reminderId: r.reminderId, event, nag }, 'reminder alarm fired; chat follow-up scheduled')
}

async function releaseAlarm(device: Device, r: Reminder): Promise<void> {
  if (!r.alarmId) return
  try {
    await cancelAlarm(device, r.alarmId)
  } catch (err) {
    log.warn({ err, alarmId: r.alarmId }, 'could not cancel reminder alarm')
  }
}
