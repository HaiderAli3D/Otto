import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

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
import { googleAccounts } from '../src/db/schema.js'
import { commitmentAt, isProtectedEvent, MAX_COMMITMENT_MS } from '../src/services/commitments.js'
import { getDevice, setTimezone, type Device } from '../src/services/devices.js'
import type { CalendarEvent } from '../src/services/google.js'
import { makeDevice } from './helpers.js'

// config.google is null in tests (setup-env.ts sets no GOOGLE_OAUTH_*), and oauthClient() throws on
// that before googleapis is reached. `config` is a plain object; `as const` is compile-time only.
Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

const ZONE = 'Europe/London'
/** Thursday 10 September 2026, 14:30 in London (BST). Every ISO below is relative to this. */
const NOW = Date.parse('2026-09-10T13:30:00Z')
const at = (localHHMM: string): number => Date.parse(`2026-09-10T${localHHMM}:00+01:00`)

let seq = 0
function linkedDevice(): Device {
  const deviceId = `dev_cm${++seq}`
  makeDevice(deviceId)
  setTimezone(deviceId, ZONE)
  db.insert(googleAccounts).values({ deviceId, refreshToken: 'rt', updatedAt: Date.now() }).run()
  return getDevice(deviceId)!
}

/** A CalendarEvent as `toCalendarEvent` would have built it — every field present, like the real one. */
function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt_1',
    summary: 'Sync',
    startIso: '2026-09-10T14:00:00+01:00',
    endIso: '2026-09-10T15:00:00+01:00',
    isAllDay: false,
    location: null,
    status: 'confirmed',
    recurringEventId: null,
    organizerSelf: true,
    attendeeCount: 0,
    eventType: 'default',
    ...over,
  }
}

/** One raw Google events.list item, so the real mapper runs rather than a test-only variant. */
function item(over: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    summary: 'Sync',
    status: 'confirmed',
    start: { dateTime: '2026-09-10T14:00:00+01:00' },
    end: { dateTime: '2026-09-10T15:00:00+01:00' },
    attendees: [{ email: 'me@example.com' }, { email: 'sam@example.com' }],
    organizer: { self: true },
    ...over,
  }
}

beforeEach(() => {
  ensureSchema()
  listEvents.mockReset()
  listEvents.mockResolvedValue({ data: { items: [] } })
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => vi.useRealTimers())

describe('isProtectedEvent: people, a place, or a title that means it', () => {
  it('counts an event with somebody else on it', () => {
    // attendeeCount INCLUDES the owner, so two is one other person.
    expect(isProtectedEvent(ev({ attendeeCount: 2 }))).toBe(true)
  })

  it('counts an event somebody else put in their calendar', () => {
    expect(isProtectedEvent(ev({ attendeeCount: 1, organizerSelf: false }))).toBe(true)
  })

  it('does NOT count an event they organised alone with nothing else on it', () => {
    // "Deep work", "gym" — the owner's own blocks stay interruptible. This is the whole reason the
    // rule is not simply "every timed event".
    expect(isProtectedEvent(ev({ summary: 'Deep work', attendeeCount: 1, organizerSelf: true }))).toBe(false)
  })

  it('does NOT count an event Google returned with no organizer field at all', () => {
    // THE guard. `toCalendarEvent` writes `organizerSelf: e.organizer?.self === true`, so a missing
    // organizer reads as false. Without requiring at least one attendee alongside it, every event
    // shaped like this — including most fixtures — would read as somebody else's meeting.
    expect(isProtectedEvent(ev({ attendeeCount: 0, organizerSelf: false }))).toBe(false)
  })

  it('counts an event with a place, because that is what a dinner booking looks like', () => {
    expect(isProtectedEvent(ev({ summary: 'Table for two', location: 'Trullo, Islington' }))).toBe(true)
  })

  it('counts a bare title that names a commitment', () => {
    // The case that prompted the feature: a dinner typed straight into the calendar, no attendees,
    // no location.
    expect(isProtectedEvent(ev({ summary: 'Dinner' }))).toBe(true)
    expect(isProtectedEvent(ev({ summary: 'dentist' }))).toBe(true)
  })

  it('matches those titles on a word boundary, not as substrings', () => {
    // "classic", "recall" — a substring match would silence the day on a whim.
    expect(isProtectedEvent(ev({ summary: 'Classic car auction' }))).toBe(false)
    expect(isProtectedEvent(ev({ summary: 'Recall the old build' }))).toBe(false)
  })

  it('never counts an all-day entry, however many people are on it', () => {
    // An all-day entry spans midnight to midnight: one "Team offsite" would silence a whole day.
    expect(isProtectedEvent(ev({ isAllDay: true, attendeeCount: 8 }))).toBe(false)
  })

  it('never counts a cancelled one', () => {
    expect(isProtectedEvent(ev({ status: 'cancelled', attendeeCount: 4 }))).toBe(false)
  })

  it('never counts a Google-generated entry', () => {
    // Birthdays, out-of-office and focus time are not meetings, and focus time in particular would
    // otherwise be protected the moment someone gave it a location.
    expect(isProtectedEvent(ev({ eventType: 'birthday', attendeeCount: 3 }))).toBe(false)
    expect(isProtectedEvent(ev({ eventType: 'focusTime', location: 'Home' }))).toBe(false)
  })
})

describe('commitmentAt: what the gates actually ask', () => {
  it('finds the meeting covering the instant', async () => {
    const device = linkedDevice()
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    const hit = await commitmentAt(device, at('14:30'))
    expect(hit).toEqual({ summary: 'Sync', startMillis: at('14:00'), endMillis: at('15:00') })
  })

  it('is closed at the start and open at the end', async () => {
    // The most common case for this feature is a reminder due at the exact minute a meeting begins,
    // so 14:00 must be INSIDE 14:00-15:00. And back-to-back meetings must not overlap, so 15:00
    // must be outside it — which is also what makes the deferral in runNudge terminate.
    const device = linkedDevice()
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    expect(await commitmentAt(device, at('14:00'))).not.toBeNull()
    expect(await commitmentAt(device, at('15:00'))).toBeNull()
  })

  it('ignores an event that is not a commitment', async () => {
    const device = linkedDevice()
    listEvents.mockResolvedValue({
      data: { items: [item({ summary: 'Deep work', attendees: [], organizer: { self: true } })] },
    })
    expect(await commitmentAt(device, at('14:30'))).toBeNull()
  })

  it('ignores anything too long to be a meeting', async () => {
    // A timed 09:00-18:00 "Conference" would otherwise silence Otto for nine hours, push every rung
    // to 18:00, and drop the morning brief — which markBriefSent records as sent regardless, so it
    // never retries. A day Otto cannot speak on is a day his reminders quietly die.
    const device = linkedDevice()
    listEvents.mockResolvedValue({
      data: {
        items: [
          item({
            summary: 'Conference',
            start: { dateTime: '2026-09-10T09:00:00+01:00' },
            end: { dateTime: '2026-09-10T18:00:00+01:00' },
          }),
        ],
      },
    })
    expect(at('18:00') - at('09:00')).toBeGreaterThan(MAX_COMMITMENT_MS)
    expect(await commitmentAt(device, at('14:30'))).toBeNull()
  })

  it('FAILS OPEN when the calendar cannot be read', async () => {
    // The trade-off, pinned so it cannot be changed by accident. An outage means Otto speaks, not
    // that Otto goes silent — the same posture handlers/leaveBy.ts takes when it refuses to let an
    // outage cancel an alarm. An assistant that goes quiet for ever the day a refresh token expires
    // is the worse failure.
    const device = linkedDevice()
    listEvents.mockRejectedValue(new Error('network'))
    expect(await commitmentAt(device, at('14:30'))).toBeNull()
  })

  it('never asks Google at all when there is no linked calendar', async () => {
    // Which is also why every other test file in this suite is unaffected by the commitment gate.
    const device = makeDevice('dev_cm_nolink')
    setTimezone(device.deviceId, ZONE)
    expect(await commitmentAt(getDevice(device.deviceId)!, at('14:30'))).toBeNull()
    expect(listEvents).not.toHaveBeenCalled()
  })
})
