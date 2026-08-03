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
