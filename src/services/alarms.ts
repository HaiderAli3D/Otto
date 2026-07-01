import { and, eq, gt, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { alarmEvents, alarms } from '../db/schema.js'
import { armData, cancelData } from '../fcm/commands.js'
import { sendData } from '../fcm/sender.js'
import { newAlarmId } from '../lib/ids.js'
import { log } from '../lib/log.js'
import { cancelJobs, enqueueJob } from './jobs.js'
import { clearToken, getDevice, type Device } from './devices.js'
import { nextOccurrence } from './recurrence.js'

export type Alarm = typeof alarms.$inferSelect

const GRACE_MS = 60_000
export const ARM_ACK_TIMEOUT_MS = 90_000
// Backstop delay after an occurrence's trigger time before the scheduler force-advances a
// recurring series (covers a phone that never reports DISMISSED/MISSED, e.g. offline).
export const RECURRING_BACKSTOP_MS = 10 * 60_000

export function getAlarm(alarmId: string): Alarm | undefined {
  return db.select().from(alarms).where(eq(alarms.alarmId, alarmId)).get()
}

/** The authoritative ARMED set the app reconciles to (future, minus a small grace window). */
export function listArmed(deviceId: string): Alarm[] {
  return db
    .select()
    .from(alarms)
    .where(and(eq(alarms.deviceId, deviceId), eq(alarms.state, 'ARMED'), gt(alarms.triggerAtMillis, Date.now() - GRACE_MS)))
    .all()
}

/** Push a signed ARM to the device; clears a dead token so the app re-registers. */
export async function pushArm(
  device: Device,
  a: { alarmId: string; triggerAtMillis: number; label: string; allowWhileIdle: boolean },
): Promise<boolean> {
  if (!device.fcmToken) {
    log.warn({ deviceId: device.deviceId }, 'No FCM token; cannot push ARM')
    return false
  }
  const res = await sendData(
    device.fcmToken,
    armData({ alarmId: a.alarmId, triggerAtMillis: a.triggerAtMillis, label: a.label, allowWhileIdle: a.allowWhileIdle, secret: device.hmacSecret }),
  )
  if (!res.ok && res.unregistered) clearToken(device.deviceId)
  return res.ok
}

/** Create/replace an alarm (idempotent on alarmId) and push ARM, arming the ack watchdog. */
export async function armAlarm(
  device: Device,
  params: { alarmId: string; triggerAtMillis: number; label: string; allowWhileIdle?: boolean; recurrence?: string | null },
): Promise<{ alarmId: string; sent: boolean }> {
  const now = Date.now()
  const existing = getAlarm(params.alarmId)
  const allowWhileIdle = params.allowWhileIdle ?? true
  db.insert(alarms)
    .values({
      alarmId: params.alarmId,
      deviceId: device.deviceId,
      triggerAtMillis: params.triggerAtMillis,
      label: params.label,
      state: 'ARMED',
      allowWhileIdle,
      recurrence: params.recurrence ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: alarms.alarmId,
      set: {
        triggerAtMillis: params.triggerAtMillis,
        label: params.label,
        state: 'ARMED',
        allowWhileIdle,
        recurrence: params.recurrence ?? null,
        updatedAt: now,
      },
    })
    .run()

  const sent = await pushArm(device, { alarmId: params.alarmId, triggerAtMillis: params.triggerAtMillis, label: params.label, allowWhileIdle })
  // Arm-ack watchdog: FCM has no delivery receipt, so if no ARMED event report arrives within the
  // timeout we resend (see scheduler). Replace any prior watchdog for this alarm.
  cancelJobs('arm_ack', params.alarmId)
  enqueueJob('arm_ack', now + ARM_ACK_TIMEOUT_MS, { alarmId: params.alarmId, deviceId: device.deviceId, payload: { attempt: 1 } })
  // Recurring series: schedule the advance backstop for this occurrence (event-driven advance in
  // recordEvent is the primary path; this covers a phone that never reports back).
  if (params.recurrence) {
    cancelJobs('recurring', params.alarmId)
    enqueueJob('recurring', params.triggerAtMillis + RECURRING_BACKSTOP_MS, {
      alarmId: params.alarmId,
      deviceId: device.deviceId,
    })
  }
  return { alarmId: params.alarmId, sent }
}

/**
 * Roll a recurring series forward exactly once: claim this occurrence's rule (a guarded UPDATE —
 * the event-driven path and the scheduler backstop can both call this, only one wins), compute
 * the next wall-clock occurrence in the device zone, and arm it as a NEW alarm carrying the rule.
 */
export async function advanceRecurrence(alarmId: string): Promise<{ advanced: boolean; nextAlarmId?: string }> {
  const alarm = getAlarm(alarmId)
  if (!alarm?.recurrence || alarm.state === 'CANCELLED') return { advanced: false }
  const device = getDevice(alarm.deviceId)
  if (!device) return { advanced: false }

  const rule = alarm.recurrence
  const claimed = db
    .update(alarms)
    .set({ recurrence: null, updatedAt: Date.now() })
    .where(and(eq(alarms.alarmId, alarmId), isNotNull(alarms.recurrence)))
    .run()
  if (claimed.changes === 0) return { advanced: false } // the other path got here first

  const nextAt = nextOccurrence(rule, alarm.triggerAtMillis, device.timezone, Date.now())
  if (nextAt === null) {
    log.warn({ alarmId, rule }, 'recurrence: no next occurrence computable; series ends')
    return { advanced: false }
  }
  const nextAlarmId = newAlarmId()
  await armAlarm(device, {
    alarmId: nextAlarmId,
    triggerAtMillis: nextAt,
    label: alarm.label,
    allowWhileIdle: alarm.allowWhileIdle,
    recurrence: rule,
  })
  log.info({ from: alarmId, to: nextAlarmId, nextAt }, 'recurrence: advanced series')
  return { advanced: true, nextAlarmId }
}

/** Mark an alarm cancelled and push CANCEL. Cancelling the pending occurrence ends its series. */
export async function cancelAlarm(device: Device, alarmId: string): Promise<boolean> {
  db.update(alarms)
    .set({ state: 'CANCELLED', recurrence: null, updatedAt: Date.now() })
    .where(eq(alarms.alarmId, alarmId))
    .run()
  cancelJobs('arm_ack', alarmId)
  cancelJobs('recurring', alarmId)
  if (!device.fcmToken) return false
  const res = await sendData(device.fcmToken, cancelData(alarmId, device.hmacSecret))
  if (!res.ok && res.unregistered) clearToken(device.deviceId)
  return res.ok
}

/**
 * Record an event reported by the app (deduped on alarm,event,at) and advance alarm state. An
 * ARMED report is the delivery ack that cancels the watchdog.
 */
export function recordEvent(
  deviceId: string,
  alarmId: string,
  event: string,
  atMillis: number,
  appVersion: string | null,
): void {
  db.insert(alarmEvents)
    .values({ alarmId, deviceId, event, atMillis, appVersion, receivedAt: Date.now() })
    .onConflictDoNothing()
    .run()

  if (event === 'ARMED') cancelJobs('arm_ack', alarmId)
  // SNOOZED is informational (the app re-arms and reports ARMED again); every other event is a
  // real state the server should reflect.
  if (['ARMED', 'RANG', 'DISMISSED', 'CANCELLED', 'MISSED'].includes(event)) {
    db.update(alarms).set({ state: event, updatedAt: Date.now() }).where(eq(alarms.alarmId, alarmId)).run()
  }
}
