import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { reminders } from '../db/schema.js'
import { log } from '../lib/log.js'
import { inQuietHours } from '../lib/quietHours.js'
import { nextNagAt } from '../lib/nagLadder.js'
import type { Device } from './devices.js'
import { cancelNudges, enqueueJob } from './jobs.js'
import { ladderParams, leadCountFor, listReminders, type Reminder } from './reminders.js'
import { quietHoursFor, quietNow } from './settings.js'
import { reminderEvidence } from './signals.js'
import { epochMillisToLocalHuman } from './time.js'

/**
 * Folding ONE pending chase into a reply the owner already opened.
 *
 * "Added take out the trash tonight, btw did you finish the report this morning?" — the thing a
 * human assistant does and a scheduler cannot. Every chase Otto sends on its own costs an
 * interruption; a chase that rides along on a message the owner is already reading costs nothing.
 *
 * The point is that it REPLACES the separate ping rather than adding to it. That is what
 * `chaseInReply` is for, and it is why the model has to call a tool rather than simply being told it
 * may ask: nothing else can know whether Otto actually decided to say the thing.
 */

/**
 * How far ahead a rung must sit to be worth pre-empting.
 *
 * It has to be long enough that the tack-on genuinely displaces an interruption, and short enough
 * that the item is pressing NOW — asking about something whose next chase is tomorrow morning is
 * Otto inventing an interruption rather than moving one.
 *
 * Six hours, which is also `STALE_NUDGE_MS` in services/nagging.ts. That is not a coincidence
 * borrowed for convenience: it is already this codebase's stated line for "a rung this far off is no
 * longer about now". Kept as its own constant so the two can be tuned apart, but they mean the same
 * thing and should move together unless there is a reason.
 */
export const TACK_ON_HORIZON_MS = 6 * 60 * 60 * 1000

/**
 * The minimum gap between two raisings, BY ANY CHANNEL.
 *
 * Read off `lastNaggedAtMillis`, which `runNudge` and `chaseInReply` both stamp, so a real nudge
 * twenty minutes ago silences the tack-on exactly as thoroughly as a previous tack-on would. That is
 * the honest question to ask — *has Otto raised anything at them recently* — and it is right when
 * the owner is replying TO that nudge.
 *
 * Ninety minutes, chosen against the three numbers either side of it. It must be much longer than a
 * conversation, because `IDLE_RESET_MS` is eight hours and "a conversation spanning lunch" is
 * deliberately one thread — anything under an hour would fire twice in one sitting. It must be
 * shorter than the gap between rungs on a mild ladder, or the feature could never fire at all. And
 * it must sit well above `MIN_RUNG_GAP_MS` so that the cooldown, not the ladder, is what decides the
 * cadence — the same sentence `ESCALATE_COOLDOWN_MS` makes about ringing.
 *
 * It also enforces "at most one per reply" structurally rather than by instruction: the first call
 * stamps `lastNaggedAtMillis`, so a second call in the same turn is inside the cooldown already.
 */
export const TACK_ON_COOLDOWN_MS = 90 * 60 * 1000

export type TackOnCandidate = {
  reminder: Reminder
  /** The same line the chase-list and the nudge writer use, so the three can never disagree. */
  evidence: string
  /** The rung this would spend — the message the owner would otherwise get on their own. */
  scheduledAtMillis: number
}

/** The most recent moment Otto raised ANYTHING at this owner, by any channel. 0 if never. */
function lastRaisedFor(open: Reminder[]): number {
  return open.reduce((acc, r) => Math.max(acc, r.lastNaggedAtMillis ?? 0), 0)
}

/**
 * The one open reminder Otto may fold into this reply, or null.
 *
 * Null is the common answer and is not a failure. Every clause below removes a case where tacking
 * on would ADD a message rather than move one, which is the only thing this feature must never do.
 */
export function tackOnCandidate(device: Device, nowMillis: number = Date.now()): TackOnCandidate | null {
  const open = listReminders(device.deviceId, { state: 'open' })
  if (open.length === 0) return null

  if (nowMillis - lastRaisedFor(open) < TACK_ON_COOLDOWN_MS) return null

  const quiet = quietHoursFor(device)
  const insideWindow = quietNow(device, nowMillis)

  const eligible = open.filter((r) => {
    const rung = r.nextNagAtMillis
    // Nothing scheduled means there is no message to replace, so raising it would be pure addition.
    // It also guarantees `chaseInReply` always has a rung to spend.
    if (rung === null) return false
    // The ping being pre-empted has to be one that was coming soon anyway.
    if (rung > nowMillis + TACK_ON_HORIZON_MS) return false
    // NEVER the first thing Otto ever says about a reminder. The first word belongs on the ladder
    // the owner's `timing` implied — pre-empting rung 0 changes when they first hear about it,
    // which is the one thing `timing` exists to decide. This is also what structurally excludes the
    // reminder they created ninety seconds ago, with no age constant to tune.
    if (r.nagCount === 0 && !(r.dueAtMillis !== null && r.dueAtMillis <= nowMillis)) return false
    // Inside their quiet hours, a rung already parked OUTSIDE the window cannot be replaced by
    // saying it now — `nextNagAt` would defer the new rung straight back to the same edge, so the
    // owner would get one extra touch rather than one fewer. Deliberately narrow: no blanket
    // suppression, because replying is never held back and this owner's window covers a third of
    // the clock.
    if (insideWindow && !inQuietHours(rung, device.timezone, quiet)) return false
    return true
  })

  // Overdue first: a chase is the message the owner minds most and the one answerable in a word,
  // while a warning is cheap and can wait for its own rung. Then soonest, then the id, so the
  // ordering is total and the same turn always produces the same candidate.
  const ranked = eligible.sort((a, b) => {
    const aOverdue = a.dueAtMillis !== null && a.dueAtMillis < nowMillis ? 0 : 1
    const bOverdue = b.dueAtMillis !== null && b.dueAtMillis < nowMillis ? 0 : 1
    if (aOverdue !== bOverdue) return aOverdue - bOverdue
    if (a.nextNagAtMillis !== b.nextNagAtMillis) return a.nextNagAtMillis! - b.nextNagAtMillis!
    return a.reminderId < b.reminderId ? -1 : 1
  })

  const first = ranked[0]
  if (first === undefined) return null
  return {
    reminder: first,
    evidence: reminderEvidence(first, device.timezone, nowMillis, leadCountFor(device, first)),
    scheduledAtMillis: first.nextNagAtMillis!,
  }
}

export type ChaseInReplyResult =
  | { error: string }
  | {
      reminderId: string
      title: string
      evidence: string
      timesRaised: number
      overdue: boolean
      replacedChaseAtLocal: string
      nextChaseLocal: string | null
      chasesNothingScheduled?: true
      reminder: string
    }

/**
 * Spend one rung inside a reply instead of sending it as its own message.
 *
 * A tack-on SPENDS the rung rather than deferring it, and that is the load-bearing decision here.
 * The rule this codebase follows is that a rung is spent exactly when a message about it reaches the
 * owner: every deferral in `runNudge` defers precisely BECAUSE nobody was sent anything, and
 * `holdNudgesCoveredByBrief` pushes rather than spends because the brief does not ask them anything.
 * A tack-on asks. They read it and can answer it, so it counts.
 *
 * Two consequences make that right rather than merely consistent. The persona cites `nagCount` as
 * the whole of its evidence, so a chase the owner saw but that went uncounted would have Otto
 * saying "first time asking" on the fourth time of asking. And only spending makes the ladder one
 * rung SHORTER — deferring would leave the same number of future interruptions and merely move one,
 * which is not what was asked for.
 *
 * `deferCount` is untouched: that counter moves only on the owner's own push-backs, and this is
 * Otto's doing.
 */
export function chaseInReply(device: Device, reminderId: string): ChaseInReplyResult {
  const open = listReminders(device.deviceId, { state: 'open' })
  const r = open.find((x) => x.reminderId === reminderId)
  if (r === undefined) {
    return { error: `no open reminder with id ${reminderId} on this device — call list_reminders first` }
  }

  const scheduledAt = r.nextNagAtMillis
  if (scheduledAt === null) {
    return { error: `nothing is scheduled for "${r.title}", so there is no chase to move into this reply` }
  }

  const now = Date.now()
  if (now - lastRaisedFor(open) < TACK_ON_COOLDOWN_MS) {
    return {
      error:
        'you have already raised something with them recently — one per reply, and not every reply. ' +
        'Answer them and leave this one alone.',
    }
  }

  // IT MUST BE THIS TURN'S CANDIDATE, and the tool enforces that rather than asking the model to.
  //
  // Every clause in `tackOnCandidate` removes a case where tacking on would ADD a message instead of
  // moving one: nothing scheduled means nothing to replace; the rung has to be within six hours; it
  // is never the first thing Otto ever says about a reminder, because that instant is the one
  // `timing` exists to choose. None of that was enforced here — the tool took any open reminder id
  // and spent its rung — so all of it rested on the model picking the id it was given, three
  // thousand tokens earlier in the prompt, every time.
  //
  // Recomputed rather than compared against what the prompt was built from: the two are one line
  // apart in `renderTackOn`, and recomputing is what makes a rung fired in between a refusal rather
  // than a race.
  const candidate = tackOnCandidate(device, now)
  if (candidate === null || candidate.reminder.reminderId !== reminderId) {
    return {
      error:
        `"${r.title}" is not this turn's tack-on — leave it out of this reply. ` +
        (candidate === null
          ? 'There is nothing to tack on this turn.'
          : `The one you were given is "${candidate.reminder.title}" [${candidate.reminder.reminderId}].`),
    }
  }

  const nextRung = nextNagAt(ladderParams(device, r, r.nagCount + 1, now))

  // The same guarded claim `runNudge` makes, against the same three columns, so the two paths are
  // indistinguishable to the ladder and cannot both spend the same rung.
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
    // The scheduler fired this rung between the prompt being built and the tool being called. The
    // wording matters: the model must NOT mention it, or the owner is asked the same thing twice.
    return { error: `"${r.title}" was chased by something else just now — leave it out of this reply` }
  }

  // The idiom from brief.ts: cancel the job row for the rung just spent and enqueue the next one.
  //
  // `supersedePending` is DELIBERATELY NOT here any more. It retired any nudge already queued but
  // not yet delivered, on the grounds that the reply replaces it — but this tool spends its rung
  // before the reply exists, and nothing verifies the model then actually mentions the thing. So a
  // turn that called the tool and then wrote a reply without the tack-on left the owner with no
  // message at all: the rung burned, the queued nudge dropped, and `nagCount` claiming they had
  // been asked. Dropping a message that is already written and waiting is the one irreversible half
  // of this operation, and it is not worth the duplicate it avoids — a queued nudge saying the same
  // thing is a repetition, which is recoverable; silence is not.
  cancelNudges(reminderId)
  if (nextRung !== null) enqueueJob('nudge', nextRung, { reminderId, deviceId: device.deviceId })
  log.info({ reminderId, rung: r.nagCount + 1, nextRung }, 'chase moved into a reply')

  return {
    reminderId,
    title: r.title,
    // The PRE-increment snapshot, exactly as runNudge composes from `before`: this describes what
    // Otto is entitled to say now, not what it will be entitled to say next time.
    evidence: reminderEvidence(r, device.timezone, now, leadCountFor(device, r)),
    timesRaised: r.nagCount + 1,
    overdue: r.dueAtMillis !== null && r.dueAtMillis < now,
    replacedChaseAtLocal: epochMillisToLocalHuman(scheduledAt, device.timezone),
    nextChaseLocal: nextRung === null ? null : epochMillisToLocalHuman(nextRung, device.timezone),
    // Not decoration: a tack-on can legitimately spend the LAST rung of a ladder, and Otto should
    // be able to say "that's the last I'll bring it up unless you tell me otherwise" rather than
    // going quiet about it with no explanation.
    ...(nextRung === null ? { chasesNothingScheduled: true as const } : {}),
    reminder: 'nothing sends this — it only reaches them if you actually say it in your reply',
  }
}
