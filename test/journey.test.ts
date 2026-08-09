import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

const listEvents = vi.hoisted(() => vi.fn())
const insertEvent = vi.hoisted(() => vi.fn())
const getEvent = vi.hoisted(() => vi.fn())
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(): void {}
      },
    },
    calendar: () => ({ events: { list: listEvents, insert: insertEvent, get: getEvent } }),
    tasks: () => ({ tasks: { insert: vi.fn() } }),
  },
}))

import { runTool } from '../src/agent/tools/index.js'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { alarms, googleAccounts, jobs, reminders } from '../src/db/schema.js'
import { parseNagPlan, planRungs } from '../src/lib/rungPlan.js'
import { listArmed } from '../src/services/alarms.js'
import { getDevice, setTimezone, type Device } from '../src/services/devices.js'
import { rememberFact } from '../src/services/facts.js'
import { journeyLeadMinutes, planJourney } from '../src/services/journey.js'
import { jobPayload } from '../src/services/jobs.js'
import type { LeaveByJobPayload } from '../src/services/leaveBy.js'
import { findSavedPlace } from '../src/services/savedPlaces.js'
import { resetPlacesBudget } from '../src/services/places.js'
import { resetTravelBudget, TRANSIT_SLACK_MINUTES } from '../src/services/travel.js'
import { makeDevice } from './helpers.js'

Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

const ZONE = 'Europe/London'
/** Tuesday 4 August 2026, 08:00 in London (BST). */
const NOW = Date.parse('2026-08-04T07:00:00Z')
/** 15:00 the same day. */
const ARRIVE_LOCAL = '2026-08-04T15:00:00'
const ARRIVE_MS = Date.parse('2026-08-04T14:00:00Z')

const KEY = 'test-maps-key'
const mutable = config as unknown as Record<string, unknown>

beforeEach(() => {
  ensureSchema()
  resetTravelBudget()
  resetPlacesBudget()
  listEvents.mockReset()
  insertEvent.mockReset()
  getEvent.mockReset()
  db.delete(jobs).run()
  db.delete(alarms).run()
  db.delete(reminders).run()
  vi.unstubAllGlobals()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  listEvents.mockResolvedValue({ data: { items: [] } })
  // Google hands back the event it wrote, with a real id and the location we sent.
  insertEvent.mockImplementation(async (args: { requestBody: Record<string, unknown> }) => ({
    data: { id: 'evt_google_real', htmlLink: 'https://cal', ...args.requestBody },
  }))
  getEvent.mockImplementation(async () => ({
    data: {
      id: 'evt_google_real',
      summary: 'Dentist',
      start: { dateTime: '2026-08-04T15:00:00+01:00' },
      end: { dateTime: '2026-08-04T16:00:00+01:00' },
      location: '14 High Street, London',
      status: 'confirmed',
    },
  }))
})

afterEach(() => {
  vi.useRealTimers()
  mutable.maps = null
})

let seq = 0
function makeLondonDevice(withGoogle = true): Device {
  const deviceId = `dev_j${++seq}`
  makeDevice(deviceId)
  setTimezone(deviceId, ZONE)
  // Without an origin `estimateJourneyMinutes` skips the network entirely and returns the flat
  // fallback — "we don't know where they are" is a real state and it degrades rather than guessing.
  // Every test below that asserts on a MODE or a live number needs a resolvable origin first.
  rememberFact({ deviceId, key: 'home.address', value: '221B Baker Street, London' })
  if (withGoogle) db.insert(googleAccounts).values({ deviceId, refreshToken: 'rt', updatedAt: Date.now() }).run()
  return getDevice(deviceId)!
}

function stubFetch(impl: (url: string, init: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', fn)
  return fn as unknown as ReturnType<typeof vi.fn>
}

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response

const placesReply = (places: unknown[]) => okJson({ places })
const onePlace = (name = 'Hartley & Co', address = '14 High Street, London') => ({
  id: 'ChIJ_dentist',
  displayName: { text: name },
  formattedAddress: address,
  location: { latitude: 51.52, longitude: -0.1 },
})

/** Routes for everything, Places for the searchText URL. */
function stubGoogleApis(p: { transitMinutes?: number; walkMinutes?: number; places?: unknown[] }) {
  return stubFetch((url, init) => {
    if (String(url).includes('places.googleapis.com')) return placesReply(p.places ?? [onePlace()])
    const mode = (JSON.parse(String(init.body)) as { travelMode: string }).travelMode
    const mins = mode === 'WALK' ? (p.walkMinutes ?? 45) : (p.transitMinutes ?? 40)
    return okJson({ routes: [{ duration: `${mins * 60}s` }] })
  })
}

const journeyReminder = () => db.select().from(reminders).all()[0]

describe('nothing is created on a question', () => {
  it('returns the candidates and writes absolutely nothing when the place is ambiguous', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({
      places: [onePlace('Bupa Dental', 'Mill Road'), onePlace('Smile Clinic', 'High Street'), onePlace('Hartley', 'Church Lane')],
    })

    const outcome = await planJourney({ device, destinationQuery: 'the dentist', arriveByMillis: ARRIVE_MS })

    expect(outcome.kind).toBe('ambiguous')
    // The whole point of resolving FIRST. The expensive and irreversible half never runs on a
    // destination nobody is sure of.
    expect(insertEvent).not.toHaveBeenCalled()
    expect(listArmed(device.deviceId)).toHaveLength(0)
    expect(db.select().from(reminders).all()).toHaveLength(0)
    expect(db.select().from(jobs).all()).toHaveLength(0)
  })

  it('creates nothing when the place cannot be found at all', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({ places: [] })

    const outcome = await planJourney({ device, destinationQuery: 'the flurb', arriveByMillis: ARRIVE_MS })

    expect(outcome.kind).toBe('unknown')
    expect(insertEvent).not.toHaveBeenCalled()
    expect(db.select().from(reminders).all()).toHaveLength(0)
  })
})

describe('the calendar entry the recheck has to survive', () => {
  it('writes the resolved address as the location, and suppresses Calendar\'s own reminder', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({})

    await planJourney({ device, destinationQuery: 'hartley & co', arriveByMillis: ARRIVE_MS, title: 'Dentist' })

    const body = (insertEvent.mock.calls[0] as [{ requestBody: Record<string, unknown> }])[0].requestBody
    // Without a location the event comes back blocked:'no-location', which handlers/leaveBy.ts
    // reads as "this stopped being a journey" and answers by cancelling BOTH alarms — silently,
    // 45 minutes before departure.
    expect(body.location).toBe('14 High Street, London')
    expect(body.summary).toBe('Dentist')
    // A fourth notification from a producer this server cannot coordinate with.
    expect(body.reminders).toEqual({ useDefault: false, overrides: [] })
  })

  it('plans from Google\'s copy, so the event key is the real id', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({})

    await planJourney({ device, destinationQuery: 'hartley & co', arriveByMillis: ARRIVE_MS })

    expect(getEvent).toHaveBeenCalled()
    // The recheck looks the event up by this key against Google's own list. Planning from the
    // synthetic object would key it on the SUMMARY, which never matches — and the handler reads a
    // missing event as deleted and cancels the alarms.
    const job = db.select().from(jobs).where(eq(jobs.kind, 'leave_by')).all()[0]
    expect(job).toBeDefined()
    const payload = jobPayload<LeaveByJobPayload>(job!)!
    expect(payload.eventId).toBe('evt_google_real')
    // Carried so the recheck asks about the same journey rather than re-deciding it.
    expect(payload.mode).toBe('TRANSIT')
    expect(payload.destinationPlaceId).toBe('ChIJ_dentist')
  })

  it('still plans the journey when the calendar cannot be written', async () => {
    const device = makeLondonDevice(false) // no Google linked
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({})

    const outcome = await planJourney({ device, destinationQuery: 'hartley & co', arriveByMillis: ARRIVE_MS })

    expect(outcome.kind).toBe('planned')
    const journey = outcome.kind === 'planned' ? outcome.journey : null
    expect(journey!.calendarEventId).toBeNull()
    // Says so rather than pretending. A failed calendar write must never cost the alarm.
    expect(journey!.calendarNote).toContain('not connected')
    expect(journey!.reminderId).toBeTruthy()
  })
})

describe('journeyLeadMinutes', () => {
  const due = ARRIVE_MS

  it('never puts a rung on the leave-now alarm', () => {
    const leaveAt = due - 40 * 60_000
    const leads = journeyLeadMinutes({ dueAtMillis: due, travelMinutes: 40, getReadyMinutes: 45, ringingAt: [leaveAt] })
    // 40 is the departure. It is not a candidate at all — there is nothing to filter at runtime.
    expect(leads).not.toContain(40)
    expect(leads).toEqual([24 * 60, 85, 50])
  })

  it('drops the get-ready rung when a get-up alarm rings at that instant', () => {
    // Not a coincidence: the wake alarm is leaveAt − getReady and the rung is start − (T + G).
    // Those are the same expression, so this collision is structural and happens every time.
    const leaveAt = due - 40 * 60_000
    const wakeAt = leaveAt - 45 * 60_000
    const leads = journeyLeadMinutes({
      dueAtMillis: due,
      travelMinutes: 40,
      getReadyMinutes: 45,
      ringingAt: [leaveAt, wakeAt],
    })
    expect(leads).toEqual([24 * 60, 50])
  })

  it('keeps the leaving-soon rung, which no alarm occupies', () => {
    const leaveAt = due - 40 * 60_000
    const leads = journeyLeadMinutes({ dueAtMillis: due, travelMinutes: 40, getReadyMinutes: 45, ringingAt: [leaveAt] })
    expect(leads).toContain(50) // 40 + 10, ten minutes before walking out
  })
})

describe('the reminder a journey leaves behind', () => {
  it('does not ring, does not escalate, and stops chasing once they should be there', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({})

    await planJourney({ device, destinationQuery: 'hartley & co', arriveByMillis: ARRIVE_MS })

    const r = journeyReminder()!
    // The leave-now alarm IS the ring. A second alarm here is the "never create both objects for
    // one thing" prohibition, and escalation would arm a THIRD on a path exempt from both the
    // daily budget and quiet hours.
    expect(r.alarmId).toBeNull()
    expect(r.escalateWithAlarm).toBe(false)
    expect(r.timingKind).toBe('appointment')

    const plan = parseNagPlan(r.nagPlan)!
    expect(plan.chaseMinutes).toEqual([])

    // An empty chase array means maxChases 0, so the ladder ends when the leads do. The reminder
    // stays something they can mark done; it just stops asking.
    const resolved = planRungs({
      kind: 'appointment',
      policy: r.nagPolicy as 'persistent',
      dueAtMillis: ARRIVE_MS,
      plannedAtMillis: NOW,
      zone: ZONE,
      override: plan,
    })
    expect(resolved.maxChases).toBe(0)
    expect(resolved.chase).toEqual([])
  })

  it('carries where, how and how long in the line every nudge repeats', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({ transitMinutes: 40 })

    await planJourney({ device, destinationQuery: 'hartley & co', arriveByMillis: ARRIVE_MS })

    expect(journeyReminder()!.detail).toBe('14 High Street, London — transit, about 40 minutes')
  })
})

describe('confidence', () => {
  it('does not arm for a place they never confirmed, even though they asked', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    // A sole FUZZY hit: one result, and its name is not what they said.
    stubGoogleApis({ places: [onePlace('Hartley & Co', '14 High Street, London')] })

    const outcome = await planJourney({ device, destinationQuery: 'a dentist near me', arriveByMillis: ARRIVE_MS })

    const journey = outcome.kind === 'planned' ? outcome.journey : null
    expect(journey!.plan.blocked).toBe('place-guessed')
    // explicit:true clears 'estimated', 'quiet-hours' and 'double-booked'. It must NOT clear this
    // one: consent to an alarm is not consent to an alarm for somewhere they never named.
    expect(journey!.plan.armed).toBe(false)
    expect(listArmed(device.deviceId)).toHaveLength(0)
    // Everything else still happened — they get the plan, the entry and the reminder.
    expect(journey!.reminderId).toBeTruthy()
    expect(insertEvent).toHaveBeenCalled()
  })

  it('arms when the name is exactly what they said', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({ places: [onePlace('Wembley Stadium', 'Wembley HA9 0WS')] })

    const outcome = await planJourney({ device, destinationQuery: 'Wembley Stadium', arriveByMillis: ARRIVE_MS })

    const journey = outcome.kind === 'planned' ? outcome.journey : null
    expect(journey!.plan.blocked).toBeNull()
    expect(journey!.plan.armed).toBe(true)
  })

  it('arms for a saved place without asking anyone', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({})
    await planJourney({
      device,
      destinationQuery: 'hartley & co',
      arriveByMillis: ARRIVE_MS,
      rememberPlaceAs: 'the dentist',
    })

    const saved = findSavedPlace(device.deviceId, 'the dentist')
    expect(saved).toBeDefined()
    expect(saved!.address).toBe('14 High Street, London')
    expect(saved!.googlePlaceId).toBe('ChIJ_dentist')
  })
})

describe('mode', () => {
  it('walks when the walk is short, and says so', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({ walkMinutes: 9 })

    const outcome = await planJourney({ device, destinationQuery: 'Hartley & Co', arriveByMillis: ARRIVE_MS })

    const journey = outcome.kind === 'planned' ? outcome.journey : null
    expect(journey!.mode).toBe('WALK')
    expect(journey!.travelMinutes).toBe(9)
  })

  it('adds transit slack to the departure, but only for a live timetable', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({ transitMinutes: 40, walkMinutes: 45 })

    const outcome = await planJourney({ device, destinationQuery: 'Hartley & Co', arriveByMillis: ARRIVE_MS })

    const journey = outcome.kind === 'planned' ? outcome.journey : null
    expect(journey!.mode).toBe('TRANSIT')
    expect(journey!.travelMinutes).toBe(40)
    // A missed connection is not the owner being late: Routes answers with ONE itinerary and
    // missing its first leg by ninety seconds can cost a full headway.
    expect(journey!.plan.leaveAtMillis).toBe(ARRIVE_MS - (40 + TRANSIT_SLACK_MINUTES) * 60_000)
  })

  it('never pads a guess', async () => {
    const device = makeLondonDevice()
    // No Maps key: the ladder returns a flat number that means nothing per-mode, so padding it
    // would be arithmetic on a fiction.
    const outcome = await planJourney({ device, destinationQuery: '14 High Street, London', arriveByMillis: ARRIVE_MS })

    const journey = outcome.kind === 'planned' ? outcome.journey : null
    expect(journey!.estimated).toBe(true)
    expect(journey!.plan.leaveAtMillis).toBe(ARRIVE_MS - journey!.travelMinutes * 60_000)
  })

  it('honours an explicit "I\'ll drive"', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    const fetchMock = stubGoogleApis({})

    const outcome = await planJourney({
      device,
      destinationQuery: 'Hartley & Co',
      arriveByMillis: ARRIVE_MS,
      travelMode: 'DRIVE',
    })

    expect(outcome.kind === 'planned' && outcome.journey.mode).toBe('DRIVE')
    const routeCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).includes('places.googleapis'))
    // An override costs no walk probe.
    expect(routeCalls).toHaveLength(1)
  })
})

describe('the plan_journey tool', () => {
  it('hands the model local times, both ids, and no millis to do arithmetic on', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({})

    const res = (await runTool(device, 'plan_journey', {
      destination: 'Hartley & Co',
      arriveByLocalISO: ARRIVE_LOCAL,
      title: 'Dentist',
    })) as Record<string, unknown>

    expect(res.mode).toBe('TRANSIT')
    expect(res.destination).toBe('14 High Street, London')
    expect(res.onTheirCalendar).toBe(true)
    expect(typeof res.leaveAtLocal).toBe('string')
    expect(typeof res.reminderId).toBe('string')
    expect(res.armed).toBe(true)
    expect(res.alarmId).toBeTruthy()
  })

  it('asks rather than picking, and the ambiguous key is the one the prompt already covers', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({ places: [onePlace('Bupa Dental', 'Mill Road'), onePlace('Smile Clinic', 'High Street')] })

    const res = (await runTool(device, 'plan_journey', {
      destination: 'the dentist',
      arriveByLocalISO: ARRIVE_LOCAL,
    })) as { ambiguous?: Array<{ name: string; address: string }> }

    expect(res.ambiguous).toHaveLength(2)
    expect(res.ambiguous![0]).toEqual({ name: 'Bupa Dental', address: 'Mill Road' })
  })

  it('rejects an unusable time with the field named', async () => {
    const device = makeLondonDevice()
    const res = (await runTool(device, 'plan_journey', {
      destination: 'anywhere',
      arriveByLocalISO: 'next tuesday',
    })) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('drops a mis-spelled travelMode rather than failing the journey', async () => {
    const device = makeLondonDevice()
    mutable.maps = { apiKey: KEY }
    stubGoogleApis({})

    const res = (await runTool(device, 'plan_journey', {
      destination: 'Hartley & Co',
      arriveByLocalISO: ARRIVE_LOCAL,
      travelMode: 'TELEPORT',
    })) as Record<string, unknown>

    expect(res.mode).toBe('TRANSIT')
  })
})

describe('create_leave_by_alarm points at the other tool when it finds nothing', () => {
  it('says so rather than reporting a dentist appointment it cannot find', async () => {
    const device = makeLondonDevice()
    const res = (await runTool(device, 'create_leave_by_alarm', { eventDescription: 'dentist' })) as {
      hint?: string
    }
    expect(res.hint).toContain('plan_journey')
  })
})
