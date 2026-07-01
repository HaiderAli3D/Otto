import { log } from '../lib/log.js'
import { ARM_ACK_TIMEOUT_MS, advanceRecurrence, getAlarm, pushArm } from '../services/alarms.js'
import { getDevice } from '../services/devices.js'
import { deleteJob, dueJobs, rescheduleJob, type Job } from '../services/jobs.js'

const TICK_MS = 15_000
const MAX_ARM_ACK_ATTEMPTS = 3

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
    // 'nudge' is reserved for future calendar/reminder features; drop unknowns safely.
    default:
      return deleteJob(job.id)
  }
}

/** In-process durable scheduler: polls the SQLite job queue and runs due jobs. */
export function startScheduler(): void {
  const tick = async (): Promise<void> => {
    for (const job of dueJobs(Date.now())) {
      await runJob(job).catch((e) => log.error({ err: e, jobId: job.id }, 'job failed'))
    }
  }
  setInterval(() => void tick().catch((e) => log.error(e, 'scheduler tick error')), TICK_MS)
  log.info({ tickMs: TICK_MS }, 'Scheduler started')
}
