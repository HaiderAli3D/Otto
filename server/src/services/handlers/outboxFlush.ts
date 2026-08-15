// Owned by the OUTBOX RETRY / WINDOW-EXPIRY feature branch.
// Phase 0 seam: the scheduler already routes 'outbox_flush' here and `handlers/index.ts` already
// registers `seedOutboxFlush`, so this branch fills in this file and never touches the switch in
// scheduler/loop.ts or the seeder registry.
//
// This chain is GLOBAL, not per-device: one sweep visits every device, because the point is to
// drain queued messages on a wall clock rather than to track any one owner.
import { log } from '../../lib/log.js'
import { ensureSingletonJob, type Job } from '../jobs.js'
import { sweepOutbox } from '../outbox.js'
import type { JobOutcome } from './types.js'

/**
 * How often the queue is swept.
 *
 * The queue is normally drained on contact, so this is the backstop for everything that happens
 * while nobody is talking: a window that reopened for some other reason, a row whose TTL ran out,
 * and the template knock. Five minutes is short enough that a reopened window is used almost
 * immediately and long enough that a shut one costs nothing — `shouldKnock` short-circuits before
 * any network call, so an idle sweep is a couple of SQLite reads.
 */
export const OUTBOX_FLUSH_INTERVAL_MS = 5 * 60 * 1000

/**
 * Return the next sweep instant to keep the chain alive, or null to end it. Do NOT delete or
 * re-enqueue the job yourself — the scheduler reschedules this same row.
 *
 * ALWAYS returns a time: this chain has no terminating condition, and ending it would silently turn
 * off every proactive delivery until the next restart. A sweep that throws is logged and the chain
 * carries on for the same reason.
 */
export async function runOutboxFlush(job: Job): Promise<JobOutcome> {
  try {
    await sweepOutbox(Date.now())
  } catch (err) {
    log.warn({ err, jobId: job.id }, 'outbox sweep failed; chain continues')
  }
  // Measured from AFTER the work, not from the scheduled time: a slow sweep must not queue the next
  // one in the past and spin.
  return Date.now() + OUTBOX_FLUSH_INTERVAL_MS
}

/** Idempotent; runs on every boot and after every gc pass. See GlobalSeeder in ./types.ts. */
export function seedOutboxFlush(nowMillis: number): void {
  // No deviceId — one sweep for the whole server. `ensureSingletonJob` leaves a live chain's own
  // next run time alone, so a restart never drags the sweep forward or forks a second one.
  ensureSingletonJob('outbox_flush', nowMillis + OUTBOX_FLUSH_INTERVAL_MS)
}
