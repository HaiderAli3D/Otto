import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { reminders } from '../db/schema.js'
import { newAlarmId } from '../lib/ids.js'
import { writeNudge } from '../agent/nudge.js'
import { nextNagAt } from '../lib/nagLadder.js'
import { log } from '../lib/log.js'
import { deferPastQuietHours } from '../lib/quietHours.js'
import { armAlarm } from './alarms.js'
import { getDevice } from './devices.js'
import { enqueueJob } from './jobs.js'
import { enqueueAndTryFlush } from './outbox.js'
import { getReminder, ladderParams } from './reminders.js'
import { nagQuietHours } from './settings.js'
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
 * The minimum gap between two escalation rings for the SAME reminder.
 *
 * Load-bearing, not a nicety. The escalation below fires whenever a rung could not be delivered and
 * the item is an hour overdue — and it used to be bounded only by the ladder being short and slow.
 * The dense ladders fire rungs three to fifteen minutes apart, so on `relentless` with a shut
 * WhatsApp window every one of them would arm a real alarm: a phone ringing at full volume every
 * few minutes, for hours, with no way to stop it short of uninstalling. Two hours is deliberately
 * far wider than any rung gap so the cooldown, not the ladder, decides the ringing cadence.
 */
const ESCALATE_COOLDOWN_MS = 2 * 60 * 60 * 1000

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

  // A rung that has been moved into the future since this job was queued is not ours to fire. It
  // has a job of its own (every mover — snooze, the alarm follow-up, the quiet-hours deferral below
  // — enqueues one), so firing it here would double-send and burn a rung early.
  if (scheduledAt > now) {
    log.debug({ reminderId, scheduledAt }, 'nudge rung has moved into the future; leaving it to its own job')
    return
  }

  // Quiet-hours backstop, deliberately BEFORE the atomic claim below.
  //
  // nextNagAt is the primary choke point, so almost nothing is ever SCHEDULED into the window; this
  // catches what it cannot — a rung queued before the owner set their quiet hours, a machine that
  // was down over the boundary, an owner who changed the window an hour ago. Deferring ahead of the
  // claim is what makes it cost NO rung: burning one at 3am would inflate the "chased N×" counter
  // that the entire persona cites as evidence, over a message nobody was sent.
  //
  // NEVER SUPPRESSED, here or anywhere else:
  // - real alarms — FCM ARM never routes through this module;
  // - rung 0 at the due time the owner chose themselves (exempted below, and in nextNagAt);
  // - escalateWithAlarm reminders — opt-in per item, documented as "this WILL wake them", so
  //   nagQuietHours returns null for them and the whole reminder is exempt, ringing included;
  // - direct replies — sendText touches neither the outbox nor the ladder;
  // - the wake-check — its own job kind, which never reaches nextNagAt or runNudge.
  //
  // Keyed on the rung landing ON the due instant, NOT on it being rung 0. A deadline warns several
  // times before it lands, so by the time the owner's own instant comes round `nagCount` is however
  // many warnings went out — checking for 0 would quietly withdraw the exemption from exactly the
  // reminders that warn hardest.
  const ownersOwnDueTime = before.dueAtMillis !== null && scheduledAt === before.dueAtMillis
  const quiet = nagQuietHours(device, before.escalateWithAlarm)
  const deferredTo = ownersOwnDueTime ? now : deferPastQuietHours(now, device.timezone, quiet)
  if (deferredTo !== now) {
    // Same guarded-UPDATE shape as the staleness gate above: `changes === 0` means another path
    // already claimed this rung, so it is not ours to move and there is nothing to re-queue.
    const moved = db
      .update(reminders)
      .set({ nextNagAtMillis: deferredTo, updatedAt: now })
      .where(and(eq(reminders.reminderId, reminderId), eq(reminders.nextNagAtMillis, scheduledAt)))
      .run()
    if (moved.changes === 0) {
      log.debug({ reminderId }, 'quiet-hours deferral lost the claim; another path handled it')
      return
    }
    enqueueJob('nudge', deferredTo, { reminderId, deviceId: device.deviceId })
    log.info({ reminderId, deferredTo }, 'nudge fell inside quiet hours; moved to the window end without burning a rung')
    return
  }

  const nextRung = nextNagAt(ladderParams(device, before, before.nagCount + 1, now))

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
    const cooling =
      before.lastEscalatedAtMillis !== null && now - before.lastEscalatedAtMillis < ESCALATE_COOLDOWN_MS
    if (!sent && before.escalateWithAlarm && overdueBy > ESCALATE_AFTER_MS && !cooling) {
      const alarmId = newAlarmId()
      await armAlarm(device, {
        alarmId,
        triggerAtMillis: now + 60_000,
        label: before.title,
        recurrence: null,
      })
      db.update(reminders)
        .set({ alarmId, lastEscalatedAtMillis: now, updatedAt: Date.now() })
        .where(eq(reminders.reminderId, reminderId))
        .run()
      log.warn({ reminderId, alarmId }, 'window shut and overdue; escalating to a ringing alarm')
    } else if (!sent && before.escalateWithAlarm && cooling) {
      log.info({ reminderId, since: before.lastEscalatedAtMillis }, 'escalation suppressed; still inside the ring cooldown')
    }
  }

  if (nextRung !== null) enqueueJob('nudge', nextRung, { reminderId, deviceId: device.deviceId })
}
