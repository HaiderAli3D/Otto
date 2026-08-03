import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { jobs } from '../db/schema.js'
import { newAlarmId } from '../lib/ids.js'
import { log } from '../lib/log.js'
import { MAX_WAKE_ROUNDS, wakeCheckAt, wakeText } from '../lib/wakeLadder.js'
import { armAlarm, getAlarm, recordServerEvent } from './alarms.js'
import { getDevice, type Device } from './devices.js'
import { cancelJobs, cancelJobsForDevice, enqueueJob, jobPayload, type Job } from './jobs.js'
import { enqueueAndTryFlush, windowOpen } from './outbox.js'

/**
 * "You up?" — the follow-up for an alarm whose job was getting the owner out of bed.
 *
 * Opt-in per alarm (`alarms.wake_check`), and deliberately narrow. It hangs off DISMISSED and
 * nothing else: MISSED means they never touched the phone, which is a different problem the ringer
 * has already given up on, and a reminder that rings already has the nag ladder behind it. Keeping
 * it to "an alarm you swiped away, that you asked me to check on" is the whole reason it is not
 * obnoxious.
 *
 * Quiet hours do NOT apply anywhere in this module. A 06:30 wake-check inside a 22:00–07:00 window
 * is the entire point of the feature; suppressing it would leave the owner asleep and the alarm
 * dismissed. It is its own job kind and never routes through `nextNagAt` or `runNudge`, which is
 * what makes that structural rather than a rule someone has to remember.
 */

/** A wake-check delivered three hours late is absurd — it answers a question nobody is asking. */
const WAKE_TTL_MS = 45 * 60 * 1000

/** Far enough out that the ARM push can land, close enough that it is still a wake-up. */
const BACKUP_ALARM_DELAY_MS = 60_000

export type WakePayload = { round: number; startedAt: number }

/**
 * Start the ladder for a dismissed alarm. No-op unless the alarm opted in.
 *
 * A SNOOZE never reaches here: `recordEvent` excludes SNOOZED from STATE_EVENTS because the app
 * re-arms and reports ARMED again, so the only DISMISSED an alarm ever produces is the final one.
 * The check therefore starts when they actually got rid of it, not on the first swipe.
 *
 * Keyed on the ALARM, not on an owning reminder, so a standalone wake-up alarm works too.
 */
export function scheduleWakeCheck(alarmId: string, device: Device, dismissedAtMillis: number): boolean {
  const alarm = getAlarm(alarmId)
  if (!alarm || !alarm.wakeCheck) return false

  // At-least-once guard, keyed on the DISMISSAL rather than on the alarm.
  //
  // `recordEvent` refuses to re-apply side effects for a report it has already seen, but this hook
  // hangs off the device route OUTSIDE that guard. So when the app's outbox retries a DISMISSED it
  // never got a 204 for — same alarmId, same atMillis — we used to land here again mid-ladder,
  // delete the live chain and re-anchor round 0 at an instant already minutes in the past, which
  // the next tick fires immediately: "You up?" a second time, all three rounds re-walked, and a
  // second backup alarm armed.
  //
  // Latching on (alarm, WAKE_CHECK_STARTED, dismissedAt) is one guarded INSERT against the
  // alarm_events dedupe index, and it OUTLIVES the ladder — a replay arriving after the chain has
  // already escalated and deleted its job is a no-op too, which a "is there a live job?" check
  // could not see. A genuinely new dismissal of the same alarm carries a different instant, so it
  // still claims the latch and still replaces the chain below.
  //
  // `signals` counts alarm_events by exact event string, so this row is invisible to the record.
  if (!recordServerEvent(device.deviceId, alarmId, 'WAKE_CHECK_STARTED', dismissedAtMillis)) {
    log.debug({ alarmId, dismissedAtMillis }, 'wake-check already started for this dismissal; ignoring the re-delivery')
    return false
  }

  // Replace any ladder already running for this alarm rather than forking a second one — a
  // re-delivered DISMISSED must not double the messages.
  cancelJobs('wake_check', alarmId)
  const payload: WakePayload = { round: 0, startedAt: dismissedAtMillis }
  enqueueJob('wake_check', wakeCheckAt(0, dismissedAtMillis), { alarmId, deviceId: device.deviceId, payload })
  log.info({ alarmId, deviceId: device.deviceId }, 'wake-check armed after dismissal')
  return true
}

/**
 * ANY inbound message ends the ladder.
 *
 * Not just "yes" or a reply to the check — being awake enough to send anything at all is exactly
 * the question being asked, so a voice note counts. Called from the webhook right after
 * `markInbound` and before the non-text early return, for that reason.
 */
export function cancelWakeChecks(deviceId: string): void {
  cancelJobsForDevice('wake_check', deviceId)
}

/**
 * One round. Returns the next round's instant, or null when the ladder is over (answered, or
 * escalated to a ringing backup alarm). Never touches its own job row's existence — the scheduler
 * settles it.
 */
export async function runWakeCheck(job: Job): Promise<number | null> {
  if (!job.alarmId || !job.deviceId) return null
  const payload = jobPayload<WakePayload>(job)
  const round = payload?.round ?? 0
  const startedAt = payload?.startedAt ?? job.createdAt

  const device = getDevice(job.deviceId)
  if (!device) return null

  // Re-checked here as well as at the cancel hook: an inbound that lands mid-tick would otherwise
  // race the delete and get one more "you up?" after they already answered.
  if (device.lastInboundAt !== null && device.lastInboundAt >= startedAt) {
    log.info({ alarmId: job.alarmId, round }, 'wake-check answered by an inbound; standing down')
    return null
  }

  const label = getAlarm(job.alarmId)?.label ?? 'Your alarm'
  const waUserId = device.whatsappNumber

  // Out of rounds, no chat channel at all, or a shut 24h window: the ringer is the only thing left.
  // Going straight there when the window is shut is deliberate — three undeliverable messages
  // followed by a ring half an hour later is strictly worse than the ring at twelve minutes.
  if (round >= MAX_WAKE_ROUNDS || !waUserId || !windowOpen(device)) {
    // `round` doubles as "how many rounds actually went out": it is advanced immediately before
    // each send, and only after the window check below. escalate needs that to tell an unanswered
    // check apart from one that was never asked.
    await escalate(device, job.alarmId, label, round)
    return null
  }

  const next = round + 1
  // Advance the round BEFORE the send: the scheduler's `settle` only moves `runAtMillis`, so the
  // payload is this module's to maintain, and writing it ahead of the await leaves no window in
  // which a crash replays the same round forever.
  const advanced: WakePayload = { round: next, startedAt }
  db.update(jobs).set({ payload: JSON.stringify(advanced) }).where(eq(jobs.id, job.id)).run()

  await enqueueAndTryFlush({
    waUserId,
    deviceId: device.deviceId,
    kind: 'wake_check',
    body: wakeText(round, label),
    dedupeKey: `wake:${job.alarmId}:${round}`,
    ttlMs: WAKE_TTL_MS,
  })
  return wakeCheckAt(next, startedAt)
}

/**
 * Nothing got through. Ring the phone once more and put it on the record.
 *
 * The backup alarm carries `wakeCheck: false`, and that is LOAD-BEARING: it will be dismissed too,
 * and a wake-check on it would start a second ladder, which would arm a third alarm, forever.
 *
 * `roundsDelivered` decides WHICH row goes on the record, and the distinction is not cosmetic.
 * `WAKE_CHECK_FAILED` is read back to the owner as evidence — `signals.renderRecord` renders it as
 * "dismissed and went back to sleep N×" in the conversational prompt, and the weekly review says
 * "N dismissed then back to sleep". Round 0 escalates straight to the ringer when the 24h window is
 * shut or no number is linked, and in that case not one message was ever sent: the owner who got up
 * perfectly normally would be accused, on the permanent record, of sleeping through a question
 * nobody asked them. The persona forbids exactly that ("the numbers below are the whole of your
 * evidence"). The RING is still right — a shut window is not a reason to leave someone asleep — so
 * only the row changes. A distinct kind keeps the audit trail while staying invisible to both
 * surfaces, which count by exact event string.
 */
async function escalate(device: Device, alarmId: string, label: string, roundsDelivered: number): Promise<void> {
  const now = Date.now()
  const backupAlarmId = newAlarmId()
  await armAlarm(device, {
    alarmId: backupAlarmId,
    triggerAtMillis: now + BACKUP_ALARM_DELAY_MS,
    label: `Still asleep? — ${label}`,
    recurrence: null,
    wakeCheck: false,
  })
  const asked = roundsDelivered > 0
  recordServerEvent(device.deviceId, alarmId, asked ? 'WAKE_CHECK_FAILED' : 'WAKE_CHECK_UNREACHABLE', now)
  log.warn(
    { alarmId, backupAlarmId, roundsDelivered },
    asked ? 'wake-check went unanswered; ringing a backup alarm' : 'wake-check could not be sent at all; ringing a backup alarm',
  )
}
