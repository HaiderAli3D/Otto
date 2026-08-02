import { log } from '../lib/log.js'
import { ARM_ACK_TIMEOUT_MS, advanceRecurrence, getAlarm, pushArm } from '../services/alarms.js'
import { getDevice, listDevices } from '../services/devices.js'
import { collectGarbage } from '../services/gc.js'
import {
  DEVICE_SEEDERS,
  GLOBAL_SEEDERS,
  type JobOutcome,
  runBrief,
  runLeaveBy,
  runOutboxFlush,
  runWakeCheck,
  runWeeklyReview,
} from '../services/handlers/index.js'
import { deleteJob, dueJobs, enqueueJob, ensureSingletonJob, rescheduleJob, type Job } from '../services/jobs.js'
import { runNudge } from '../services/nagging.js'
import { enqueueOutbound } from '../services/outbox.js'
import { epochMillisToLocalHuman } from '../services/time.js'

const TICK_MS = 15_000
const MAX_ARM_ACK_ATTEMPTS = 3
const GC_INTERVAL_MS = 6 * 60 * 60 * 1000
const GC_FIRST_RUN_MS = 60_000

/** Exported so a test can drive one job to completion without waiting on the 15s tick. */
export async function runJob(job: Job): Promise<void> {
  switch (job.kind) {
    case 'arm_ack': {
      if (!job.alarmId || !job.deviceId) return deleteJob(job.id)
      const alarm = getAlarm(job.alarmId)
      const device = getDevice(job.deviceId)
      // Acked (watchdog cancelled), cancelled, or fired ⇒ nothing to do.
      if (!alarm || alarm.state !== 'ARMED' || !device) return deleteJob(job.id)
      const nextAttempt = job.attempts + 1
      if (nextAttempt > MAX_ARM_ACK_ATTEMPTS) {
        log.warn({ alarmId: job.alarmId }, 'arm-ack: gave up after max attempts (device may be offline)')
        // Tell the owner their confirmed alarm was never acked by the phone. Goes through the
        // outbox like every other non-reply message, so it respects the 24h window and survives
        // being generated while the owner is unreachable.
        if (device.whatsappNumber) {
          const when = epochMillisToLocalHuman(alarm.triggerAtMillis, device.timezone)
          enqueueOutbound({
            waUserId: device.whatsappNumber,
            deviceId: device.deviceId,
            kind: 'system_warning',
            body: `⚠️ I couldn't confirm your alarm "${alarm.label}" (${when}) reached your phone. Open the Otto app to make sure it's set.`,
            dedupeKey: `armack:${job.alarmId}`,
          })
        }
        return deleteJob(job.id)
      }
      log.info({ alarmId: job.alarmId, attempt: nextAttempt }, 'arm-ack: no ARMED report yet; resending')
      await pushArm(device, alarm)
      rescheduleJob(job.id, nextAttempt, Date.now() + ARM_ACK_TIMEOUT_MS)
      return
    }
    case 'recurring': {
      // Backstop: the phone never reported DISMISSED/MISSED for this occurrence (offline,
      // uninstalled, lost push). If the series rule is still unclaimed, advance it here so the
      // next occurrence still gets armed. advanceRecurrence's guarded claim makes this a no-op
      // when the event-driven path already advanced.
      if (job.alarmId) {
        const alarm = getAlarm(job.alarmId)
        if (alarm?.recurrence && alarm.state !== 'CANCELLED') {
          await advanceRecurrence(job.alarmId)
        }
      }
      return deleteJob(job.id)
    }
    case 'nudge': {
      if (!job.reminderId) return deleteJob(job.id)
      await runNudge(job.reminderId)
      return deleteJob(job.id)
    }
    case 'gc': {
      collectGarbage()
      // A device paired since the last restart has no chains yet, and there is no pairing-time
      // hook. Re-seeding here picks it up within the gc interval without coupling devices.ts to
      // the scheduler. Idempotent, so this is free for devices that already have theirs.
      seedSchedulerJobs()
      deleteJob(job.id)
      enqueueJob('gc', Date.now() + GC_INTERVAL_MS)
      return
    }
    // Feature handlers. Each owns its own module (services/handlers/) so a feature branch never
    // edits this switch. The contract is `settle`: the handler returns when it should next run and
    // the scheduler moves THIS row, so a recurring chain has no crash window in which it vanishes.
    case 'outbox_flush':
      return settle(job, await runOutboxFlush(job))
    case 'brief':
      return settle(job, await runBrief(job))
    case 'leave_by':
      return settle(job, await runLeaveBy(job))
    case 'weekly_review':
      return settle(job, await runWeeklyReview(job))
    case 'wake_check':
      return settle(job, await runWakeCheck(job))
    // Still dropped rather than retried forever — a poison row must not block the queue — but never
    // silently: a rollback that removes a handler would otherwise eat every job of that kind with
    // no trace at all, and the only symptom would be a feature quietly not happening.
    default:
      log.warn({ kind: job.kind, id: job.id }, 'scheduler: unknown job kind, dropping')
      return deleteJob(job.id)
  }
}

/**
 * Apply a feature handler's outcome to its own job row.
 *
 * A number reschedules THIS row, so a recurring chain is never absent even for an instant; null
 * ends the chain. The alternative — delete then enqueue — has a crash window that loses the chain
 * permanently, which is the failure mode `arm_ack` already goes out of its way to avoid.
 *
 * Exported for the same reason `runJob` is: this is the contract four feature branches build on and
 * it deserves a direct test, rather than one that reaches it through a mocked handler module.
 */
export function settle(job: Job, next: JobOutcome): void {
  if (next === null) return deleteJob(job.id)
  rescheduleJob(job.id, 0, next)
}

/**
 * Seed every standing chain: the global housekeeping ones, and each feature's per-device chain.
 * Idempotent, and that is the entire point.
 *
 * `startScheduler` runs on every process start while `case 'gc'` re-enqueues itself, so the bare
 * `enqueueJob('gc', ...)` this replaced forked a NEW self-perpetuating chain on every boot: after
 * ten restarts the queue held ten parallel gc chains, each one immortal, and nothing ever pruned
 * them. `ensureSingletonJob` both refuses to add a second chain and collapses any already forked.
 *
 * The seeders come from `handlers/index.ts` rather than being listed here, so a feature branch adds
 * its chain by filling in the stub it already owns — no shared hunk, no three-way conflict.
 */
export function seedSchedulerJobs(): void {
  const now = Date.now()
  ensureSingletonJob('gc', now + GC_FIRST_RUN_MS)
  for (const seed of GLOBAL_SEEDERS) seed(now)
  const devices = listDevices()
  for (const device of devices) {
    for (const seed of DEVICE_SEEDERS) seed(device, now)
  }
}

/** In-process durable scheduler: polls the SQLite job queue and runs due jobs. */
export function startScheduler(): void {
  let running = false
  const tick = async (): Promise<void> => {
    for (const job of dueJobs(Date.now())) {
      await runJob(job).catch((e) => log.error({ err: e, jobId: job.id }, 'job failed'))
    }
  }
  setInterval(() => {
    // Skip if the previous tick is still running so a slow job (e.g. a stalled FCM send) can't
    // let overlapping ticks re-read and double-process the same due jobs.
    if (running) return
    running = true
    void tick()
      .catch((e) => log.error(e, 'scheduler tick error'))
      .finally(() => {
        running = false
      })
  }, TICK_MS)
  // Self-rescheduling housekeeping jobs. Seeded at most once ever; each run queues the next.
  seedSchedulerJobs()
  log.info({ tickMs: TICK_MS }, 'Scheduler started')
}
