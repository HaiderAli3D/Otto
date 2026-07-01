import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { jobs } from '../db/schema.js'

export type Job = typeof jobs.$inferSelect
export type JobKind = 'arm_ack' | 'recurring' | 'nudge'

export function enqueueJob(
  kind: JobKind,
  runAtMillis: number,
  opts: { alarmId?: string; deviceId?: string; payload?: unknown } = {},
): void {
  db.insert(jobs)
    .values({
      kind,
      runAtMillis,
      alarmId: opts.alarmId ?? null,
      deviceId: opts.deviceId ?? null,
      payload: opts.payload === undefined ? null : JSON.stringify(opts.payload),
      attempts: 0,
      createdAt: Date.now(),
    })
    .run()
}

export function dueJobs(nowMillis: number): Job[] {
  return db.select().from(jobs).where(lte(jobs.runAtMillis, nowMillis)).orderBy(asc(jobs.runAtMillis)).all()
}

export function deleteJob(id: number): void {
  db.delete(jobs).where(eq(jobs.id, id)).run()
}

/** Drop pending jobs of a kind for an alarm (e.g. cancel the arm-ack watchdog once acked). */
export function cancelJobs(kind: JobKind, alarmId: string): void {
  db.delete(jobs).where(and(eq(jobs.kind, kind), eq(jobs.alarmId, alarmId))).run()
}

export function rescheduleJob(id: number, attempts: number, nextRunAtMillis: number): void {
  db.update(jobs).set({ attempts, runAtMillis: nextRunAtMillis }).where(eq(jobs.id, id)).run()
}
