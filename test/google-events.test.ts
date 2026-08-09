import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

// googleapis is the whole integration, so it is the whole mock: `events.list` hands back fixture
// items in exactly the shape the real API returns them, and the assertions below are about what
// listCalendarEvents does with that shape — not about Google.
const listEvents = vi.hoisted(() => vi.fn())
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(): void {}
      },
    },
    calendar: () => ({ events: { list: listEvents } }),
    tasks: () => ({ tasks: { insert: vi.fn() } }),
  },
}))

import { runTool } from '../src/agent/tools/index.js'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { googleAccounts, outbox } from '../src/db/schema.js'
import { listCalendarEvents, tryListCalendarEvents } from '../src/services/google.js'
import { linkWhatsapp } from '../src/services/devices.js'
import { makeDevice } from './helpers.js'

// setup-env.ts sets no GOOGLE_OAUTH_* vars, so config.google is null and oauthClient() throws
// before googleapis is ever reached. `config` is a plain object — `as const` is compile-time only.
Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

function linkGoogle(deviceId: string): void {
  db.insert(googleAccounts)
    .values({ deviceId, refreshToken: 'refresh-token', updatedAt: Date.now() })
    .onConflictDoUpdate({ target: googleAccounts.deviceId, set: { refreshToken: 'refresh-token' } })
    .run()
}

beforeEach(() => {
  ensureSchema()
  listEvents.mockReset()
})

describe('listCalendarEvents surfaces the fields it used to discard', () => {
  it('reads all-day off start.date, never off the shape of the string', async () => {
    const device = makeDevice('dev_ce1')
    linkGoogle(device.deviceId)
    listEvents.mockResolvedValue({
      data: {
        items: [
          { id: 'evt_holiday', summary: 'Bank holiday', start: { date: '2026-08-31' }, end: { date: '2026-09-01' } },
        ],
      },
    })

    const [event] = await listCalendarEvents(device.deviceId, '2026-08-31T00:00:00', '2026-09-01T00:00:00')

    expect(event!.isAllDay).toBe(true)
    expect(event!.startIso).toBe('2026-08-31')
    expect(event!.id).toBe('evt_holiday')
  })

  it('a timed event is not all-day even though it has no date field at all', async () => {
    const device = makeDevice('dev_ce2')
    linkGoogle(device.deviceId)
    listEvents.mockResolvedValue({
      data: {
        items: [
          {
            id: 'evt_standup',
            summary: 'Standup',
            location: 'The Ship, Wandsworth',
            status: 'confirmed',
            start: { dateTime: '2026-08-04T09:00:00+01:00' },
            end: { dateTime: '2026-08-04T09:15:00+01:00' },
          },
        ],
      },
    })

    const [event] = await listCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')

    expect(event!.isAllDay).toBe(false)
    expect(event!.location).toBe('The Ship, Wandsworth')
    expect(event!.status).toBe('confirmed')
    expect(event!.id).toBe('evt_standup')
  })

  it('reports a missing location as null rather than an empty string', async () => {
    const device = makeDevice('dev_ce3')
    linkGoogle(device.deviceId)
    listEvents.mockResolvedValue({
      data: {
        items: [
          {
            id: 'evt_nowhere',
            summary: 'Think',
            status: 'tentative',
            start: { dateTime: '2026-08-04T14:00:00+01:00' },
            end: { dateTime: '2026-08-04T15:00:00+01:00' },
          },
        ],
      },
    })

    const [event] = await listCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')

    // null, not '': the planner's "is there a destination?" test must not have to know the
    // difference between absent and blank.
    expect(event!.location).toBeNull()
    expect(event!.status).toBe('tentative')
  })

  it('passes an explicit maxResults through instead of riding Google default', async () => {
    const device = makeDevice('dev_ce4')
    linkGoogle(device.deviceId)
    listEvents.mockResolvedValue({ data: { items: [] } })

    await listCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')

    expect(listEvents).toHaveBeenCalledTimes(1)
    expect(listEvents.mock.calls[0]![0]).toMatchObject({ maxResults: 50, singleEvents: true, orderBy: 'startTime' })
  })
})

describe('tryListCalendarEvents never throws at a scheduler job', () => {
  it('returns null for a device that has never linked Google', async () => {
    const device = makeDevice('dev_ce5')

    // listCalendarEvents would throw here. A scheduler job that also has an alarm to settle must
    // get an answer, not an exception thrown past it.
    await expect(listCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')).rejects.toThrow()
    expect(await tryListCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')).toBeNull()
  })

  it('returns null when Google itself fails, and queues nothing for a transient error', async () => {
    const device = makeDevice('dev_ce6')
    linkGoogle(device.deviceId)
    linkWhatsapp(device.deviceId, '447700900000')
    listEvents.mockRejectedValue(new Error('backendError: try again later'))

    expect(await tryListCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')).toBeNull()
    expect(db.select().from(outbox).all()).toHaveLength(0)
  })

  it('warns the owner exactly once when the grant has been revoked', async () => {
    const device = makeDevice('dev_ce7')
    linkGoogle(device.deviceId)
    linkWhatsapp(device.deviceId, '447700900001')
    listEvents.mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.'))

    await tryListCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')
    await tryListCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')
    await tryListCalendarEvents(device.deviceId, '2026-08-04T00:00:00', '2026-08-05T00:00:00')

    const queued = db.select().from(outbox).all()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.kind).toBe('system_warning')
    expect(queued[0]!.body).toContain('revoked')
  })
})

describe('list_calendar_events hands the model a view, not the row', () => {
  const window = { timeMinLocalISO: '2026-08-04T00:00:00', timeMaxLocalISO: '2026-08-05T00:00:00' }

  it('drops the opaque id and the status and keeps what the model can act on', async () => {
    const device = makeDevice('dev_ce9')
    linkGoogle(device.deviceId)
    listEvents.mockResolvedValue({
      data: {
        items: [
          {
            id: 'a1b2c3d4e5f6g7h8i9j0k1l2m3_20260804T110000Z',
            summary: 'Standup',
            location: 'The Ship, Wandsworth',
            status: 'confirmed',
            start: { dateTime: '2026-08-04T12:00:00+01:00' },
            end: { dateTime: '2026-08-04T13:00:00+01:00' },
          },
        ],
      },
    })

    const res = (await runTool(device, 'list_calendar_events', window)) as { events: unknown[] }

    // A tool result is appended to the session history and re-sent on every later turn, so width
    // here is a bill for the rest of the conversation — which is why this asserts the WHOLE shape
    // and not just the fields it cares about.
    //
    // The id was excluded on the grounds that no tool accepted it as input. `add_note` now does, so
    // that premise is gone and the forty characters buy something: without them the model cannot
    // address a meeting at all, and notes taken in one could only be filed against its title. Title
    // was rejected as the key because it is not unique — every daily "Standup" would silently share
    // one pile of notes, and two unrelated meetings with the same name would merge.
    //
    // It is `eventKeyOf`, not `e.id`, so there is exactly one notion of event identity in the
    // system: leave-by established that key (Google's id, falling back to the summary when it gives
    // none) and create_leave_by_alarm already hands the same value back.
    expect(res.events).toEqual([
      {
        eventId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3_20260804T110000Z',
        summary: 'Standup',
        startIso: '2026-08-04T12:00:00+01:00',
        endIso: '2026-08-04T13:00:00+01:00',
        location: 'The Ship, Wandsworth',
      },
    ])
  })

  it('does not list a cancelled event as though it were on', async () => {
    const device = makeDevice('dev_ce10')
    linkGoogle(device.deviceId)
    listEvents.mockResolvedValue({
      data: {
        items: [
          {
            id: 'evt_dropped',
            summary: 'Client call',
            status: 'cancelled',
            start: { dateTime: '2026-08-04T15:00:00+01:00' },
            end: { dateTime: '2026-08-04T15:30:00+01:00' },
          },
        ],
      },
    })

    const res = (await runTool(device, 'list_calendar_events', window)) as { events: unknown[] }

    // Now that `status` is no longer in the view, a cancelled row shown at all reads as a live one.
    expect(res.events).toEqual([])
  })
})

describe('the zone the window is interpreted in', () => {
  it('rejects a window it cannot parse instead of listing years of history', async () => {
    const device = makeDevice('dev_ce8')
    linkGoogle(device.deviceId)

    await expect(listCalendarEvents(device.deviceId, 'not-a-date', '2026-08-05T00:00:00')).rejects.toThrow(
      /timeMinLocalISO/,
    )
    expect(listEvents).not.toHaveBeenCalled()
  })
})
