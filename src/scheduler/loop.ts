import { log } from '../lib/log.js'
import { ARM_ACK_TIMEOUT_MS, advanceRecurrence, getAlarm, pushArm } from '../services/alarms.js'
import { getDevice } from '../services/devices.js'
import { collectGarbage } from '../services/gc.js'
import { deleteJob, dueJobs, enqueueJob, rescheduleJob, type Job } from '../services/jobs.js'
import { runNudge } from '../services/nagging.js'
import { enqueueOutbound } from '../services/outbox.js'
import { epochMillisToLocalHuman } from '../services/time.js'

const TICK_MS = 15_000
const MAX_ARM_ACK_ATTEMPTS = 3
const GC_INTERVAL_MS = 6 * 60 * 60 * 1000

async function runJob(job: Job): Promise<void> {
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
      deleteJob(job.id)
      enqueueJob('gc', Date.now() + GC_INTERVAL_MS)
      return
    }
    // Unknown kinds are dropped safely rather than retried forever.
    default:
      return deleteJob(job.id)
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
  // Self-rescheduling housekeeping job. Enqueued once on boot; each run queues the next.
  enqueueJob('gc', Date.now() + 60_000)
  log.info({ tickMs: TICK_MS }, 'Scheduler started')
}
