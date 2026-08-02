import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { db, ensureSchema } from '../src/db/client.js'
import { jobs } from '../src/db/schema.js'
import { log } from '../src/lib/log.js'
import { runJob, seedSchedulerJobs, settle } from '../src/scheduler/loop.js'
import { dueJobs, enqueueJob, type Job, type JobKind } from '../src/services/jobs.js'

// Driven entirely through the exported runJob/seedSchedulerJobs — startScheduler is never called,
// so no 15s setInterval leaks into the vitest process and hangs the run.
beforeEach(() => {
  ensureSchema()
  db.delete(jobs).run()
  vi.restoreAllMocks()
})

const FAR_FUTURE = Date.now() + 365 * 24 * 3_600_000
const pending = (kind: string): Job[] => dueJobs(FAR_FUTURE).filter((j) => j.kind === kind)

/** Enqueue one job and hand back the row the scheduler would have picked up. */
const enqueueAndFetch = (kind: JobKind, opts: Parameters<typeof enqueueJob>[2] = {}): Job => {
  enqueueJob(kind, Date.now() - 1_000, opts)
  const job = pending(kind)[0]
  if (!job) throw new Error(`no ${kind} job was enqueued`)
  return job
}

describe('seedSchedulerJobs', () => {
  it('seeds one gc job on a fresh queue', () => {
    seedSchedulerJobs()
    expect(pending('gc')).toHaveLength(1)
  })

  it('called TWICE leaves exactly ONE pending gc job', () => {
    // THE regression test for the fork bug. startScheduler runs on every process start and case
    // 'gc' re-enqueues itself, so the old unconditional enqueueJob left one immortal gc chain per
    // restart, running in parallel forever. If this ever reads 2, that bug is back.
    seedSchedulerJobs()
    const first = pending('gc')[0]!
    seedSchedulerJobs()

    const after = pending('gc')
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(first.id)
  })

  it('heals a queue that a previous build already forked', () => {
    enqueueJob('gc', Date.now() + 60_000)
    enqueueJob('gc', Date.now() + 61_000)
    enqueueJob('gc', Date.now() + 62_000)
    seedSchedulerJobs()
    expect(pending('gc')).toHaveLength(1)
  })
})

describe('runJob', () => {
  it('drops an unknown kind and says so', async () => {
    // Deleting silently is how a rollback that removes a handler eats every job of that kind with
    // no trace — the only symptom being a feature that quietly stops happening.
    const warn = vi.spyOn(log, 'warn')
    const job = enqueueAndFetch('retired_kind' as JobKind)

    await runJob(job)

    expect(pending('retired_kind')).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatchObject({ kind: 'retired_kind', id: job.id })
  })

  it('deletes a nudge job that carries no reminderId', async () => {
    const job = enqueueAndFetch('nudge')
    await runJob(job)
    expect(pending('nudge')).toHaveLength(0)
  })

  it('deletes an arm_ack job that carries no alarmId or deviceId', async () => {
    const job = enqueueAndFetch('arm_ack')
    await runJob(job)
    expect(pending('arm_ack')).toHaveLength(0)
  })

  it('runs each Phase 0 handler stub and deletes the job afterwards', async () => {
    // The stubs all return null, which `settle` reads as "the chain is over" — so a deleted row here
    // is the CORRECT outcome for a stub, and becomes a rescheduled one as each feature lands.
    for (const kind of ['outbox_flush', 'brief', 'leave_by', 'weekly_review', 'wake_check'] as JobKind[]) {
      const job = enqueueAndFetch(kind, { deviceId: 'dev_sched' })
      await runJob(job)
      expect(pending(kind)).toHaveLength(0)
    }
  })
})

describe('the feature-handler settle contract', () => {
  // The seam four Phase 1 branches build on: a handler returns WHEN IT SHOULD NEXT RUN and the
  // scheduler moves that same row. Delete-then-enqueue would lose a recurring chain in the crash
  // window between the two statements, which is exactly the failure arm_ack goes out of its way to
  // avoid. These pin the contract before any feature depends on it.

  it('moves the SAME row when a handler returns a time, rather than replacing it', () => {
    const job = enqueueAndFetch('brief', { deviceId: 'dev_settle' })
    const next = Date.now() + 3_600_000

    settle(job, next)

    const after = pending('brief')
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(job.id)
    expect(after[0]!.runAtMillis).toBe(next)
  })

  it('resets the attempt counter when a chain advances', () => {
    // attempts is arm_ack's retry budget. A recurring chain that inherited it would give up after
    // three ordinary runs.
    const job = enqueueAndFetch('weekly_review', { deviceId: 'dev_attempts' })
    settle(job, Date.now() + 1_000)
    expect(pending('weekly_review')[0]!.attempts).toBe(0)
  })

  it('deletes the row when a handler returns null', () => {
    const job = enqueueAndFetch('wake_check', { deviceId: 'dev_end' })
    settle(job, null)
    expect(pending('wake_check')).toHaveLength(0)
  })

  it('keeps exactly one row across repeated advances, so a chain can never fork', () => {
    // The property the whole seam exists for: settling in place means there is no instant at which
    // a recurring chain has zero rows, and no path by which it gains a second.
    const job = enqueueAndFetch('brief', { deviceId: 'dev_chain' })
    for (let i = 1; i <= 5; i++) {
      settle(pending('brief')[0]!, Date.now() + i * 1_000)
      expect(pending('brief')).toHaveLength(1)
    }
    expect(pending('brief')[0]!.id).toBe(job.id)
  })
})
