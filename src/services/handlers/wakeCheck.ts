// Owned by the WAKE-CHECK / DID-YOU-ACTUALLY-GET-UP feature branch.
// Phase 0 seam: the scheduler already routes 'wake_check' here, so that branch fills in this file
// and never has to touch the switch in scheduler/loop.ts.
//
// No seeder: this chain starts from a DISMISSED alarm event, not at boot, so there is nothing to
// seed per device. Returning the next round's instant is how the ladder advances.
import type { Job } from '../jobs.js'
import { runWakeCheck as runRound } from '../wakeCheck.js'
import type { JobOutcome } from './types.js'

/**
 * Return the next wake-check round's instant, or null when the ladder is finished (answered, or
 * escalated to a backup alarm). Do NOT delete or re-enqueue the job yourself — the scheduler
 * settles this same row.
 *
 * A thin adapter on purpose: the ladder lives in services/wakeCheck.ts next to the other two entry
 * points it shares state with (`scheduleWakeCheck` from the device route, `cancelWakeChecks` from
 * the webhook), so all three read as one feature instead of one being stranded under handlers/.
 */
export async function runWakeCheck(job: Job): Promise<JobOutcome> {
  return runRound(job)
}
