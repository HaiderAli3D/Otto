import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { config } from '../src/config.js'
import { ensureSchema } from '../src/db/client.js'
import { haversineMeters } from '../src/lib/geo.js'
import { rememberFact } from '../src/services/facts.js'
import {
  looksLikeAddress,
  MAX_PLACES_CALLS_PER_DAY,
  resetPlacesBudget,
  resolvePlace,
  searchPlaces,
} from '../src/services/places.js'
import { findSavedPlace, listSavedPlaces, normaliseAlias, rememberPlace } from '../src/services/savedPlaces.js'
import { makeDevice } from './helpers.js'

beforeEach(() => {
  ensureSchema()
  resetPlacesBudget()
  vi.unstubAllGlobals()
})

const KEY = 'test-maps-key'

/** A fetch that records its arguments and replies with whatever the test hands it. */
function stubFetch(impl: (url: string, init: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', fn)
  return fn as unknown as ReturnType<typeof vi.fn>
}

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response

const place = (id: string, name: string, address: string, lat = 51.5, lng = -0.12) => ({
  id,
  displayName: { text: name },
  formattedAddress: address,
  location: { latitude: lat, longitude: lng },
})

describe('searchPlaces speaks the Places (New) Text Search contract', () => {
  it('sends a bounded POST carrying the mandatory field mask and the key', async () => {
    const fetchMock = stubFetch(() => okJson({ places: [place('p1', 'The Ship', 'Jews Row, London')] }))

    await searchPlaces({ apiKey: KEY, query: 'the ship wandsworth', bias: null })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Goog-Api-Key']).toBe(KEY)
    // Mandatory on this method, and the mask is what decides the SKU — assert the exact string so a
    // well-meaning "let's also fetch opening hours" shows up as a red test rather than a bill.
    expect(headers['X-Goog-FieldMask']).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location',
    )
    expect(init.signal).toBeDefined()
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.textQuery).toBe('the ship wandsworth')
    expect(body.locationBias).toBeUndefined()
  })

  it('biases to a circle when it is told roughly where they are', async () => {
    const fetchMock = stubFetch(() => okJson({ places: [] }))

    await searchPlaces({ apiKey: KEY, query: 'the gym', bias: { lat: 51.46, lng: -0.19 } })

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      locationBias?: { circle?: { center?: { latitude: number; longitude: number }; radius?: number } }
    }
    expect(body.locationBias?.circle?.center).toEqual({ latitude: 51.46, longitude: -0.19 })
    expect(body.locationBias?.circle?.radius).toBeGreaterThan(0)
  })

  it('distinguishes "no such place" from "could not find out"', async () => {
    // The whole reason this returns PlaceCandidate[] | null rather than just an array. An empty
    // array lets Otto say "I couldn't find it"; a null must never be reported that way.
    stubFetch(() => okJson({ places: [] }))
    expect(await searchPlaces({ apiKey: KEY, query: 'nowhere', bias: null })).toEqual([])

    stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }) as Response)
    expect(await searchPlaces({ apiKey: KEY, query: 'nowhere', bias: null })).toBeNull()
  })

  it('never throws, whatever the network does', async () => {
    stubFetch(() => {
      throw new Error('socket hang up')
    })
    expect(await searchPlaces({ apiKey: KEY, query: 'anywhere', bias: null })).toBeNull()
  })

  it('drops a candidate with no address rather than inventing one', async () => {
    stubFetch(() =>
      okJson({ places: [{ id: 'p1', displayName: { text: 'Ghost' } }, place('p2', 'Real', '1 Real Road')] }),
    )
    const found = await searchPlaces({ apiKey: KEY, query: 'x', bias: null })
    expect(found).toHaveLength(1)
    expect(found![0]!.address).toBe('1 Real Road')
  })

  it('keeps a candidate whose coordinates are missing, without a bogus latLng', async () => {
    // Coordinates only power the free distance shortcut. Losing them costs a billed probe; making
    // one up would route the owner from the Gulf of Guinea.
    stubFetch(() => okJson({ places: [{ id: 'p1', displayName: { text: 'X' }, formattedAddress: '1 X St' }] }))
    const found = await searchPlaces({ apiKey: KEY, query: 'x', bias: null })
    expect(found![0]!.latLng).toBeNull()
  })
})

describe('looksLikeAddress keeps the pre-Places behaviour free', () => {
  it('recognises what used to go straight to Routes', () => {
    expect(looksLikeAddress('10 Downing Street, London')).toBe(true)
    expect(looksLikeAddress('The Ship, Jews Row, London SW18 1TB')).toBe(true)
    expect(looksLikeAddress('Jews Row, 14')).toBe(true)
  })

  it('does not mistake a bare name for an address', () => {
    expect(looksLikeAddress('the gym')).toBe(false)
    expect(looksLikeAddress('the dentist')).toBe(false)
    expect(looksLikeAddress('mum')).toBe(false)
  })
})

describe('normaliseAlias', () => {
  it('collapses the ways one place gets said', () => {
    expect(normaliseAlias('The Gym')).toBe('gym')
    expect(normaliseAlias('  my  gym ')).toBe('gym')
    expect(normaliseAlias("Mum's")).toBe('mums')
    expect(normaliseAlias('the dentist.')).toBe('dentist')
  })
})

describe('saved places', () => {
  it('upserts by alias so changing gym corrects rather than duplicates', () => {
    const device = makeDevice('dev_places')
    rememberPlace({ deviceId: device.deviceId, alias: 'the gym', address: 'Old Road' })
    rememberPlace({ deviceId: device.deviceId, alias: 'Gym', address: 'New Road' })

    const all = listSavedPlaces(device.deviceId)
    expect(all).toHaveLength(1)
    expect(all[0]!.address).toBe('New Road')
  })

  it('refuses the aliases Otto reads from facts instead', () => {
    // Its own device: every test file shares one in-memory DB across its `it` blocks, so a shared
    // id here would assert against rows the previous test wrote.
    const device = makeDevice('dev_places_reserved')
    // Two rows that can disagree about where the owner lives is the failure this prevents:
    // resolveOrigin reads home.address directly and would never see a shadow copy.
    expect(rememberPlace({ deviceId: device.deviceId, alias: 'home', address: 'X' })).toBeNull()
    expect(rememberPlace({ deviceId: device.deviceId, alias: 'The Office', address: 'X' })).toBeNull()
    expect(listSavedPlaces(device.deviceId)).toHaveLength(0)
  })

  it('round-trips coordinates through the integer micro-degree columns', () => {
    const device = makeDevice('dev_places_coords')
    rememberPlace({
      deviceId: device.deviceId,
      alias: 'gym',
      address: '1 Gym Road',
      latLng: { lat: 51.462345, lng: -0.192345 },
    })
    const row = findSavedPlace(device.deviceId, 'the gym')!
    expect(row.lat).toBe(51462345)
    expect(row.lng).toBe(-192345)
  })
})

describe('resolvePlace ladder', () => {
  const withMapsKey = () => {
    const mutable = config as unknown as Record<string, unknown>
    mutable.maps = { apiKey: KEY }
  }
  afterEach(() => {
    const mutable = config as unknown as Record<string, unknown>
    mutable.maps = null
  })

  it('answers from a saved place without touching the network', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    rememberPlace({ deviceId: device.deviceId, alias: 'gym', address: '1 Gym Road', googlePlaceId: 'p9' })
    const fetchMock = stubFetch(() => okJson({ places: [] }))

    const res = await resolvePlace(device, 'the gym')

    expect(res).toEqual({
      kind: 'resolved',
      place: { placeId: 'p9', label: 'gym', address: '1 Gym Road', latLng: null, source: 'saved', confirmed: true },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts a use, so a saved place outranks a search result later', async () => {
    const device = makeDevice('dev_resolve_uses')
    rememberPlace({ deviceId: device.deviceId, alias: 'gym', address: '1 Gym Road' })
    await resolvePlace(device, 'gym')
    await resolvePlace(device, 'gym')
    expect(findSavedPlace(device.deviceId, 'gym')!.useCount).toBe(2)
  })

  it('reads home and work from facts, never from saved_places', async () => {
    const device = makeDevice('dev_resolve')
    rememberFact({ deviceId: device.deviceId, key: 'home.address', value: '10 Downing Street' })

    const res = await resolvePlace(device, 'home')
    expect(res.kind).toBe('resolved')
    expect(res.kind === 'resolved' && res.place).toMatchObject({ address: '10 Downing Street', source: 'fact' })
  })

  it('says which fact key is missing rather than guessing an address', async () => {
    const device = makeDevice('dev_resolve')
    const res = await resolvePlace(device, 'work')
    expect(res.kind).toBe('unknown')
    expect(res.kind === 'unknown' && res.note).toContain('work.address')
  })

  it('passes a real address through without spending a lookup', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    const fetchMock = stubFetch(() => okJson({ places: [] }))

    const res = await resolvePlace(device, '10 Downing Street, London')

    expect(res.kind === 'resolved' && res.place.source).toBe('literal')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes a single search result', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    stubFetch(() => okJson({ places: [place('p1', 'Hartley & Co', '14 High Street')] }))

    const res = await resolvePlace(device, 'hartley dental')
    expect(res.kind === 'resolved' && res.place).toMatchObject({
      placeId: 'p1',
      address: '14 High Street',
      source: 'places',
      latLng: { lat: 51.5, lng: -0.12 },
    })
  })

  it('asks rather than picking when several places match', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    stubFetch(() =>
      okJson({
        places: [
          place('p1', 'Bupa Dental', 'Mill Road'),
          place('p2', 'Smile Clinic', 'High Street'),
          place('p3', 'Hartley & Co', 'Church Lane'),
        ],
      }),
    )

    const res = await resolvePlace(device, 'the dentist')
    expect(res.kind).toBe('ambiguous')
    expect(res.kind === 'ambiguous' && res.candidates).toHaveLength(3)
  })

  it('does not turn an exact name into a question just because Google padded the list', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    stubFetch(() =>
      okJson({
        places: [
          place('p1', 'Wembley Stadium', 'Wembley HA9 0WS'),
          place('p2', 'Wembley Stadium Store', 'Wembley HA9'),
        ],
      }),
    )

    const res = await resolvePlace(device, 'Wembley Stadium')
    expect(res.kind === 'resolved' && res.place.placeId).toBe('p1')
  })

  it('never uses rank or distance as a tiebreak between equally plausible names', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    // Two exact matches: relevance order says the first, and this must still ask. "The nearest
    // dentist" is not "their dentist" and a confidently wrong destination is the whole risk.
    stubFetch(() =>
      okJson({ places: [place('p1', 'Tesco', 'Near Road'), place('p2', 'Tesco', 'Far Road')] }),
    )
    expect((await resolvePlace(device, 'tesco')).kind).toBe('ambiguous')
  })

  it('marks a sole fuzzy hit unconfirmed, and an exact name match confirmed', async () => {
    // The distinction that decides whether an alarm may ring. One search result is worth planning
    // from and worth talking about; nobody has agreed it is the right place.
    const device = makeDevice('dev_resolve_conf')
    withMapsKey()

    stubFetch(() => okJson({ places: [place('p1', 'Hartley & Co', '14 High Street')] }))
    const fuzzy = await resolvePlace(device, 'a dentist near me')
    expect(fuzzy.kind === 'resolved' && fuzzy.place.confirmed).toBe(false)

    stubFetch(() => okJson({ places: [place('p2', 'Wembley Stadium', 'Wembley HA9 0WS')] }))
    const exact = await resolvePlace(device, 'wembley stadium')
    expect(exact.kind === 'resolved' && exact.place.confirmed).toBe(true)
  })

  it('treats anything the owner authored as confirmed', async () => {
    const device = makeDevice('dev_resolve_owned')
    rememberFact({ deviceId: device.deviceId, key: 'home.address', value: '10 Downing Street' })
    rememberPlace({ deviceId: device.deviceId, alias: 'gym', address: '1 Gym Road' })

    for (const query of ['home', 'the gym', '221B Baker Street, London']) {
      const res = await resolvePlace(device, query)
      expect(res.kind === 'resolved' && res.place.confirmed, query).toBe(true)
    }
  })

  it('resolves straight to a place the owner already chose from an ambiguity', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    const fetchMock = stubFetch(() => okJson({ places: [] }))

    const res = await resolvePlace(device, 'the dentist', { placeId: 'p3', address: 'Church Lane' })

    expect(res.kind === 'resolved' && res.place).toMatchObject({ placeId: 'p3', address: 'Church Lane' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('degrades to a question when the lookup is unreachable, and never claims it does not exist', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    stubFetch(() => ({ ok: false, status: 503, text: async () => 'down' }) as Response)

    const res = await resolvePlace(device, 'the dentist')
    expect(res.kind).toBe('unknown')
    expect(res.kind === 'unknown' && res.note).toContain('unreachable')
  })

  it('asks for the address rather than searching when no key is configured', async () => {
    const device = makeDevice('dev_resolve')
    const fetchMock = stubFetch(() => okJson({ places: [] }))

    const res = await resolvePlace(device, 'the dentist')
    expect(res.kind).toBe('unknown')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops spending once the daily budget is gone', async () => {
    const device = makeDevice('dev_resolve')
    withMapsKey()
    const fetchMock = stubFetch(() => okJson({ places: [] }))

    for (let i = 0; i < MAX_PLACES_CALLS_PER_DAY + 3; i++) {
      await resolvePlace(device, `somewhere ${i}`)
    }

    expect(fetchMock.mock.calls.length).toBe(MAX_PLACES_CALLS_PER_DAY)
  })
})

describe('haversineMeters is only ever a lower bound', () => {
  it('measures a known short hop', () => {
    // Trafalgar Square → Leicester Square, ~350m as the crow flies.
    const d = haversineMeters({ lat: 51.508, lng: -0.128 }, { lat: 51.5105, lng: -0.1305 })
    expect(d).toBeGreaterThan(250)
    expect(d).toBeLessThan(450)
  })

  it('is zero for a point against itself', () => {
    expect(haversineMeters({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 })).toBe(0)
  })
})
