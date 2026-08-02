// Owned by the DAILY BRIEF feature branch.
// Phase 0 seam: the scheduler already routes 'brief' here and `handlers/index.ts` already registers
// `seedBrief`, so that branch fills in this file and never touches the switch in scheduler/loop.ts
// or the seeder registry — which is what makes the four Phase 1 branches mergeable in any order.
import { log } from '../../lib/log.js'
import type { Device } from '../devices.js'
import type { Job } from '../jobs.js'
import type { JobOutcome } from './types.js'

/**
 * Return the next brief instant to keep the chain alive, or null to end it. Do NOT delete or
 * re-enqueue the job yourself — the scheduler reschedules this same row, so the chain can never
 * fall through a crash window.
 */
export async function runBrief(job: Job): Promise<JobOutcome> {
  log.debug({ jobId: job.id, deviceId: job.deviceId }, 'brief: Phase 0 stub, nothing to do yet')
  return null
}

/** Idempotent; runs on every boot and after every gc pass. See DeviceSeeder in ./types.ts. */
export function seedBrief(_device: Device, _nowMillis: number): void {
  // Phase 0 stub. The brief branch calls ensureSingletonJob('brief', nextBriefRunAt(...), { deviceId }).
}
