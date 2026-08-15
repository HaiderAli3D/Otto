import type { Device } from '../devices.js'
import type { Job } from '../jobs.js'

/**
 * What a feature handler tells the scheduler to do with the job row it just ran.
 *
 * A number keeps the chain alive: the scheduler reschedules the SAME row to that instant, so there
 * is never a window in which the chain does not exist. `null` ends it and the row is deleted.
 *
 * Returning the next time rather than enqueueing it yourself is deliberate — `deleteJob` followed
 * by `enqueueJob` has a crash window that loses a recurring chain permanently, which is the bug
 * the boot-time `gc` seeding used to have in the other direction.
 */
export type JobOutcome = number | null

export type JobHandler = (job: Job) => Promise<JobOutcome>

/**
 * Seeds the FIRST job of a per-device recurring chain. Must be idempotent — it runs on every boot
 * and after every `gc` pass, so a device paired since the last restart picks its chain up within
 * the hour without any pairing-time hook. Use `ensureSingletonJob(kind, at, { deviceId })`.
 *
 * Each feature owns one of these in its own handler module and they are ALL pre-registered in
 * `handlers/index.ts`, so a Phase 1 branch fills in a body it alone owns and never edits a shared
 * array. Same trick as the handler stubs, for the same reason.
 */
export type DeviceSeeder = (device: Device, nowMillis: number) => void

/** Seeds a chain that is not per-device (there is one of it, for the whole server). */
export type GlobalSeeder = (nowMillis: number) => void
