import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { config } from '../src/config.js'
import { ensureSchema } from '../src/db/client.js'
import { rememberFact } from '../src/services/facts.js'
import { updateSettings } from '../src/services/settings.js'
import {
  computeDriveMinutes,
  estimateTravelMinutes,
  MAX_TRAVEL_CALLS_PER_DAY,
  resetTravelBudget,
} from '../src/services/travel.js'
import { makeDevice } from './helpers.js'

beforeEach(() => {
  ensureSchema()
  resetTravelBudget()
  vi.unstubAllGlobals()
})

const KEY = 'test-maps-key'
const DEPART = Date.now() + 3_600_000

/** A fetch that records its arguments and replies with whatever the test hands it. */
function stubFetch(impl: (url: string, init: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', fn)
  return fn as unknown as ReturnType<typeof vi.fn>
}

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response

describe('computeDriveMinutes speaks the Routes v2 contract', () => {
  it('parses the documented "2280s" duration into whole minutes', async () => {
    stubFetch(() => okJson({ routes: [{ duration: '2280s' }] }))

    expect(
      await computeDriveMinutes({
        apiKey: KEY,
        originAddress: '10 Downing Street, London',
        destinationAddress: 'The Ship, Wandsworth',
        departAtMillis: DEPART,
      }),
    ).toBe(38)
  })

  it('sends a bounded request carrying the mandatory field mask', async () => {
    const fetchMock = stubFetch(() => okJson({ routes: [{ duration: '600s' }] }))

    await computeDriveMinutes({
      apiKey: KEY,
      originAddress: 'home',
      destinationAddress: 'work',
      departAtMillis: DEPART,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes')
    // Without a signal a black-holed socket hangs for undici's ~5 minutes, inside an agent turn.
    expect(init.signal).not.toBeNull()
    expect(init.signal).toBeDefined()
    const headers = init.headers as Record<string, string>
    expect(headers['X-Goog-FieldMask']).toBe('routes.duration')
    expect(headers['X-Goog-Api-Key']).toBe(KEY)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    // Free-text waypoints are the entire reason Routes was chosen over Distance Matrix: an event
    // location is arbitrary prose and a `location.latLng` shape would need a Geocoding call first.
    expect(body.origin).toEqual({ address: 'home' })
    expect(body.destination).toEqual({ address: 'work' })
    expect(body.travelMode).toBe('DRIVE')
    expect(body.routingPreference).toBe('TRAFFIC_AWARE')
  })

  it('clamps a departure in the past — Routes rejects one outright for DRIVE', async () => {
    const fetchMock = stubFetch(() => okJson({ routes: [{ duration: '600s' }] }))

    await computeDriveMinutes({
      apiKey: KEY,
      originAddress: 'home',
      destinationAddress: 'work',
      departAtMillis: Date.now() - 3_600_000,
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { departureTime: string }
    expect(Date.parse(body.departureTime)).toBeGreaterThan(Date.now())
  })

  it('returns null when there is no route rather than inventing one', async () => {
    stubFetch(() => okJson({ routes: [] }))
    expect(
      await computeDriveMinutes({ apiKey: KEY, originAddress: 'a', destinationAddress: 'b', departAtMillis: DEPART }),
    ).toBeNull()
  })

  it('returns null on a non-200', async () => {
    stubFetch(() => ({ ok: false, status: 403, text: async () => 'PERMISSION_DENIED' }) as Response)
    expect(
      await computeDriveMinutes({ apiKey: KEY, originAddress: 'a', destinationAddress: 'b', departAtMillis: DEPART }),
    ).toBeNull()
  })

  it('returns null when the request aborts on its timeout', async () => {
    stubFetch(() => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'AbortError'
      throw err
    })
    expect(
      await computeDriveMinutes({ apiKey: KEY, originAddress: 'a', destinationAddress: 'b', departAtMillis: DEPART }),
    ).toBeNull()
  })

  it('returns null for a duration it cannot read', async () => {
    stubFetch(() => okJson({ routes: [{ duration: 'about half an hour' }] }))
    expect(
      await computeDriveMinutes({ apiKey: KEY, originAddress: 'a', destinationAddress: 'b', departAtMillis: DEPART }),
    ).toBeNull()
  })
})

describe('estimateTravelMinutes degrades without ever failing', () => {
  it('has no Maps key configured in tests — the precondition for everything below', () => {
    expect(config.maps).toBeNull()
  })

  it('does not touch the network at all when Maps is unconfigured', async () => {
    const device = makeDevice('dev_tr1')
    const fetchMock = stubFetch(() => okJson({ routes: [{ duration: '600s' }] }))

    const estimate = await estimateTravelMinutes(device, 'home', 'work', DEPART)

    // THE degradation guarantee: no key means no call, not a call that fails. A 403 per plan on a
    // scheduler chain is a quota bill for nothing.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(estimate).toEqual({ minutes: 30, source: 'default' })
  })

  it('prefers a stated travel buffer over the settings default', async () => {
    const device = makeDevice('dev_tr2')
    // Facts are documented to the model as ONE short sentence, so this is prose far more often
    // than it is a number.
    rememberFact({ deviceId: device.deviceId, key: 'travel.default_buffer', value: 'Allow about 40 minutes anywhere' })

    expect(await estimateTravelMinutes(device, 'home', 'work', DEPART)).toEqual({ minutes: 40, source: 'fact' })
  })

  it('falls back to the device default when the fact holds no number', async () => {
    const device = makeDevice('dev_tr3')
    rememberFact({ deviceId: device.deviceId, key: 'travel.default_buffer', value: 'depends on the traffic' })
    updateSettings(device.deviceId, { defaultTravelMinutes: 25 })

    expect(await estimateTravelMinutes(device, 'home', 'work', DEPART)).toEqual({ minutes: 25, source: 'default' })
  })

  it('degrades the same way when there is no origin at all', async () => {
    const device = makeDevice('dev_tr4')
    // The phone reports no location, ever. "We don't know where they are" is a normal state.
    expect(await estimateTravelMinutes(device, null, 'work', DEPART)).toEqual({ minutes: 30, source: 'default' })
  })
})

describe('the daily spend guard', () => {
  // The one path a test suite with no Maps key can never reach on its own — and the one worth
  // reaching, because it is the only thing standing between a looping scheduler and the owner's
  // card. `config` is a plain object; `as const` is compile-time only.
  const mutable = config as unknown as Record<string, unknown>

  beforeEach(() => {
    mutable.maps = { apiKey: KEY }
  })
  afterEach(() => {
    mutable.maps = null
  })

  it('stops calling Routes after the daily cap and degrades instead', async () => {
    const device = makeDevice('dev_tr5')
    const fetchMock = stubFetch(() => okJson({ routes: [{ duration: '1200s' }] }))

    const results = []
    for (let i = 0; i < MAX_TRAVEL_CALLS_PER_DAY + 3; i++) {
      results.push(await estimateTravelMinutes(device, 'home', 'work', DEPART))
    }

    expect(fetchMock).toHaveBeenCalledTimes(MAX_TRAVEL_CALLS_PER_DAY)
    expect(results[0]).toEqual({ minutes: 20, source: 'routes' })
    // Over the cap it degrades, exactly as it would with no key at all — never throws, never stalls.
    expect(results[MAX_TRAVEL_CALLS_PER_DAY]).toEqual({ minutes: 30, source: 'default' })
  })

  it('counts per device, not globally', async () => {
    const a = makeDevice('dev_tr6')
    const b = makeDevice('dev_tr7')
    const fetchMock = stubFetch(() => okJson({ routes: [{ duration: '600s' }] }))

    for (let i = 0; i < MAX_TRAVEL_CALLS_PER_DAY; i++) await estimateTravelMinutes(a, 'home', 'work', DEPART)
    const other = await estimateTravelMinutes(b, 'home', 'work', DEPART)

    expect(other).toEqual({ minutes: 10, source: 'routes' })
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TRAVEL_CALLS_PER_DAY + 1)
  })
})
