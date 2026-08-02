import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { reminders } from '../db/schema.js'
import { newAlarmId } from '../lib/ids.js'
import { writeNudge } from '../agent/nudge.js'
import { nextNagAt, type NagPolicy } from '../lib/nagLadder.js'
import { log } from '../lib/log.js'
import { armAlarm } from './alarms.js'
import { getDevice } from './devices.js'
import { enqueueJob } from './jobs.js'
import { enqueueAndTryFlush } from './outbox.js'
import { getReminder } from './reminders.js'
import { epochMillisToLocalHuman } from './time.js'

/**
 * A nudge this far past its scheduled time is stale — the machine was down. Firing it (and the
 * dozen behind it) the moment we boot is the worst failure mode of a queue; let the daily digest
 * pick these up instead.
 */
const STALE_NUDGE_MS = 6 * 60 * 60 * 1000

/** How overdue a reminder must be before an out-of-window escalation may ring the phone. */
const ESCALATE_AFTER_MS = 60 * 60 * 1000

/**
 * Fire one nudge for a reminder.
 *
 * The claim is a single guarded UPDATE rather than read-then-write: better-sqlite3 is synchronous,
 * so one statement is atomic, but a read followed by an `await` followed by a write yields the
 * event loop and can double-send. `changes === 0` means the reminder was completed, snoozed, or
 * already nudged by another path — send nothing.
 */
export async function runNudge(reminderId: string): Promise<void> {
  const before = getReminder(reminderId)
  if (!before || before.state !== 'OPEN') return
  const scheduledAt = before.nextNagAtMillis
  if (scheduledAt === null) return

  const device = getDevice(before.deviceId)
  if (!device) return

  const now = Date.now()
  if (now - scheduledAt > STALE_NUDGE_MS) {
    // Retire the rung without sending; the digest will surface it.
    db.update(reminders)
      .set({ nextNagAtMillis: null, updatedAt: now })
      .where(and(eq(reminders.reminderId, reminderId), eq(reminders.nextNagAtMillis, scheduledAt)))
      .run()
    log.info({ reminderId, lateBy: now - scheduledAt }, 'skipping stale nudge; leaving it for the digest')
    return
  }

  const nextRung = nextNagAt({
    policy: before.nagPolicy as NagPolicy,
    nagCount: before.nagCount + 1,
    dueAtMillis: before.dueAtMillis,
    zone: device.timezone,
    nowMillis: now,
  })

  const claimed = db
    .update(reminders)
    .set({
      nagCount: sql`${reminders.nagCount} + 1`,
      lastNaggedAtMillis: now,
      nextNagAtMillis: nextRung,
      updatedAt: now,
    })
    .where(
      and(
        eq(reminders.reminderId, reminderId),
        eq(reminders.state, 'OPEN'),
        eq(reminders.nextNagAtMillis, scheduledAt),
      ),
    )
    .run()
  if (claimed.changes === 0) {
    log.debug({ reminderId }, 'nudge claim lost; another path handled it')
    return
  }

  const waUserId = before.waUserId ?? device.whatsappNumber
  if (!waUserId) {
    log.warn({ reminderId }, 'no WhatsApp number linked; cannot nudge')
  } else {
    const overdue =
      before.dueAtMillis !== null && before.dueAtMillis < now
        ? `due ${epochMillisToLocalHuman(before.dueAtMillis, device.timezone)}`
        : undefined
    // Composed after the claim, so only the winner pays for the call. `before` is the pre-increment
    // snapshot, which is what both the writer and its templated fallback expect.
    const body = await writeNudge(before, device.timezone, overdue)
    const sent = await enqueueAndTryFlush({
      waUserId,
      deviceId: device.deviceId,
      kind: 'nudge',
      body,
      reminderId,
      dedupeKey: `nag:${reminderId}:${before.nagCount}`,
    })

    // Out of window and genuinely overdue: FCM is the only channel with no 24h limit, and the app
    // can only be told to ring. Deliberately opt-in per reminder — this wakes them.
    const overdueBy = before.dueAtMillis === null ? 0 : now - before.dueAtMillis
    if (!sent && before.escalateWithAlarm && overdueBy > ESCALATE_AFTER_MS) {
      const alarmId = newAlarmId()
      await armAlarm(device, {
        alarmId,
        triggerAtMillis: now + 60_000,
        label: before.title,
        recurrence: null,
      })
      db.update(reminders).set({ alarmId, updatedAt: Date.now() }).where(eq(reminders.reminderId, reminderId)).run()
      log.warn({ reminderId, alarmId }, 'window shut and overdue; escalating to a ringing alarm')
    }
  }

  if (nextRung !== null) enqueueJob('nudge', nextRung, { reminderId, deviceId: device.deviceId })
}
