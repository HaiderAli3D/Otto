import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSchema } from '../src/db/client.js'
import { jobs } from '../src/db/schema.js'
import {
  cancelJobsForDevice,
  dueJobs,
  enqueueJob,
  ensureSingletonJob,
  jobPayload,
  type Job,
} from '../src/services/jobs.js'

// The in-memory DB is shared by every test in this file, and these assertions count rows of a
// GIVEN KIND — so the queue starts empty each time rather than inheriting the last test's chain.
beforeEach(() => {
  ensureSchema()
  db.delete(jobs).run()
})

const FAR_FUTURE = Date.now() + 365 * 24 * 3_600_000
const soon = (): number => Date.now() + 60_000

/** Every pending job of a kind, oldest row first. dueJobs orders by run time, so re-sort by id. */
const rows = (kind: string, deviceId?: string): Job[] =>
  dueJobs(FAR_FUTURE)
    .filter((j) => j.kind === kind && (deviceId === undefined || j.deviceId === deviceId))
    .sort((a, b) => a.id - b.id)

describe('ensureSingletonJob', () => {
  it('inserts when no job of the kind exists', () => {
    ensureSingletonJob('gc', soon())
    expect(rows('gc')).toHaveLength(1)
  })

  it('is a NO-OP when exactly one already exists', () => {
    // The restart-safety property: startScheduler runs on every boot and must not fork a second
    // self-rescheduling chain, nor reset the run time the live chain already chose.
    ensureSingletonJob('gc', soon())
    const first = rows('gc')[0]!
    ensureSingletonJob('gc', soon() + 5_000)

    const after = rows('gc')
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(first.id)
    expect(after[0]!.runAtMillis).toBe(first.runAtMillis)
  })

  it('collapses a pre-seeded duplicate chain to one, keeping the LOWEST id', () => {
    // Exactly the state the old unconditional boot enqueue left behind after three restarts.
    enqueueJob('gc', soon())
    enqueueJob('gc', soon() + 1_000)
    enqueueJob('gc', soon() + 2_000)
    const lowest = rows('gc')[0]!.id
    expect(rows('gc')).toHaveLength(3)

    ensureSingletonJob('gc', soon())

    const after = rows('gc')
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(lowest)
  })

  it('is per-device: two devices get two rows', () => {
    ensureSingletonJob('brief', soon(), { deviceId: 'dev_a' })
    ensureSingletonJob('brief', soon(), { deviceId: 'dev_b' })
    ensureSingletonJob('brief', soon(), { deviceId: 'dev_a' })

    expect(rows('brief')).toHaveLength(2)
    expect(rows('brief', 'dev_a')).toHaveLength(1)
    expect(rows('brief', 'dev_b')).toHaveLength(1)
  })

  it('does not confuse a device-scoped chain with the global one', () => {
    ensureSingletonJob('wake_check', soon())
    ensureSingletonJob('wake_check', soon(), { deviceId: 'dev_a' })

    expect(rows('wake_check')).toHaveLength(2)
    expect(rows('wake_check').filter((j) => j.deviceId === null)).toHaveLength(1)
  })
})

describe('cancelJobsForDevice', () => {
  it('drops only that device rows of that kind', () => {
    enqueueJob('brief', soon(), { deviceId: 'dev_a' })
    enqueueJob('brief', soon(), { deviceId: 'dev_b' })
    enqueueJob('wake_check', soon(), { deviceId: 'dev_a' })

    cancelJobsForDevice('brief', 'dev_a')

    expect(rows('brief', 'dev_a')).toHaveLength(0)
    expect(rows('brief', 'dev_b')).toHaveLength(1)
    expect(rows('wake_check', 'dev_a')).toHaveLength(1)
  })

  it('is a no-op when there is nothing to cancel', () => {
    expect(() => cancelJobsForDevice('brief', 'dev_nobody')).not.toThrow()
  })
})

describe('jobPayload', () => {
  it('round-trips an object through the payload column', () => {
    enqueueJob('leave_by', soon(), { deviceId: 'dev_p', payload: { eventId: 'evt_1', minutes: 25 } })
    const job = rows('leave_by')[0]!
    expect(jobPayload<{ eventId: string; minutes: number }>(job)).toEqual({ eventId: 'evt_1', minutes: 25 })
  })

  it('returns null when no payload was written', () => {
    enqueueJob('leave_by', soon(), { deviceId: 'dev_p2' })
    expect(jobPayload(rows('leave_by', 'dev_p2')[0]!)).toBeNull()
  })

  it('returns null on corrupt JSON rather than throwing', () => {
    // A throw here would wedge the scheduler on the same poison row every 15 seconds forever.
    enqueueJob('leave_by', soon(), { deviceId: 'dev_p3' })
    const job = { ...rows('leave_by', 'dev_p3')[0]!, payload: '{not json' }
    expect(jobPayload(job)).toBeNull()
  })
})
