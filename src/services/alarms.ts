import { and, eq, gt, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { alarmEvents, alarms } from '../db/schema.js'
import { armData, cancelData } from '../fcm/commands.js'
import { sendData } from '../fcm/sender.js'
import { newAlarmId } from '../lib/ids.js'
import { log } from '../lib/log.js'
import { cancelJobs, deleteJob, enqueueJob, jobPayload, jobsForAlarm, reanchorJob } from './jobs.js'
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
  params: {
    alarmId: string
    triggerAtMillis: number
    label: string
    allowWhileIdle?: boolean
    recurrence?: string | null
    /** Follow this alarm up over WhatsApp once it is dismissed — see services/wakeCheck.ts. */
    wakeCheck?: boolean
  },
): Promise<{ alarmId: string; sent: boolean }> {
  const now = Date.now()
  const existing = getAlarm(params.alarmId)
  const allowWhileIdle = params.allowWhileIdle ?? true
  const wakeCheck = params.wakeCheck ?? false
  db.insert(alarms)
    .values({
      alarmId: params.alarmId,
      deviceId: device.deviceId,
      triggerAtMillis: params.triggerAtMillis,
      label: params.label,
      state: 'ARMED',
      allowWhileIdle,
      recurrence: params.recurrence ?? null,
      wakeCheck,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: alarms.alarmId,
      // `wakeCheck` belongs in BOTH halves: this is an upsert, and re-arming the same alarmId (the
      // SYNC/recovery path) would otherwise silently keep whatever the row had before.
      set: {
        triggerAtMillis: params.triggerAtMillis,
        label: params.label,
        state: 'ARMED',
        allowWhileIdle,
        recurrence: params.recurrence ?? null,
        wakeCheck,
        updatedAt: now,
      },
    })
    .run()

  // Arm-ack watchdog: FCM has no delivery receipt, so if no ARMED event report arrives within the
  // timeout we resend (see scheduler). Enqueue the durable watchdog BEFORE awaiting the push so a
  // crash/SIGTERM mid-send still leaves a retry behind. Replace any prior watchdog for this alarm.
  cancelJobs('arm_ack', params.alarmId)
  enqueueJob('arm_ack', now + ARM_ACK_TIMEOUT_MS, { alarmId: params.alarmId, deviceId: device.deviceId, payload: { attempt: 1 } })
  const sent = await pushArm(device, { alarmId: params.alarmId, triggerAtMillis: params.triggerAtMillis, label: params.label, allowWhileIdle })
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
    // Carried forward, or a recurring 06:30 wake-up loses its check on day two — which is the one
    // alarm the whole feature exists for.
    wakeCheck: alarm.wakeCheck,
  })
  log.info({ from: alarmId, to: nextAlarmId, nextAt }, 'recurrence: advanced series')
  return { advanced: true, nextAlarmId }
}

/**
 * Hand a leave-by recheck to a surviving sibling, or drop it.
 *
 * A leave-by PLAN arms up to two alarms — the departure and the get-up — but leaves exactly ONE
 * recheck, anchored on whichever of them exists. Cancelling that anchor used to delete the recheck
 * outright, which quietly left the other alarm with nothing watching it: cancel the 08:30 departure,
 * keep the 07:45 wake, the dentist cancels the appointment overnight, and the phone still rings
 * "Up — leave 08:30 for Dentist" for a meeting that no longer exists. `runLeaveBy` already handles a
 * half-cancelled pair (see `liveId` there); it was simply never reached from this direction.
 *
 * Synchronous throughout — the read, the state check and the write are all better-sqlite3 statements
 * with no await between them, and the caller has already marked THIS alarm CANCELLED, so the sibling
 * lookup below can never resolve back to it.
 */
function releaseLeaveByRecheck(alarmId: string): void {
  for (const job of jobsForAlarm('leave_by', alarmId)) {
    const payload = jobPayload<{ alarmId: string | null; wakeId: string | null }>(job)
    const sibling = [payload?.alarmId ?? null, payload?.wakeId ?? null].find(
      (id): id is string => id !== null && id !== alarmId,
    )
    if (sibling !== undefined && getAlarm(sibling)?.state === 'ARMED') {
      reanchorJob(job.id, sibling)
      log.info({ from: alarmId, to: sibling, jobId: job.id }, 'leave-by recheck re-anchored onto the surviving alarm')
      continue
    }
    deleteJob(job.id)
  }
}

/** Mark an alarm cancelled and push CANCEL. Cancelling the pending occurrence ends its series. */
export async function cancelAlarm(device: Device, alarmId: string): Promise<boolean> {
  db.update(alarms)
    .set({ state: 'CANCELLED', recurrence: null, updatedAt: Date.now() })
    .where(eq(alarms.alarmId, alarmId))
    .run()
  cancelJobs('arm_ack', alarmId)
  cancelJobs('recurring', alarmId)
  // Every pending chain anchored on this alarm dies with it, not just the watchdog. The leave-by
  // recheck re-arms the SAME derived id when the meeting moves, so a chain that outlived its alarm
  // would take a CANCELLED row back to ARMED and ring the phone for a journey the owner explicitly
  // called off — three quarters of an hour after they cancelled it, with no way to see it coming.
  // Unless it is also guarding the other half of a two-alarm plan, which is what this weighs up.
  releaseLeaveByRecheck(alarmId)
  if (!device.fcmToken) return false
  const res = await sendData(device.fcmToken, cancelData(alarmId, device.hmacSecret))
  if (!res.ok && res.unregistered) clearToken(device.deviceId)
  return res.ok
}

const STATE_EVENTS = ['ARMED', 'RANG', 'DISMISSED', 'CANCELLED', 'MISSED']

/**
 * Append an audit row for something the SERVER observed about an alarm, e.g. WAKE_CHECK_FAILED.
 *
 * Deliberately not `recordEvent`: that one exists to apply a PHONE report, so it carries the
 * out-of-order/replay ordering logic and writes `alarms.state`. A server-side observation is
 * neither — it must never move the alarm's state, and it has no report ordering to reconcile.
 * `alarm_events.event` is free-form TEXT (and the route's zod is `z.string()`), so a new kind of
 * row needs no table and no migration. The dedupe index on (alarm, event, at) still applies, which
 * makes this idempotent for free.
 *
 * Returns whether the row was actually new. That makes the dedupe index usable as a durable,
 * single-statement LATCH — `scheduleWakeCheck` claims (alarm, WAKE_CHECK_STARTED, dismissedAt)
 * through it — rather than only as silent replay protection. Guarded INSERT, same shape as the
 * guarded UPDATEs elsewhere: better-sqlite3 is synchronous, so one statement decides the winner.
 */
export function recordServerEvent(deviceId: string, alarmId: string, event: string, atMillis: number): boolean {
  const inserted = db
    .insert(alarmEvents)
    .values({ alarmId, deviceId, event, atMillis, appVersion: null, receivedAt: Date.now() })
    .onConflictDoNothing()
    .run()
  return inserted.changes > 0
}

/**
 * Record an event reported by the app and advance alarm state. Because the app's outbox retries
 * at-least-once and reports can arrive out of order, we act on an event only when it is BOTH new
 * (the dedupe insert actually happened) AND not older than the newest event already recorded for
 * this alarm. A replayed or late-arriving ARMED must never resurrect a CANCELLED alarm or cancel
 * the watchdog for a newer re-arm. An ARMED report is the delivery ack that cancels the watchdog;
 * it may also carry the phone's current trigger time (e.g. after a snooze) which we adopt as
 * authoritative so a later SYNC lists the alarm at its real time.
 */
export function recordEvent(
  deviceId: string,
  alarmId: string,
  event: string,
  atMillis: number,
  appVersion: string | null,
  triggerAtMillis?: number,
): void {
  // Newest event time already on record for this alarm, BEFORE inserting this one.
  const prior = db
    .select({ max: sql<number | null>`MAX(${alarmEvents.atMillis})` })
    .from(alarmEvents)
    .where(eq(alarmEvents.alarmId, alarmId))
    .get()
  const priorMax = prior?.max ?? null

  const inserted = db
    .insert(alarmEvents)
    .values({ alarmId, deviceId, event, atMillis, appVersion, receivedAt: Date.now() })
    .onConflictDoNothing()
    .run()

  // Duplicate re-delivery (same alarm,event,at) → record only, never re-apply side effects.
  if (inserted.changes === 0) return
  // Genuinely new but stale (an older report landing after a newer one) → keep it for the audit
  // trail but don't let it regress state or ack a newer arm.
  if (priorMax !== null && atMillis < priorMax) return

  if (event === 'ARMED') cancelJobs('arm_ack', alarmId)
  // SNOOZED is informational (the app re-arms and reports ARMED again); every other listed event
  // is a real state the server should reflect.
  if (STATE_EVENTS.includes(event)) {
    const set: Partial<Alarm> = { state: event, updatedAt: Date.now() }
    // Adopt the phone-reported trigger only on ARMED (snooze/re-arm moved it); other events keep
    // the server's time.
    if (event === 'ARMED' && typeof triggerAtMillis === 'number') set.triggerAtMillis = triggerAtMillis
    db.update(alarms).set(set).where(eq(alarms.alarmId, alarmId)).run()
  }
}
