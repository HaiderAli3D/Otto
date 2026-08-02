// Owned by the LEAVE-BY / TRAVEL-TIME feature branch.
// Phase 0 seam: the scheduler already routes 'leave_by' here, so that branch fills in this file and
// never has to touch the switch in scheduler/loop.ts.
//
// No seeder: this is a per-EVENT chain, enqueued when a leave-by alarm is armed, not a standing
// per-device one. It has no first job to seed at boot.
import { log } from '../../lib/log.js'
import type { Job } from '../jobs.js'
import type { JobOutcome } from './types.js'

/**
 * Return a later recheck instant to keep this event's chain alive, or null when the recheck is
 * done. Do NOT delete or re-enqueue the job yourself — the scheduler settles this same row.
 */
export async function runLeaveBy(job: Job): Promise<JobOutcome> {
  log.debug({ jobId: job.id, deviceId: job.deviceId }, 'leave_by: Phase 0 stub, nothing to do yet')
  return null
}
