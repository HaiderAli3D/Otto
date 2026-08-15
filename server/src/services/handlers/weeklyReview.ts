// Owned by the WEEKLY REVIEW feature branch.
// Phase 0 seam: the scheduler already routes 'weekly_review' here and `handlers/index.ts` already
// registers `seedWeeklyReview`, so that branch fills in this file and never touches the switch in
// scheduler/loop.ts or the seeder registry.
import { log } from '../../lib/log.js'
import { getDevice, type Device } from '../devices.js'
import { cancelJobsForDevice, ensureSingletonJob, type Job } from '../jobs.js'
import { deliverWeeklyReview, nextWeeklyReviewAt } from '../weeklyReview.js'
import type { JobOutcome } from './types.js'

/**
 * Return next week's instant to keep the chain alive, or null to end it. Do NOT delete or
 * re-enqueue the job yourself — the scheduler reschedules this same row.
 *
 * The delivery itself is awaited rather than fired and forgotten: every guard inside it is cheap,
 * the composer falls back deterministically, and letting it settle before the row is moved keeps
 * "sent" and "next run" in one consistent step.
 */
export async function runWeeklyReview(job: Job): Promise<JobOutcome> {
  if (!job.deviceId) return null
  const device = getDevice(job.deviceId)
  // The device is gone; so is its chain. `seedWeeklyReview` re-creates one if it ever comes back.
  if (!device) return null

  const now = Date.now()
  await deliverWeeklyReview(device, job.runAtMillis, now).catch((err) =>
    log.error({ err, deviceId: device.deviceId }, 'weekly review failed'),
  )
  // Recomputed AFTER the run, from the live settings, so moving the slot mid-week takes effect on
  // the next hop and switching reviews off ends the chain rather than leaving a dead row cycling.
  return nextWeeklyReviewAt(device, now)
}

/** Idempotent; runs on every boot and after every gc pass. See DeviceSeeder in ./types.ts. */
export function seedWeeklyReview(device: Device, nowMillis: number): void {
  const at = nextWeeklyReviewAt(device, nowMillis)
  if (at === null) {
    // Reviews are off for this device. Clear any chain a previous setting left behind — this runs
    // after every gc pass, so it is also how "turn the weekly review off" eventually takes hold.
    cancelJobsForDevice('weekly_review', device.deviceId)
    return
  }
  ensureSingletonJob('weekly_review', at, { deviceId: device.deviceId })
}
