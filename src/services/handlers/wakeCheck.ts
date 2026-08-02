// Owned by the WAKE-CHECK / DID-YOU-ACTUALLY-GET-UP feature branch.
// Phase 0 seam: the scheduler already routes 'wake_check' here, so that branch fills in this file
// and never has to touch the switch in scheduler/loop.ts.
//
// No seeder: this chain starts from a DISMISSED alarm event, not at boot, so there is nothing to
// seed per device. Returning the next round's instant is how the ladder advances.
import { log } from '../../lib/log.js'
import type { Job } from '../jobs.js'
import type { JobOutcome } from './types.js'

/**
 * Return the next wake-check round's instant, or null when the ladder is finished (answered, or
 * escalated to a backup alarm). Do NOT delete or re-enqueue the job yourself — the scheduler
 * settles this same row.
 */
export async function runWakeCheck(job: Job): Promise<JobOutcome> {
  log.debug({ jobId: job.id, deviceId: job.deviceId }, 'wake_check: Phase 0 stub, nothing to do yet')
  return null
}
