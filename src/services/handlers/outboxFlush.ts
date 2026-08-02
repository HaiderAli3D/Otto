// Owned by the OUTBOX RETRY / WINDOW-EXPIRY feature branch.
// Phase 0 seam: the scheduler already routes 'outbox_flush' here and `handlers/index.ts` already
// registers `seedOutboxFlush`, so that branch fills in this file and never touches the switch in
// scheduler/loop.ts or the seeder registry.
//
// This chain is GLOBAL, not per-device: one sweep visits every device, because the point is to
// drain queued messages on a wall clock rather than to track any one owner.
import { log } from '../../lib/log.js'
import type { Job } from '../jobs.js'
import type { JobOutcome } from './types.js'

/**
 * Return the next sweep instant to keep the chain alive, or null to end it. Do NOT delete or
 * re-enqueue the job yourself — the scheduler reschedules this same row.
 */
export async function runOutboxFlush(job: Job): Promise<JobOutcome> {
  log.debug({ jobId: job.id }, 'outbox_flush: Phase 0 stub, nothing to do yet')
  return null
}

/** Idempotent; runs on every boot and after every gc pass. See GlobalSeeder in ./types.ts. */
export function seedOutboxFlush(_nowMillis: number): void {
  // Phase 0 stub. That branch calls ensureSingletonJob('outbox_flush', now + OUTBOX_FLUSH_INTERVAL_MS).
}
