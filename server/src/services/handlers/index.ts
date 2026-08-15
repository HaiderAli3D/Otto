import { runBrief, seedBrief } from './brief.js'
import { runLeaveBy } from './leaveBy.js'
import { runOutboxFlush, seedOutboxFlush } from './outboxFlush.js'
import type { DeviceSeeder, GlobalSeeder } from './types.js'
import { runWakeCheck } from './wakeCheck.js'
import { runWeeklyReview, seedWeeklyReview } from './weeklyReview.js'

export { runBrief, runLeaveBy, runOutboxFlush, runWakeCheck, runWeeklyReview }
export type { DeviceSeeder, GlobalSeeder, JobHandler, JobOutcome } from './types.js'

/**
 * Every per-device recurring chain, pre-registered.
 *
 * This array is COMPLETE as of Phase 0 and must not need editing again: each entry is a no-op until
 * the branch that owns its module fills the body in. That is the whole point — three Phase 1
 * branches each need a per-device chain, and if they all had to add a line to one array (or to
 * `seedSchedulerJobs`) that shared hunk would conflict three ways for no reason.
 *
 * `leave_by` and `wake_check` are deliberately absent: those are per-EVENT chains enqueued in
 * response to something (a calendar event, a dismissed alarm), not standing per-device ones, so
 * they have no first job to seed.
 */
export const DEVICE_SEEDERS: DeviceSeeder[] = [seedBrief, seedWeeklyReview]

/** Chains with exactly one instance for the whole server, rather than one per device. */
export const GLOBAL_SEEDERS: GlobalSeeder[] = [seedOutboxFlush]
