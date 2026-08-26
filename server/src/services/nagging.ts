import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { reminders } from '../db/schema.js'
import { newAlarmId } from '../lib/ids.js'
import { writeNudge } from '../agent/nudge.js'
import { nextNagAt } from '../lib/nagLadder.js'
import { log } from '../lib/log.js'
import { deferPastQuietHours } from '../lib/quietHours.js'
import { armAlarm } from './alarms.js'
import { budgetAllows, budgetResetsAt } from './budget.js'
import { attendedCheckInText, commitmentAt } from './commitments.js'
import { getDevice } from './devices.js'
import { enqueueJob } from './jobs.js'
import { enqueueAndFlushRow, enqueueAndTryFlush } from './outbox.js'
import { completeReminder, getReminder, ladderParams, leadCountFor, resolvedPlanFor } from './reminders.js'
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

  // Hoisted above the gates below: the assumed-attendance check-in needs to know there is somewhere
  // to send it BEFORE it closes anything. Silently closing a reminder nobody can be told about
  // would lose it.
  const waUserId = before.waUserId ?? device.whatsappNumber

  const now = Date.now()
  if (now - scheduledAt > STALE_NUDGE_MS) {
    // Do not SEND this rung — that is the whole point of the gate, and firing it plus the dozen
    // behind it the moment we boot is the worst failure mode of a queue. But move to the next rung
    // rather than writing null.
    //
    // Null ENDED the chase. Nothing revives a reminder whose `nextNagAtMillis` is null: no job is
    // enqueued, and the digest this comment used to promise reads OUTBOX rows, of which a rung
    // retired here produces none. So one restart spanning a day-start silently retired a reminder
    // for good, and the owner's only clue was Otto never mentioning it again.
    //
    // Advancing costs the rung it could not send, which is correct — it was a real interruption the
    // owner did not get, and pretending otherwise would let a long outage replay a whole ladder.
    const resumeAt = nextNagAt(ladderParams(device, before, before.nagCount + 1, now))
    const moved = db
      .update(reminders)
      .set({ nagCount: before.nagCount + 1, nextNagAtMillis: resumeAt, updatedAt: now })
      .where(and(eq(reminders.reminderId, reminderId), eq(reminders.nextNagAtMillis, scheduledAt)))
      .run()
    if (moved.changes === 0) {
      log.debug({ reminderId }, 'stale-rung advance lost the claim; another path handled it')
      return
    }
    if (resumeAt !== null) enqueueJob('nudge', resumeAt, { reminderId, deviceId: device.deviceId })
    log.info(
      { reminderId, lateBy: now - scheduledAt, resumeAt },
      'skipping stale nudge without sending it; advanced to the next rung',
    )
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
  // `escalateWithAlarm` buys three things: no quiet hours, no daily budget, and a ringing alarm once
  // badly overdue. All three are justified by the same sentence — "this is time-critical, wake them"
  // — and all three are indefensible without a due time, because the ring is gated on being an hour
  // past a deadline that does not exist. Left as the raw flag, an undated escalating reminder would
  // chase at 3am, uncounted against the budget, and could never actually ring: every safety valve
  // off, and the one thing the flag was for unreachable. So the flag only counts when there is
  // something to be late for.
  const escalating = before.escalateWithAlarm && before.dueAtMillis !== null
  const quiet = nagQuietHours(device, escalating)
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

  // Daily ceiling, in the same place and for the same reason as the quiet-hours backstop above:
  // BEFORE the claim, so being held costs no rung. Burning one against a message nobody was sent
  // would inflate the "chased N×" counter the persona cites as evidence.
  //
  // Pushed to the next local midnight rather than dropped — the reminder is still open and still
  // needs chasing, it just does not get another interruption today.
  if (!budgetAllows(device, 'nudge', { escalating }, now)) {
    const refill = budgetResetsAt(device.timezone, now)
    const moved = db
      .update(reminders)
      .set({ nextNagAtMillis: refill, updatedAt: now })
      .where(and(eq(reminders.reminderId, reminderId), eq(reminders.nextNagAtMillis, scheduledAt)))
      .run()
    if (moved.changes === 0) {
      log.debug({ reminderId }, 'budget deferral lost the claim; another path handled it')
      return
    }
    enqueueJob('nudge', refill, { reminderId, deviceId: device.deviceId })
    log.info({ reminderId, refill }, 'daily message budget spent; moved the rung to tomorrow without burning it')
    return
  }

  // Inside a timed commitment. Deferred BEFORE the claim, exactly like the two gates above, so a
  // held rung costs no rung and cannot inflate the "chased N×" counter the persona cites as its
  // whole evidence. Third of the three on purpose: quiet hours is arithmetic, the budget is one
  // SQL count, this is a network read — so a rung already stopped by either never pays for it.
  //
  // TWO EXEMPTIONS DELIBERATELY DO NOT CARRY OVER FROM THE GATES ABOVE:
  //
  // - `ownersOwnDueTime`. Quiet hours never move the instant the owner picked themselves. This
  //   does, because a reminder due at 19:00 during a 19:00 dinner is the exact case the rule was
  //   asked for — the owner named that time before the dinner existed, and honouring it now means
  //   interrupting the thing they named it for.
  // - `escalateWithAlarm`. `nagQuietHours` exempts those wholesale, ringing included. Here it is
  //   held, because the alarm it would raise is one OTTO raises: their own alarms and their
  //   leave-by alarms still ring, and neither passes through this module.
  //
  // Composed through `deferPastQuietHours` so a meeting ending at 23:30 cannot smuggle a rung past
  // the window the owner set.
  const commitment = await commitmentAt(device, now)
  if (commitment !== null) {
    const resumeAt = deferPastQuietHours(commitment.endMillis, device.timezone, quiet)
    const moved = db
      .update(reminders)
      .set({ nextNagAtMillis: resumeAt, updatedAt: now })
      .where(and(eq(reminders.reminderId, reminderId), eq(reminders.nextNagAtMillis, scheduledAt)))
      .run()
    if (moved.changes === 0) {
      log.debug({ reminderId }, 'commitment deferral lost the claim; another path handled it')
      return
    }
    enqueueJob('nudge', resumeAt, { reminderId, deviceId: device.deviceId })
    // Back-to-back meetings terminate on their own: the first one's end is covered by the second
    // (the overlap test is closed at the start), so the next run simply defers again.
    log.info(
      { reminderId, resumeAt, commitment: commitment.summary },
      'nudge fell inside a timed commitment; moved to its end without burning a rung',
    )
    return
  }

  // The rung that was due while they were booked, now that the booking is over. Assume it happened.
  //
  // This is the whole point of the feature: the owner should never have to interrupt a meeting to
  // tell Otto they are in it. So the reminder closes itself and says so ONCE, and "no" is the only
  // thing that reopens it — silence means it went fine.
  //
  // Two free conditions bound this to at most one extra calendar read per reminder for its whole
  // life. `nagCount === leadCount` is the rung sitting on the due instant (see `rungPhaseFor`), and
  // `scheduledAt > dueAtMillis` means something pushed it — which for a due rung only the block
  // above ever does, since `nextNagAt` exempts the owner's own instant from quiet hours.
  //
  // The calendar is asked AGAIN rather than remembered from above, on the leave-by recheck's
  // argument: the dinner may have been moved or cancelled in the meantime, and then nothing was
  // attended and the ordinary nudge below is the right answer.
  if (waUserId !== null && before.dueAtMillis !== null && scheduledAt > before.dueAtMillis) {
    const during =
      before.nagCount === leadCountFor(device, before) ? await commitmentAt(device, before.dueAtMillis) : null
    // The rung must be one THIS gate moved, not merely one that happens to sit after a due time
    // that had a meeting on it. `snoozeReminder` — the agent tool and the lock-screen SNOOZE button
    // — also pushes a due rung later without touching nagCount, and closing a task the owner has
    // just explicitly said "later" to would lose it silently. So the deferral instant has to match
    // exactly what the block above would have written. A changed quiet-hours window makes it miss,
    // which falls through to an ordinary nudge: the safe direction to be wrong in.
    const wasHeldByThisGate =
      during !== null && deferPastQuietHours(during.endMillis, device.timezone, quiet) === scheduledAt
    if (during !== null && wasHeldByThisGate && during.endMillis <= now) {
      // ASK. Do not close.
      //
      // This used to call `completeReminder` on the assumption that a reminder due inside a meeting
      // was a thing the meeting WAS — and nothing in the path ever consulted `timingKindOf`, while
      // `createReminder` defaults every dated reminder to `deadline`. So "send the invoice by 16:00"
      // plus a protected 16:00 meeting marked the invoice done, with a sentence inviting the owner
      // to correct it. For an `appointment` the assumption is sound: the dentist at four IS the
      // four o'clock entry. For a deadline it is backwards — being stuck in a meeting when
      // something was due is evidence it did NOT get done, and the one message that would have
      // said so was spent announcing the opposite.
      //
      // A question costs the same one message and cannot be wrong. The reminder stays OPEN, so if
      // they say nothing the ladder simply carries on chasing, which is the safe direction.
      //
      // The rung IS spent: a question is a message that reached them and can be answered, which is
      // this codebase's rule for when a rung is spent (see the deferrals above, which all defer
      // precisely BECAUSE nobody was sent anything). `assumedAttendedAtMillis` records that the
      // question was asked, so the writer and the record can tell this apart from an ordinary chase.
      const asked = await enqueueAndFlushRow({
        waUserId,
        deviceId: device.deviceId,
        kind: 'nudge',
        body: attendedCheckInText(before.title, during.summary),
        reminderId,
        dedupeKey: `attended:${reminderId}:${during.startMillis}`,
      })
      if (asked.retired) {
        log.warn({ reminderId }, 'commitment check-in was retired undelivered; leaving the ladder alone')
        return
      }
      const nextAfterAsking = nextNagAt(ladderParams(device, before, before.nagCount + 1, now))
      db.update(reminders)
        .set({
          nagCount: sql`${reminders.nagCount} + 1`,
          lastNaggedAtMillis: now,
          nextNagAtMillis: nextAfterAsking,
          assumedAttendedAtMillis: now,
          updatedAt: now,
        })
        .where(and(eq(reminders.reminderId, reminderId), eq(reminders.nextNagAtMillis, scheduledAt)))
        .run()
      if (nextAfterAsking !== null) {
        enqueueJob('nudge', nextAfterAsking, { reminderId, deviceId: device.deviceId })
      }
      log.info(
        { reminderId, commitment: during.summary },
        'reminder was due inside a commitment; asked whether it got done rather than assuming it did',
      )
      return
    }
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

  // ENQUEUED HERE, in the same synchronous block as the claim, and NOT after the sends below.
  //
  // The claim writes `nextNagAtMillis = nextRung`, but the job that would act on it used to be
  // enqueued only at the very end of this function — after `writeNudge` (up to two 15s model calls)
  // and `enqueueAndFlushRow` (up to ~50s of Graph retries). `index.ts` handles SIGTERM by awaiting
  // `app.close()` and not the detached scheduler tick, so a `fly deploy` inside that window left the
  // reminder pointing at a rung no job would ever act on: the surviving old job re-runs, sees a rung
  // that has moved into the future, and `loop.ts` deletes it. The ladder stalls until the morning
  // brief happens to heal it, and permanently if the brief is off or the window was shut at the time
  // — which is exactly when chasing matters.
  //
  // This is the ordering `services/alarms.ts` already documents for the arm-ack watchdog ("enqueue
  // the durable watchdog BEFORE awaiting the push"). A duplicate job row is harmless: `runNudge`
  // no-ops on a rung that has already moved, three lines from the top.
  if (nextRung !== null) enqueueJob('nudge', nextRung, { reminderId, deviceId: device.deviceId })

  if (!waUserId) {
    log.warn({ reminderId }, 'no WhatsApp number linked; cannot nudge')
  } else {
    const overdue =
      before.dueAtMillis !== null && before.dueAtMillis < now
        ? `due ${epochMillisToLocalHuman(before.dueAtMillis, device.timezone)}`
        : undefined
    // Composed after the claim, so only the winner pays for the call. `before` is the pre-increment
    // snapshot, which is what both the writer and its templated fallback expect.
    const plan = resolvedPlanFor(device, before)
    const body = await writeNudge(before, device.timezone, overdue, {
      leadCount: plan.leadAt.length,
      totalRungs: plan.leadAt.length + plan.maxChases,
    })
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
    // `0` for an undated reminder, so the gate below can never open for one. Deliberate, not a gap:
    // it reads "an hour past the deadline", and a reminder with no due time has missed nothing. It
    // is still chased over WhatsApp; it just never rings a phone at full volume for something nobody
    // is late for. `escalating` says the same thing a second time, structurally.
    const overdueBy = before.dueAtMillis === null ? 0 : now - before.dueAtMillis
    const cooling =
      before.lastEscalatedAtMillis !== null && now - before.lastEscalatedAtMillis < ESCALATE_COOLDOWN_MS
    if (!sent && escalating && overdueBy > ESCALATE_AFTER_MS && !cooling) {
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
    } else if (!sent && escalating && cooling) {
      log.info({ reminderId, since: before.lastEscalatedAtMillis }, 'escalation suppressed; still inside the ring cooldown')
    }
  }

}
