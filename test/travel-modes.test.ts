import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { config } from '../src/config.js'
import { ensureSchema } from '../src/db/client.js'
import { rememberFact } from '../src/services/facts.js'
import {
  CALLS_RESERVED_PER_JOURNEY,
  chooseTravelMode,
  claimTravelCalls,
  computeRouteMinutes,
  estimateJourneyMinutes,
  MAX_TRAVEL_CALLS_PER_DAY,
  releaseTravelCalls,
  resetTravelBudget,
  WALK_CEILING_MINUTES,
} from '../src/services/travel.js'
import { makeDevice } from './helpers.js'

beforeEach(() => {
  ensureSchema()
  resetTravelBudget()
  vi.unstubAllGlobals()
})

const KEY = 'test-maps-key'
const ARRIVE = Date.now() + 6 * 3_600_000
const DEPART = Date.now() + 3_600_000

function stubFetch(impl: (url: string, init: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', fn)
  return fn as unknown as ReturnType<typeof vi.fn>
}

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response

const minutes = (m: number) => okJson({ routes: [{ duration: `${m * 60}s` }] })

/** The body of the nth fetch, parsed. */
const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> =>
  JSON.parse(String((fetchMock.mock.calls[n] as [string, RequestInit])[1].body))

/** Far enough apart that the straight line alone rules a walk out. */
const WANDSWORTH = { lat: 51.4571, lng: -0.1919 }
const WEMBLEY = { lat: 51.556, lng: -0.2795 }
/** ~350m apart: close enough that a walk has to be asked about. */
const TRAFALGAR = { lat: 51.508, lng: -0.128 }
const LEICESTER = { lat: 51.5105, lng: -0.1305 }

describe('computeRouteMinutes obeys the per-mode body rules', () => {
  it('sends routingPreference for DRIVE and never for anything else', async () => {
    // Routes: "You can specify this option only when the travelMode is DRIVE or TWO_WHEELER,
    // otherwise the request fails." A 400 here becomes `unknown`, the caller degrades to the flat
    // fallback, and the feature ships looking finished while never once being right.
    for (const mode of ['TRANSIT', 'WALK', 'BICYCLE'] as const) {
      const fetchMock = stubFetch(() => minutes(20))
      await computeRouteMinutes({ apiKey: KEY, origin: { address: 'a' }, destination: { address: 'b' }, mode })
      expect(bodyOf(fetchMock).routingPreference, mode).toBeUndefined()
    }

    const driveMock = stubFetch(() => minutes(20))
    await computeRouteMinutes({
      apiKey: KEY,
      origin: { address: 'a' },
      destination: { address: 'b' },
      mode: 'DRIVE',
      departAtMillis: DEPART,
    })
    expect(bodyOf(driveMock).routingPreference).toBe('TRAFFIC_AWARE')
  })

  it('asks the timetable by arrival time, and never sends both time fields', async () => {
    const fetchMock = stubFetch(() => minutes(40))

    await computeRouteMinutes({
      apiKey: KEY,
      origin: { address: 'a' },
      destination: { address: 'b' },
      mode: 'TRANSIT',
      arriveByMillis: ARRIVE,
      departAtMillis: DEPART,
    })

    const body = bodyOf(fetchMock)
    expect(body.arrivalTime).toBe(new Date(ARRIVE).toISOString())
    // Routes rejects a request carrying both. And the arrival time is the quantity we actually
    // know — a timetable answers "what gets me there by 15:00", not "how long from a guess".
    expect(body.departureTime).toBeUndefined()
  })

  it('falls back to a departure time for transit when no arrival time is given', async () => {
    const fetchMock = stubFetch(() => minutes(40))
    await computeRouteMinutes({
      apiKey: KEY,
      origin: { address: 'a' },
      destination: { address: 'b' },
      mode: 'TRANSIT',
      departAtMillis: DEPART,
    })
    expect(bodyOf(fetchMock).departureTime).toBeDefined()
    expect(bodyOf(fetchMock).arrivalTime).toBeUndefined()
  })

  it('sends no time field at all for a walk', async () => {
    // Walking time does not depend on the clock, and omitting it removes the past-departure clamp
    // and one more way to 400.
    const fetchMock = stubFetch(() => minutes(9))
    await computeRouteMinutes({
      apiKey: KEY,
      origin: { address: 'a' },
      destination: { address: 'b' },
      mode: 'WALK',
      departAtMillis: DEPART,
      arriveByMillis: ARRIVE,
    })
    const body = bodyOf(fetchMock)
    expect(body.departureTime).toBeUndefined()
    expect(body.arrivalTime).toBeUndefined()
  })

  it('carries a placeId or a latLng waypoint in the shapes Routes documents', async () => {
    const fetchMock = stubFetch(() => minutes(12))
    await computeRouteMinutes({
      apiKey: KEY,
      origin: { latLng: { lat: 51.5, lng: -0.12 } },
      destination: { placeId: 'ChIJ_place' },
      mode: 'WALK',
    })
    const body = bodyOf(fetchMock)
    expect(body.origin).toEqual({ location: { latLng: { latitude: 51.5, longitude: -0.12 } } })
    expect(body.destination).toEqual({ placeId: 'ChIJ_place' })
  })

  it('separates "there is no route" from "we could not find out"', async () => {
    // Collapsing these is a real bug: "no tube at 05:00" is Google telling us something true, and
    // before the distinction existed it became a confident "about 30 minutes".
    stubFetch(() => okJson({ routes: [] }))
    expect(
      await computeRouteMinutes({ apiKey: KEY, origin: { address: 'a' }, destination: { address: 'b' }, mode: 'TRANSIT' }),
    ).toEqual({ kind: 'no-route' })

    stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }) as Response)
    expect(
      await computeRouteMinutes({ apiKey: KEY, origin: { address: 'a' }, destination: { address: 'b' }, mode: 'TRANSIT' }),
    ).toEqual({ kind: 'unknown' })
  })
})

describe('transit unless it is a short walk', () => {
  const choose = (over: Partial<Parameters<typeof chooseTravelMode>[0]> = {}) =>
    chooseTravelMode({
      apiKey: KEY,
      origin: { address: 'a' },
      destination: { address: 'b' },
      originLatLng: null,
      destinationLatLng: null,
      probeAllowed: true,
      ...over,
    })

  it('lets an explicit "I\'ll drive" win, for free', async () => {
    const fetchMock = stubFetch(() => minutes(5))
    const d = await choose({ override: 'DRIVE' })
    expect(d).toEqual({ mode: 'DRIVE', reason: 'override', walkMinutes: null, callsSpent: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rules a walk out from the straight line alone, without paying for a probe', async () => {
    const fetchMock = stubFetch(() => minutes(5))
    const d = await choose({ originLatLng: WANDSWORTH, destinationLatLng: WEMBLEY })
    expect(d.mode).toBe('TRANSIT')
    expect(d.reason).toBe('too-far-to-walk')
    expect(d.callsSpent).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('walks when the walk really is short', async () => {
    stubFetch(() => minutes(WALK_CEILING_MINUTES - 1))
    const d = await choose({ originLatLng: TRAFALGAR, destinationLatLng: LEICESTER })
    expect(d.mode).toBe('WALK')
    expect(d.walkMinutes).toBe(WALK_CEILING_MINUTES - 1)
    expect(d.callsSpent).toBe(1)
  })

  it('treats the ceiling itself as walkable and one minute past it as transit', async () => {
    stubFetch(() => minutes(WALK_CEILING_MINUTES))
    expect((await choose()).mode).toBe('WALK')

    stubFetch(() => minutes(WALK_CEILING_MINUTES + 1))
    const far = await choose()
    expect(far.mode).toBe('TRANSIT')
    // Kept even though we took transit, so Otto can say "it's a 16 minute walk if you'd rather".
    expect(far.walkMinutes).toBe(WALK_CEILING_MINUTES + 1)
  })

  it('NEVER walks on a guess', async () => {
    // The whole safety property. estimateTravelMinutes never fails and returns the same number
    // whatever mode you asked for, so a rule read off the fallback ladder degrades into "is their
    // stated commute buffer under fifteen minutes?" — and sends them walking across the city.
    stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }) as Response)
    const d = await choose()
    expect(d.mode).toBe('TRANSIT')
    expect(d.reason).toBe('unknown-walk')
    expect(d.walkMinutes).toBeNull()
  })

  it('takes transit rather than probing when there is no budget for two calls', async () => {
    const fetchMock = stubFetch(() => minutes(5))
    const d = await choose({ probeAllowed: false })
    expect(d).toEqual({ mode: 'TRANSIT', reason: 'no-probe', walkMinutes: null, callsSpent: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the persisted spend guard', () => {
  it('claims all of a reservation or none of it', () => {
    const device = makeDevice('dev_budget_a')
    expect(claimTravelCalls(device.deviceId, MAX_TRAVEL_CALLS_PER_DAY - 1)).toBe(true)
    // Two would overshoot, so neither is taken — a cap that tripped BETWEEN the probe and the route
    // would price a journey by one mode and plan it as another.
    expect(claimTravelCalls(device.deviceId, 2)).toBe(false)
    expect(claimTravelCalls(device.deviceId, 1)).toBe(true)
    expect(claimTravelCalls(device.deviceId, 1)).toBe(false)
  })

  it('hands back what a journey reserved and did not spend', () => {
    const device = makeDevice('dev_budget_b')
    claimTravelCalls(device.deviceId, MAX_TRAVEL_CALLS_PER_DAY)
    expect(claimTravelCalls(device.deviceId, 1)).toBe(false)
    releaseTravelCalls(device.deviceId, 2)
    expect(claimTravelCalls(device.deviceId, 2)).toBe(true)
  })

  it('never releases below zero', () => {
    const device = makeDevice('dev_budget_c')
    claimTravelCalls(device.deviceId, 1)
    releaseTravelCalls(device.deviceId, 99)
    expect(claimTravelCalls(device.deviceId, MAX_TRAVEL_CALLS_PER_DAY)).toBe(true)
  })

  it('counts per device, not globally', () => {
    const a = makeDevice('dev_budget_d')
    const b = makeDevice('dev_budget_e')
    expect(claimTravelCalls(a.deviceId, MAX_TRAVEL_CALLS_PER_DAY)).toBe(true)
    expect(claimTravelCalls(b.deviceId, 1)).toBe(true)
  })

  it('survives a restart, because a crash-looping process must not reset the ceiling', () => {
    // The reason this moved out of a Map: `jobs` is a table and seedSchedulerJobs() re-seeds on
    // boot, so an in-memory counter resets every ninety seconds while the durable queue keeps
    // handing out billable work. Reading it back is what proves it is not process state.
    const device = makeDevice('dev_budget_f')
    claimTravelCalls(device.deviceId, 10)
    expect(claimTravelCalls(device.deviceId, MAX_TRAVEL_CALLS_PER_DAY - 10)).toBe(true)
    expect(claimTravelCalls(device.deviceId, 1)).toBe(false)
  })
})

describe('estimateJourneyMinutes', () => {
  const mutable = config as unknown as Record<string, unknown>
  beforeEach(() => {
    mutable.maps = { apiKey: KEY }
  })
  afterEach(() => {
    mutable.maps = null
  })

  const journey = (device: ReturnType<typeof makeDevice>, over: Record<string, unknown> = {}) =>
    estimateJourneyMinutes({
      device,
      origin: { address: 'home' },
      destination: { address: 'the dentist' },
      arriveByMillis: ARRIVE,
      departAtMillis: DEPART,
      ...over,
    })

  it('prices a cross-town journey with exactly one billed call', async () => {
    const device = makeDevice('dev_j1')
    const fetchMock = stubFetch(() => minutes(40))

    const est = await journey(device, { originLatLng: WANDSWORTH, destinationLatLng: WEMBLEY })

    expect(est).toEqual({ minutes: 40, source: 'routes', mode: 'TRANSIT', walkMinutes: null, noRoute: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodyOf(fetchMock).travelMode).toBe('TRANSIT')
  })

  it('never asks twice for a walk it already paid for', async () => {
    const device = makeDevice('dev_j2')
    const fetchMock = stubFetch(() => minutes(9))

    const est = await journey(device, { originLatLng: TRAFALGAR, destinationLatLng: LEICESTER })

    expect(est).toMatchObject({ minutes: 9, mode: 'WALK', source: 'routes' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('offers driving when there is no service at that hour', async () => {
    const device = makeDevice('dev_j3')
    const fetchMock = stubFetch((_url, init) => {
      const mode = (JSON.parse(String(init.body)) as { travelMode: string }).travelMode
      return mode === 'DRIVE' ? minutes(25) : okJson({ routes: [] })
    })

    const est = await journey(device, { originLatLng: WANDSWORTH, destinationLatLng: WEMBLEY })

    expect(est).toMatchObject({ minutes: 25, mode: 'DRIVE', source: 'routes', noRoute: false })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('says so rather than inventing a number when nothing routes at all', async () => {
    const device = makeDevice('dev_j4')
    stubFetch(() => okJson({ routes: [] }))

    const est = await journey(device, { originLatLng: WANDSWORTH, destinationLatLng: WEMBLEY })

    // The flat fallback is still carried, but `noRoute` is what stops the caller reporting it as
    // measured. A journey that cannot be made is not a thirty-minute journey.
    expect(est.noRoute).toBe(true)
    expect(est.source).toBe('default')
  })

  it('degrades without a network call when Maps is unconfigured', async () => {
    mutable.maps = null
    const device = makeDevice('dev_j5')
    const fetchMock = stubFetch(() => minutes(40))

    const est = await journey(device)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(est).toEqual({ minutes: 30, source: 'default', mode: 'TRANSIT', walkMinutes: null, noRoute: false })
  })

  it('degrades the same way when we do not know where they are', async () => {
    const device = makeDevice('dev_j6')
    const fetchMock = stubFetch(() => minutes(40))

    const est = await journey(device, { origin: null })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(est.source).toBe('default')
  })

  it('prefers a stated buffer over the settings default when it degrades', async () => {
    const device = makeDevice('dev_j7')
    rememberFact({ deviceId: device.deviceId, key: 'travel.default_buffer', value: 'about 50 minutes' })
    stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }) as Response)

    const est = await journey(device, { originLatLng: WANDSWORTH, destinationLatLng: WEMBLEY })
    expect(est).toMatchObject({ minutes: 50, source: 'fact' })
  })

  it('releases its unspent reservation, so a day of cheap journeys is not four journeys', async () => {
    const device = makeDevice('dev_j8')
    stubFetch(() => minutes(40))

    // Each of these spends ONE call but reserves CALLS_RESERVED_PER_JOURNEY. Without the release
    // the ceiling would mean 13 journeys a day rather than 40.
    for (let i = 0; i < 20; i++) {
      await journey(device, { originLatLng: WANDSWORTH, destinationLatLng: WEMBLEY })
    }
    expect(claimTravelCalls(device.deviceId, MAX_TRAVEL_CALLS_PER_DAY - 20)).toBe(true)
    expect(CALLS_RESERVED_PER_JOURNEY).toBeGreaterThan(1)
  })

  it('degrades rather than half-pricing a journey once the budget is gone', async () => {
    const device = makeDevice('dev_j9')
    claimTravelCalls(device.deviceId, MAX_TRAVEL_CALLS_PER_DAY)
    const fetchMock = stubFetch(() => minutes(40))

    const est = await journey(device, { originLatLng: WANDSWORTH, destinationLatLng: WEMBLEY })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(est.source).toBe('default')
  })
})
