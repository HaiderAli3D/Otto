import { and, eq, gt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { alarmEvents, alarms } from '../db/schema.js'
import { armData, cancelData } from '../fcm/commands.js'
import { sendData } from '../fcm/sender.js'
import { log } from '../lib/log.js'
import { cancelJobs, enqueueJob } from './jobs.js'
import { clearToken, type Device } from './devices.js'

export type Alarm = typeof alarms.$inferSelect

const GRACE_MS = 60_000
export const ARM_ACK_TIMEOUT_MS = 90_000

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
  return { alarmId: params.alarmId, sent }
}

/** Mark an alarm cancelled and push CANCEL. */
export async function cancelAlarm(device: Device, alarmId: string): Promise<boolean> {
  db.update(alarms).set({ state: 'CANCELLED', updatedAt: Date.now() }).where(eq(alarms.alarmId, alarmId)).run()
  cancelJobs('arm_ack', alarmId)
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
