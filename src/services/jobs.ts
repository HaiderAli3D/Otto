import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { jobs } from '../db/schema.js'

export type Job = typeof jobs.$inferSelect

/**
 * Every kind the scheduler routes. Declared here in full rather than grown per feature branch, so
 * that four branches can add handlers without four conflicting edits to the same union.
 *
 * There is deliberately NO 'digest' member: it had no producer and no handler, and the scheduler's
 * `default:` branch silently deleted anything that reached it — a kind in the type with nothing
 * behind it is a trap that reads as supported.
 */
export type JobKind =
  | 'arm_ack'
  | 'recurring'
  | 'nudge'
  | 'gc'
  | 'outbox_flush'
  | 'brief'
  | 'leave_by'
  | 'weekly_review'
  | 'wake_check'

/** Bound one tick's work: after downtime the backlog can be large and is processed serially. */
const DUE_JOBS_LIMIT = 50

export function enqueueJob(
  kind: JobKind,
  runAtMillis: number,
  opts: { alarmId?: string; reminderId?: string; deviceId?: string; payload?: unknown } = {},
): void {
  db.insert(jobs)
    .values({
      kind,
      runAtMillis,
      alarmId: opts.alarmId ?? null,
      reminderId: opts.reminderId ?? null,
      deviceId: opts.deviceId ?? null,
      payload: opts.payload === undefined ? null : JSON.stringify(opts.payload),
      attempts: 0,
      createdAt: Date.now(),
    })
    .run()
}

export function dueJobs(nowMillis: number): Job[] {
  return db
    .select()
    .from(jobs)
    .where(lte(jobs.runAtMillis, nowMillis))
    .orderBy(asc(jobs.runAtMillis))
    .limit(DUE_JOBS_LIMIT)
    .all()
}

export function deleteJob(id: number): void {
  db.delete(jobs).where(eq(jobs.id, id)).run()
}

/** Drop pending jobs of a kind for an alarm (e.g. cancel the arm-ack watchdog once acked). */
export function cancelJobs(kind: JobKind, alarmId: string): void {
  db.delete(jobs).where(and(eq(jobs.kind, kind), eq(jobs.alarmId, alarmId))).run()
}

/** Drop every pending nudge for a reminder — called the moment it is completed or cancelled. */
export function cancelNudges(reminderId: string): void {
  db.delete(jobs).where(and(eq(jobs.kind, 'nudge'), eq(jobs.reminderId, reminderId))).run()
}

/**
 * Drop pending jobs of a kind for a device. `cancelJobs` keys only on alarmId; this is its peer for
 * the device-scoped recurring chains (a brief, a wake check) that have no alarm behind them.
 */
export function cancelJobsForDevice(kind: JobKind, deviceId: string): void {
  db.delete(jobs).where(and(eq(jobs.kind, kind), eq(jobs.deviceId, deviceId))).run()
}

/**
 * Ensure EXACTLY ONE pending job of this (kind, deviceId) exists.
 *
 * 0 rows ⇒ insert. 1 row ⇒ leave it alone, which is the whole point: a self-rescheduling chain has
 * already picked its next run time and re-seeding must not reset or duplicate it. >1 rows ⇒ collapse
 * to the LOWEST id, which heals chains that the old unconditional boot enqueue already forked.
 *
 * Read-then-write with NO await in between: better-sqlite3 is synchronous, so nothing can interleave
 * within this process. fly.toml pins `min_machines_running = 1` and `auto_stop_machines = false`, so
 * there is only ever one process — this is atomic in practice, not by construction. It breaks the day
 * anyone runs two machines: both would read 0 rows and both would insert. If this app is ever scaled
 * past one instance, this needs a real lock or a UNIQUE(kind, device_id) partial index.
 */
export function ensureSingletonJob(kind: JobKind, runAtMillis: number, opts: { deviceId?: string } = {}): void {
  const deviceId = opts.deviceId
  const scope = deviceId === undefined ? isNull(jobs.deviceId) : eq(jobs.deviceId, deviceId)
  const existing = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), scope))
    .orderBy(asc(jobs.id))
    .all()

  if (existing.length === 0) {
    enqueueJob(kind, runAtMillis, { deviceId })
    return
  }
  const duplicates = existing.slice(1).map((r) => r.id)
  if (duplicates.length > 0) db.delete(jobs).where(inArray(jobs.id, duplicates)).run()
}

/**
 * Read the `payload` column back as a typed object.
 *
 * The first reader this column has ever had — every producer writes it and nothing has read it.
 * Returns null for an absent or corrupt value rather than throwing: a malformed payload must not be
 * able to wedge the scheduler into throwing on the same job every 15 seconds forever.
 */
export function jobPayload<T>(job: Job): T | null {
  if (job.payload === null) return null
  try {
    return JSON.parse(job.payload) as T
  } catch {
    return null
  }
}

export function rescheduleJob(id: number, attempts: number, nextRunAtMillis: number): void {
  db.update(jobs).set({ attempts, runAtMillis: nextRunAtMillis }).where(eq(jobs.id, id)).run()
}
