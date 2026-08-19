import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

const listEvents = vi.hoisted(() => vi.fn())
const insertEvent = vi.hoisted(() => vi.fn())
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(): void {}
      },
    },
    calendar: () => ({ events: { list: listEvents, insert: insertEvent } }),
    tasks: () => ({ tasks: { insert: vi.fn() } }),
  },
}))

import { runTool } from '../src/agent/tools.js'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { googleAccounts } from '../src/db/schema.js'
import { getDevice, setTimezone } from '../src/services/devices.js'
import { makeDevice } from './helpers.js'

Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

const ZONE = 'Europe/London'

function ready(id: string) {
  makeDevice(id)
  setTimezone(id, ZONE)
  db.insert(googleAccounts)
    .values({ deviceId: id, refreshToken: 'refresh-token', updatedAt: Date.now() })
    .onConflictDoUpdate({ target: googleAccounts.deviceId, set: { refreshToken: 'refresh-token' } })
    .run()
  return getDevice(id)!
}

/** A block, in the shape the model sends. All London-local, all on one far-future day. */
const block = (title: string, from: string, to: string, location?: string) => ({
  title,
  startLocalISO: `2026-09-10T${from}:00`,
  endLocalISO: `2026-09-10T${to}:00`,
  ...(location ? { location } : {}),
})

/** An existing Google event occupying part of that day. */
const busy = (summary: string, from: string, to: string, over: Record<string, unknown> = {}) => ({
  id: `evt_${summary.replace(/\s+/g, '_')}`,
  summary,
  status: 'confirmed',
  start: { dateTime: `2026-09-10T${from}:00+01:00` },
  end: { dateTime: `2026-09-10T${to}:00+01:00` },
  ...over,
})

type PlanResult = {
  allWritten: boolean
  created: Array<{ title: string }>
  skipped?: Array<{ title: string; clashesWith: string }>
  failed?: Array<{ title: string; reason: string }>
  outsideTheirDay?: string[]
  mustTell?: string
  error?: string
}

beforeEach(() => {
  ensureSchema()
  listEvents.mockReset()
  insertEvent.mockReset()
  insertEvent.mockResolvedValue({ data: { id: 'evt_new' } })
})

describe('plan_day writes a day around what is already on it', () => {
  it('creates every block when the day is clear, in one call', async () => {
    const device = ready('dev_pd1')
    listEvents.mockResolvedValue({ data: { items: [] } })

    const res = (await runTool(device, 'plan_day', {
      blocks: [block('Deep work', '09:30', '11:30'), block('Lunch', '12:30', '13:30'), block('Admin', '14:00', '15:00')],
    })) as PlanResult

    expect(insertEvent).toHaveBeenCalledTimes(3)
    expect(res.allWritten).toBe(true)
    expect(res.created.map((c) => c.title)).toEqual(['Deep work', 'Lunch', 'Admin'])
    expect(res.mustTell).toBeUndefined()
  })

  it('refuses the block that would land on a real meeting, and says which', async () => {
    const device = ready('dev_pd2')
    listEvents.mockResolvedValue({ data: { items: [busy('Client call', '14:00', '15:00')] } })

    const res = (await runTool(device, 'plan_day', {
      blocks: [block('Deep work', '09:30', '11:30'), block('Admin', '14:30', '15:30')],
    })) as PlanResult

    // The one promise this tool makes: their existing events are never moved, shortened or written
    // over. A double-booked block is not a smaller version of that failure, it IS that failure.
    expect(insertEvent).toHaveBeenCalledTimes(1)
    expect(res.created.map((c) => c.title)).toEqual(['Deep work'])
    expect(res.skipped).toEqual([expect.objectContaining({ title: 'Admin', clashesWith: 'Client call' })])
    expect(res.allWritten).toBe(false)
    expect(res.mustTell).toMatch(/NOT on their calendar/)
  })

  it('lets an all-day entry be planned straight through', async () => {
    const device = ready('dev_pd3')
    // An all-day "Annual leave" spans midnight to midnight. Counted as a clash it would make the one
    // day the owner is free the one day nothing can be planned on.
    listEvents.mockResolvedValue({
      data: { items: [{ id: 'evt_leave', summary: 'Annual leave', status: 'confirmed', start: { date: '2026-09-10' }, end: { date: '2026-09-11' } }] },
    })

    const res = (await runTool(device, 'plan_day', {
      blocks: [block('Deck', '10:00', '12:00'), block('Reading', '14:00', '16:00')],
    })) as PlanResult

    expect(insertEvent).toHaveBeenCalledTimes(2)
    expect(res.allWritten).toBe(true)
  })

  it('does not treat a cancelled event as occupying the slot', async () => {
    const device = ready('dev_pd4')
    listEvents.mockResolvedValue({ data: { items: [busy('Dropped call', '10:00', '11:00', { status: 'cancelled' })] } })

    const res = (await runTool(device, 'plan_day', { blocks: [block('Deep work', '10:00', '11:00')] })) as PlanResult

    expect(res.allWritten).toBe(true)
  })

  it('treats back-to-back as free, because that is what a planned day looks like', async () => {
    const device = ready('dev_pd5')
    listEvents.mockResolvedValue({ data: { items: [busy('Standup', '09:00', '09:15')] } })

    const res = (await runTool(device, 'plan_day', { blocks: [block('Deep work', '09:15', '11:00')] })) as PlanResult

    // Half-open on both ends. A closed comparison would refuse the second block of every pair.
    expect(res.allWritten).toBe(true)
    expect(insertEvent).toHaveBeenCalledTimes(1)
  })

  it('writes nothing at all when the model sends blocks that collide with each other', async () => {
    const device = ready('dev_pd6')
    listEvents.mockResolvedValue({ data: { items: [] } })

    const res = (await runTool(device, 'plan_day', {
      blocks: [block('Deep work', '09:00', '11:00'), block('Lunch', '10:30', '11:30')],
    })) as PlanResult

    // The plan contradicts itself. Writing the half that happens to fit would leave a day nobody
    // designed, and the model can send a corrected one for free.
    expect(insertEvent).not.toHaveBeenCalled()
    expect(listEvents).not.toHaveBeenCalled()
    expect(res.error).toMatch(/overlap each other/)
  })

  it('never guesses at a day it could not read', async () => {
    const device = ready('dev_pd7')
    listEvents.mockRejectedValue(new Error('backendError: try again later'))

    const res = (await runTool(device, 'plan_day', { blocks: [block('Deep work', '09:00', '11:00')] })) as PlanResult

    // Without the read there is no clash guarantee, and the promise is that it never writes over a
    // real meeting. Refusing is the only honest answer.
    expect(insertEvent).not.toHaveBeenCalled()
    expect(res.error).toMatch(/unreachable/)
  })

  it('keeps going after one block fails, and cannot report the day as planned', async () => {
    const device = ready('dev_pd8')
    listEvents.mockResolvedValue({ data: { items: [] } })
    insertEvent
      .mockResolvedValueOnce({ data: { id: 'a' } })
      .mockRejectedValueOnce(new Error('Google said no'))
      .mockResolvedValueOnce({ data: { id: 'c' } })

    const res = (await runTool(device, 'plan_day', {
      blocks: [block('One', '09:00', '10:00'), block('Two', '10:00', '11:00'), block('Three', '11:00', '12:00')],
    })) as PlanResult

    expect(insertEvent).toHaveBeenCalledTimes(3)
    expect(res.created.map((c) => c.title)).toEqual(['One', 'Three'])
    expect(res.failed).toEqual([expect.objectContaining({ title: 'Two' })])
    // There is deliberately no truthy field a model can quote as success while `failed` is populated
    // — this is the "4 created, 5 threw, replied 'all done!'" failure, made unavailable.
    expect(res.allWritten).toBe(false)
    expect(res.mustTell).toContain('1 of the 3')
  })

  it('stops the moment the grant turns out to be revoked', async () => {
    const device = ready('dev_pd9')
    listEvents.mockResolvedValue({ data: { items: [] } })
    insertEvent
      .mockResolvedValueOnce({ data: { id: 'a' } })
      .mockRejectedValueOnce(new Error('invalid_grant: Token has been expired or revoked.'))

    const res = (await runTool(device, 'plan_day', {
      blocks: [block('One', '09:00', '10:00'), block('Two', '10:00', '11:00'), block('Three', '11:00', '12:00')],
    })) as PlanResult

    // Every remaining block would fail identically, so pressing on buys nothing but latency and a
    // longer list of the same sentence.
    expect(insertEvent).toHaveBeenCalledTimes(2)
    expect(res.failed).toHaveLength(2)
    expect(res.failed![1]!.reason).toMatch(/not attempted/)
  })

  it('suppresses Calendar own popups, because a day of blocks is not a day of alarms', async () => {
    const device = ready('dev_pd10')
    listEvents.mockResolvedValue({ data: { items: [] } })

    await runTool(device, 'plan_day', { blocks: [block('Deep work', '09:00', '11:00', 'The office')] })

    const body = insertEvent.mock.calls[0]![0].requestBody
    expect(body.reminders).toEqual({ useDefault: false, overrides: [] })
    expect(body.location).toBe('The office')
    // Bare local wall-clock plus a separate timeZone, never an offset baked into the string.
    expect(body.start).toEqual({ dateTime: '2026-09-10T09:00:00', timeZone: ZONE })
  })

  it('rejects more blocks than it will take, before writing any of them', async () => {
    const device = ready('dev_pd11')
    const blocks = Array.from({ length: 13 }, (_, i) =>
      block(`B${i}`, String(6 + i).padStart(2, '0') + ':00', String(6 + i).padStart(2, '0') + ':30'),
    )

    const res = (await runTool(device, 'plan_day', { blocks })) as PlanResult

    expect(insertEvent).not.toHaveBeenCalled()
    expect(res.error).toMatch(/13 blocks/)
  })

  it('names the block whose time it could not read, and writes nothing', async () => {
    const device = ready('dev_pd12')

    const res = (await runTool(device, 'plan_day', {
      blocks: [block('Fine', '09:00', '10:00'), { title: 'Broken', startLocalISO: '2026-09-10T11:00:00+01:00', endLocalISO: '2026-09-10T12:00:00' }],
    })) as PlanResult

    expect(insertEvent).not.toHaveBeenCalled()
    expect(res.error).toMatch(/Broken/)
    expect(res.error).toMatch(/offset/)
  })

  it('flags a block the owner would be asleep for rather than refusing it', async () => {
    const device = ready('dev_pd13')
    listEvents.mockResolvedValue({ data: { items: [] } })

    const res = (await runTool(device, 'plan_day', { blocks: [block('Gym', '05:30', '06:30')] })) as PlanResult

    // Default day start is 09:00. A 05:30 gym block is a perfectly ordinary thing to want, so this
    // is a word in the confirmation, not an argument with the owner.
    expect(res.allWritten).toBe(true)
    expect(res.outsideTheirDay).toEqual(['Gym'])
  })

  it('needs blocks, and needs Google', async () => {
    const linked = ready('dev_pd14')
    expect(await runTool(linked, 'plan_day', { blocks: [] })).toEqual({
      error: 'plan_day needs a blocks array — send every block for the day in one call',
    })

    const unlinked = makeDevice('dev_pd15')
    expect(await runTool(unlinked, 'plan_day', { blocks: [block('X', '09:00', '10:00')] })).toEqual({
      error: 'calendar not connected',
    })
    expect(listEvents).not.toHaveBeenCalled()
  })
})
