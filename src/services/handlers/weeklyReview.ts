// Owned by the WEEKLY REVIEW feature branch.
// Phase 0 seam: the scheduler already routes 'weekly_review' here and `handlers/index.ts` already
// registers `seedWeeklyReview`, so that branch fills in this file and never touches the switch in
// scheduler/loop.ts or the seeder registry.
import { log } from '../../lib/log.js'
import type { Device } from '../devices.js'
import type { Job } from '../jobs.js'
import type { JobOutcome } from './types.js'

/**
 * Return next week's instant to keep the chain alive, or null to end it. Do NOT delete or
 * re-enqueue the job yourself — the scheduler reschedules this same row.
 */
export async function runWeeklyReview(job: Job): Promise<JobOutcome> {
  log.debug({ jobId: job.id, deviceId: job.deviceId }, 'weekly_review: Phase 0 stub, nothing to do yet')
  return null
}

/** Idempotent; runs on every boot and after every gc pass. See DeviceSeeder in ./types.ts. */
export function seedWeeklyReview(_device: Device, _nowMillis: number): void {
  // Phase 0 stub. The review branch calls ensureSingletonJob('weekly_review', nextReviewAt(...), { deviceId }).
}
