import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { jobs } from '../db/schema.js'

export type Job = typeof jobs.$inferSelect
export type JobKind = 'arm_ack' | 'recurring' | 'nudge' | 'digest' | 'gc'

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

export function rescheduleJob(id: number, attempts: number, nextRunAtMillis: number): void {
  db.update(jobs).set({ attempts, runAtMillis: nextRunAtMillis }).where(eq(jobs.id, id)).run()
}
