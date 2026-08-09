import { and, eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { travelCalls } from '../db/schema.js'
import { haversineMeters, type LatLng } from '../lib/geo.js'
import { log } from '../lib/log.js'
import type { Device } from './devices.js'
import { factValue } from './facts.js'
import { getSettings } from './settings.js'

/**
 * Travel time between two places, via the Google Routes API v2.
 *
 * Routes rather than Distance Matrix because a Routes waypoint accepts a free-text `address` and
 * geocodes it itself. That is decisive here and not a preference: a calendar event's location is
 * arbitrary prose ("The Ship, Wandsworth"), and the alternative is a separate Geocoding call —
 * another key, another quota, another failure mode — in front of every estimate.
 *
 * Verified against the live reference (developers.google.com/maps/documentation/routes) before
 * implementing: `Waypoint.address` is documented as "Human readable address or a plus code", the
 * response `duration` is "a duration in seconds with up to nine fractional digits, ending with 's'"
 * (e.g. "165s"), and `X-Goog-FieldMask` is mandatory on this method.
 */

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'

/** Shorter than the 15s the Graph and FCM callers use: this sits inside an agent turn. */
const TIMEOUT_MS = 8_000

/**
 * Routes rejects a `departureTime` in the past for DRIVE (only TRANSIT accepts one), and a recheck
 * naturally asks about a departure that is nearly now. Clamp rather than let the call 400.
 */
const DEPARTURE_FLOOR_MS = 60_000

/**
 * Per-device ceiling on billed Routes calls per day.
 *
 * This is a personal server with the owner's card attached and a scheduler that reschedules its own
 * job rows. One bug that turns a chain into a tight loop is all it takes, and the first sign would
 * be the bill.
 *
 * Counted in REQUESTS, not journeys, because requests are what the bill counts. A journey costs one
 * or two of them — a walk probe, then the route — so the ceiling was doubled from 20 when transit
 * landed, rather than leaving the same number quietly mean half as many journeys.
 *
 * PERSISTED, and that changed with this feature. It used to live in a Map, justified by "a restart
 * clearing it is the correct failure mode — the runaway loop it exists to stop does not survive the
 * restart either". That was true while the only spender was an in-process chain. It is false now
 * that `jobs` is a SQLite table, `rescheduleJob` persists, and `seedSchedulerJobs()` re-seeds on
 * every boot: a container crash-looping every ninety seconds would reset an in-memory counter every
 * ninety seconds while the durable queue kept handing out billable work.
 */
export const MAX_TRAVEL_CALLS_PER_DAY = 40

/**
 * What one journey may spend: a walk probe, the route itself, and one retry when transit says there
 * is no service. Reserved up front and released unused, so a cap can never trip BETWEEN the probe
 * and the route — which would produce a journey priced by one mode and planned as another.
 */
export const CALLS_RESERVED_PER_JOURNEY = 3

/** UTC day, not the device's: this bounds SPEND, and the bill is not keyed on anyone's timezone. */
const utcDayKey = (nowMillis: number): string => new Date(nowMillis).toISOString().slice(0, 10)

/**
 * Claim `n` calls, or none at all.
 *
 * All-or-nothing on purpose (see CALLS_RESERVED_PER_JOURNEY). The read-modify-write is safe without
 * an explicit transaction only because better-sqlite3 is synchronous and there is no `await`
 * between the read and the write — no other JS on this loop can interleave. Do not make it async.
 */
export function claimTravelCalls(deviceId: string, n: number, nowMillis = Date.now()): boolean {
  const dayKey = utcDayKey(nowMillis)
  const row = db
    .select()
    .from(travelCalls)
    .where(and(eq(travelCalls.deviceId, deviceId), eq(travelCalls.dayKey, dayKey)))
    .get()
  const used = row?.count ?? 0
  if (used + n > MAX_TRAVEL_CALLS_PER_DAY) return false
  db.insert(travelCalls)
    .values({ deviceId, dayKey, count: used + n })
    .onConflictDoUpdate({
      target: [travelCalls.deviceId, travelCalls.dayKey],
      set: { count: used + n },
    })
    .run()
  return true
}

/** Hand back calls a journey reserved and did not need. Never below zero. */
export function releaseTravelCalls(deviceId: string, n: number, nowMillis = Date.now()): void {
  if (n <= 0) return
  const dayKey = utcDayKey(nowMillis)
  const row = db
    .select()
    .from(travelCalls)
    .where(and(eq(travelCalls.deviceId, deviceId), eq(travelCalls.dayKey, dayKey)))
    .get()
  if (!row) return
  db.update(travelCalls)
    .set({ count: Math.max(0, row.count - n) })
    .where(and(eq(travelCalls.deviceId, deviceId), eq(travelCalls.dayKey, dayKey)))
    .run()
}

/** Reset the budget. Exported for tests, which must not inherit each other's counts. */
export function resetTravelBudget(): void {
  db.delete(travelCalls).run()
}

/**
 * How the owner is getting there.
 *
 * TWO_WHEELER exists in the API and is deliberately absent: nothing in Otto can distinguish a moped
 * from a car for the owner, and an unreachable enum member is a member somebody eventually passes.
 */
export type TravelMode = 'DRIVE' | 'TRANSIT' | 'WALK' | 'BICYCLE'

/**
 * One end of a journey, in the three shapes Routes accepts.
 *
 * `placeId` is preferred over `address` wherever Places has already resolved somewhere: the address
 * was geocoded once already, and handing Routes the free text again is a second, independent chance
 * to pick the wrong branch of the same chain.
 */
export type Waypoint = { address: string } | { latLng: LatLng } | { placeId: string }

function wireWaypoint(w: Waypoint): unknown {
  if ('address' in w) return { address: w.address }
  if ('placeId' in w) return { placeId: w.placeId }
  return { location: { latLng: { latitude: w.latLng.lat, longitude: w.latLng.lng } } }
}

/**
 * What Routes said.
 *
 * `no-route` and `unknown` are DIFFERENT answers and collapsing them is a real bug, not a nicety.
 * "There is no tube at 05:00" is Google telling us something true, and the honest response is to
 * offer a cab or refuse; a 500 is Google telling us nothing. Before this distinction existed both
 * returned null, the caller fell through to the estimate ladder, and the owner was told a
 * confident "about 30 minutes" for a journey that cannot be made at all.
 */
export type RouteAnswer = { kind: 'route'; minutes: number } | { kind: 'no-route' } | { kind: 'unknown' }

/**
 * Minutes for one journey by one mode, from Routes. NEVER throws.
 *
 * The API key is a PARAMETER, not read from `config` — the same split as `adminTokenRequired`, and
 * for the same reason: `config` is parsed once at import and cannot be varied per test, so a
 * function that reached for `config.maps` here would be untestable in a suite that deliberately
 * leaves the key unset. `estimateTravelMinutes` below is the one place that consults config.
 *
 * Three body rules, and each one is a silent-failure trap if broken. Routes answers a malformed
 * request with a 400, this function turns that into `unknown`, the caller degrades to the ladder,
 * and the result is a feature that looks finished and is never once right:
 *
 *  1. `routingPreference` ONLY for DRIVE. Routes: "You can specify this option only when the
 *     travelMode is DRIVE or TWO_WHEELER, otherwise the request fails."
 *  2. `arrivalTime` ONLY for TRANSIT, and never alongside `departureTime` — Routes documents it as
 *     ignored for every other mode and rejects both together.
 *  3. No time field at all for WALK and BICYCLE. Walking time does not depend on the clock, and
 *     omitting it removes the past-departure clamp and one more way to 400.
 */
export async function computeRouteMinutes(p: {
  apiKey: string
  origin: Waypoint
  destination: Waypoint
  mode: TravelMode
  departAtMillis?: number
  /** TRANSIT ONLY. When they must BE there — the quantity a timetable can actually answer. */
  arriveByMillis?: number
}): Promise<RouteAnswer> {
  const body: Record<string, unknown> = {
    origin: wireWaypoint(p.origin),
    destination: wireWaypoint(p.destination),
    travelMode: p.mode,
  }
  if (p.mode === 'DRIVE') {
    // Not TRAFFIC_AWARE_OPTIMAL: a higher SKU and seconds of extra latency, to buy precision that
    // disappears into the get-ready buffer anyway.
    body.routingPreference = 'TRAFFIC_AWARE'
  }
  if (p.mode === 'TRANSIT' && p.arriveByMillis !== undefined) {
    body.arrivalTime = new Date(p.arriveByMillis).toISOString()
  } else if (p.mode === 'DRIVE' || p.mode === 'TRANSIT') {
    const depart = Math.max(p.departAtMillis ?? Date.now(), Date.now() + DEPARTURE_FLOOR_MS)
    body.departureTime = new Date(depart).toISOString()
  }

  try {
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': p.apiKey,
        // Mandatory on computeRoutes, and kept to the single field we use: a narrow mask is what
        // keeps this request in the cheaper Essentials SKU rather than the Advanced one.
        'X-Goog-FieldMask': 'routes.duration',
      },
      body: JSON.stringify(body),
      // Without a signal a black-holed socket hangs on undici's ~5 minute default, inside an agent
      // turn or a scheduler tick that will not start the next one until this returns.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      log.warn({ status: res.status, mode: p.mode, body: text.slice(0, 300) }, 'routes: computeRoutes failed')
      return { kind: 'unknown' }
    }
    const json = (await res.json()) as { routes?: Array<{ duration?: string }> }
    // An empty `routes` is Google's real answer: no way to make this journey by this mode. An
    // unroutable address produces the same shape, which is why the caller must never turn this into
    // a flat refusal on its own — it retries by another mode first.
    const duration = json.routes?.[0]?.duration
    if (typeof duration !== 'string') return { kind: 'no-route' }
    const seconds = Number.parseFloat(duration.replace(/s$/, ''))
    if (!Number.isFinite(seconds) || seconds < 0) return { kind: 'unknown' }
    return { kind: 'route', minutes: Math.ceil(seconds / 60) }
  } catch (err) {
    // Includes the AbortError from the timeout. Every failure is the same failure to the caller.
    log.warn({ err, mode: p.mode }, 'routes: computeRoutes threw')
    return { kind: 'unknown' }
  }
}

/**
 * Driving minutes between two free-text addresses, or null if we could not find out.
 *
 * A wrapper with the ORIGINAL signature and the original wire bytes, kept deliberately rather than
 * migrating its callers: `test/travel.test.ts` pins this exact request — the waypoint shape, the
 * travel mode, the routing preference, the field mask, the abort signal and the past-departure
 * clamp — and leaving that file untouched and green is the regression assertion for the refactor
 * above. It collapses `no-route` back to null because that is what its callers were written for.
 *
 * Deliberately ONE call: no fixed-point iteration towards a departure time consistent with the
 * travel time it implies. THIS ARGUMENT IS DRIVE-SPECIFIC and does not carry to transit. Driving
 * time is a continuous function of departure, so the residual error over a 30-minute drive is a
 * couple of minutes — smaller than the buffer the caller already adds. A timetable is a STEP
 * function: leaving at 14:25 rather than 14:35 can be twenty minutes' difference on a service that
 * runs every twenty. That is why transit asks by `arrivalTime` instead (see computeRouteMinutes).
 */
export const computeDriveMinutes = async (p: {
  apiKey: string
  originAddress: string
  destinationAddress: string
  departAtMillis: number
}): Promise<number | null> => {
  const answer = await computeRouteMinutes({
    apiKey: p.apiKey,
    origin: { address: p.originAddress },
    destination: { address: p.destinationAddress },
    mode: 'DRIVE',
    departAtMillis: p.departAtMillis,
  })
  return answer.kind === 'route' ? answer.minutes : null
}

/** The owner's rule, verbatim: "always public transport, unless it's less than a 15 minute walk." */
export const WALK_CEILING_MINUTES = 15

/** Ordinary walking pace. Google's own WALK routes come out close to this. */
const WALK_METRES_PER_MINUTE = 80

/**
 * How far apart, as the crow flies, is worth ASKING Routes about a walk.
 *
 * 15 min × 80 m/min is 1200 m of pavement, and street distance is never SHORTER than the straight
 * line — so beyond this radius a sub-15-minute walk is geometrically impossible and the probe is a
 * billed request whose answer we already have. This is the free half of the decision and it is the
 * common case: a dentist across town never costs a probe.
 */
export const WALK_PROBE_RADIUS_M = WALK_CEILING_MINUTES * WALK_METRES_PER_MINUTE

/**
 * Slack added to a transit departure by the planner (not by the estimate — this is a planning
 * decision, and `minutes` stays the honest journey time).
 *
 * A missed connection is not the owner being late. Routes answers with one itinerary; miss its
 * first leg by ninety seconds and the next one may be twenty minutes behind it.
 */
export const TRANSIT_SLACK_MINUTES = 5

export type ModeDecision = {
  mode: TravelMode
  reason: 'override' | 'walk' | 'too-far-to-walk' | 'walk-too-long' | 'no-probe' | 'unknown-walk'
  /** The WALK minutes when we actually paid for them — so the caller never asks twice. */
  walkMinutes: number | null
  callsSpent: number
}

/**
 * Transit, unless it is a short walk.
 *
 * ⚠️ The mode is only ever decided from a LIVE route. That is the whole safety property here, and
 * the reason `chooseTravelMode` takes an api key rather than calling `estimateJourneyMinutes`:
 * `estimateTravelMinutes` never fails, and it returns the same number whatever mode you asked for.
 * So a rule written as `if (walkMinutes < 15) walk` against the fallback ladder silently degrades
 * into "is the owner's stated commute buffer under fifteen minutes?" — and a `travel.default_buffer`
 * of "about 10 minutes to the station" would send them walking to somewhere across the city that was
 * never priced. When we cannot find out, the answer is transit.
 */
export async function chooseTravelMode(p: {
  apiKey: string
  origin: Waypoint
  destination: Waypoint
  originLatLng: LatLng | null
  destinationLatLng: LatLng | null
  override?: TravelMode | null
  probeAllowed: boolean
}): Promise<ModeDecision> {
  if (p.override) {
    return { mode: p.override, reason: 'override', walkMinutes: null, callsSpent: 0 }
  }
  if (
    p.originLatLng !== null &&
    p.destinationLatLng !== null &&
    haversineMeters(p.originLatLng, p.destinationLatLng) > WALK_PROBE_RADIUS_M
  ) {
    return { mode: 'TRANSIT', reason: 'too-far-to-walk', walkMinutes: null, callsSpent: 0 }
  }
  if (!p.probeAllowed) {
    return { mode: 'TRANSIT', reason: 'no-probe', walkMinutes: null, callsSpent: 0 }
  }

  const walk = await computeRouteMinutes({
    apiKey: p.apiKey,
    origin: p.origin,
    destination: p.destination,
    mode: 'WALK',
  })
  if (walk.kind !== 'route') {
    return { mode: 'TRANSIT', reason: 'unknown-walk', walkMinutes: null, callsSpent: 1 }
  }
  return walk.minutes <= WALK_CEILING_MINUTES
    ? { mode: 'WALK', reason: 'walk', walkMinutes: walk.minutes, callsSpent: 1 }
    : { mode: 'TRANSIT', reason: 'walk-too-long', walkMinutes: walk.minutes, callsSpent: 1 }
}

export type TravelEstimate = { minutes: number; source: 'routes' | 'fact' | 'default' }

export type JourneyEstimate = TravelEstimate & {
  mode: TravelMode
  /** What the walk would have been, when we paid to find out. Lets Otto say "it's a 25 minute walk". */
  walkMinutes: number | null
  /** Google says this journey cannot be made by any mode we tried. Never plan around a number here. */
  noRoute: boolean
}

/**
 * How long the journey takes, by the best means available. NEVER fails.
 *
 * The ladder is real traffic → what the owner told us → the configured default, and `source` is
 * carried out so the caller can act on the difference: only a 'routes' answer is ever good enough
 * to arm an alarm without being asked. A guess that rings the phone at 05:40 is the failure that
 * kills this feature; a guess that produces a slightly wrong OFFER costs nothing.
 *
 * A missing origin skips straight to the ladder rather than guessing one — "we don't know where
 * they are" is a real and common state.
 */
export async function estimateTravelMinutes(
  device: Device,
  originAddress: string | null,
  destinationAddress: string,
  departAtMillis: number,
): Promise<TravelEstimate> {
  if (config.maps !== null && originAddress && destinationAddress) {
    if (claimTravelCalls(device.deviceId, 1)) {
      const minutes = await computeDriveMinutes({
        apiKey: config.maps.apiKey,
        originAddress,
        destinationAddress,
        departAtMillis,
      })
      if (minutes !== null) return { minutes, source: 'routes' }
    } else {
      log.warn({ deviceId: device.deviceId, cap: MAX_TRAVEL_CALLS_PER_DAY }, 'routes: daily call budget spent')
    }
  }
  return ladder(device)
}

/**
 * The mode-aware sibling of `estimateTravelMinutes`, and the one journeys use.
 *
 * Same never-fails contract, same ladder, same rule that only a live number auto-arms. The
 * difference is that it decides HOW they are getting there first, and asks the timetable by arrival
 * time rather than guessing a departure.
 */
export async function estimateJourneyMinutes(p: {
  device: Device
  origin: Waypoint | null
  destination: Waypoint
  originLatLng?: LatLng | null
  destinationLatLng?: LatLng | null
  modeOverride?: TravelMode | null
  /** When they must BE there. TRANSIT asks the timetable with this rather than a guessed departure. */
  arriveByMillis: number
  /** The bootstrap guess, for DRIVE only. TRANSIT never reads it and WALK sends no time at all. */
  departAtMillis: number
}): Promise<JourneyEstimate> {
  const fallbackMode = p.modeOverride ?? 'TRANSIT'
  if (config.maps === null || p.origin === null) {
    return { ...ladder(p.device), mode: fallbackMode, walkMinutes: null, noRoute: false }
  }

  // Reserve the worst case up front and hand back what we don't spend. Claiming per call instead
  // would let the cap trip between the probe and the route — a journey priced as a walk and planned
  // as transit, which is the one outcome worse than not answering.
  if (!claimTravelCalls(p.device.deviceId, CALLS_RESERVED_PER_JOURNEY)) {
    log.warn({ deviceId: p.device.deviceId, cap: MAX_TRAVEL_CALLS_PER_DAY }, 'routes: daily call budget spent')
    return { ...ladder(p.device), mode: fallbackMode, walkMinutes: null, noRoute: false }
  }

  const apiKey = config.maps.apiKey
  let spent = 0
  try {
    const decision = await chooseTravelMode({
      apiKey,
      origin: p.origin,
      destination: p.destination,
      originLatLng: p.originLatLng ?? null,
      destinationLatLng: p.destinationLatLng ?? null,
      override: p.modeOverride ?? null,
      probeAllowed: true,
    })
    spent += decision.callsSpent

    // A walk we already paid for. Asking again for the same number is a billed request for nothing.
    if (decision.mode === 'WALK' && decision.walkMinutes !== null) {
      return { minutes: decision.walkMinutes, source: 'routes', mode: 'WALK', walkMinutes: decision.walkMinutes, noRoute: false }
    }

    const answer = await routeFor(apiKey, p, decision.mode)
    spent += 1
    if (answer.kind === 'route') {
      return {
        minutes: answer.minutes,
        source: 'routes',
        mode: decision.mode,
        walkMinutes: decision.walkMinutes,
        noRoute: false,
      }
    }

    // No service at that hour is the normal reason a transit route comes back empty. A cab is the
    // honest alternative, and offering one beats reporting the flat fallback as if it were measured.
    if (answer.kind === 'no-route' && decision.mode === 'TRANSIT') {
      const driving = await routeFor(apiKey, p, 'DRIVE')
      spent += 1
      if (driving.kind === 'route') {
        return {
          minutes: driving.minutes,
          source: 'routes',
          mode: 'DRIVE',
          walkMinutes: decision.walkMinutes,
          noRoute: false,
        }
      }
      return { ...ladder(p.device), mode: decision.mode, walkMinutes: decision.walkMinutes, noRoute: true }
    }

    return {
      ...ladder(p.device),
      mode: decision.mode,
      walkMinutes: decision.walkMinutes,
      noRoute: answer.kind === 'no-route',
    }
  } finally {
    releaseTravelCalls(p.device.deviceId, CALLS_RESERVED_PER_JOURNEY - spent)
  }
}

function routeFor(
  apiKey: string,
  p: { origin: Waypoint | null; destination: Waypoint; arriveByMillis: number; departAtMillis: number },
  mode: TravelMode,
): Promise<RouteAnswer> {
  return computeRouteMinutes({
    apiKey,
    origin: p.origin!,
    destination: p.destination,
    mode,
    // Transit answers "what gets me there by then"; everything else answers "how long from now".
    ...(mode === 'TRANSIT' ? { arriveByMillis: p.arriveByMillis } : { departAtMillis: p.departAtMillis }),
  })
}

/** What the owner told us, then what the settings say. The half of the ladder that never fails. */
function ladder(device: Device): TravelEstimate {
  const stated = parseBufferMinutes(factValue(device.deviceId, 'travel.default_buffer'))
  if (stated !== null) return { minutes: stated, source: 'fact' }
  return { minutes: getSettings(device.deviceId).defaultTravelMinutes, source: 'default' }
}

/**
 * Minutes out of a fact value.
 *
 * Facts are documented to the model as ONE short sentence, so this is prose ("about 40 minutes to
 * most places") far more often than it is a number. Take the first plausible number and ignore
 * anything absurd; an unparseable fact falls through to the settings default rather than throwing.
 *
 * HOURS are read before minutes, and that ordering is the whole point rather than a nicety. A bare
 * first-integer scan reads "about 1 hour door to door" as ONE minute, and one minute of travel is
 * not a wrong estimate but an actively dangerous one: it arms "Leave now" sixty seconds before the
 * meeting and tells the owner, in as many words, that the journey takes a minute. Anything the
 * owner is at all likely to write for a commute — "1 hour", "1.5 hrs", "2h" — has to land in the
 * right unit or this fallback is worse than having no fact at all.
 */
function parseBufferMinutes(value: string | null): number | null {
  if (!value) return null
  const hours = /(\d{1,2}(?:\.\d+)?)\s*(?:h\b|hr|hour)/i.exec(value)
  const minutes = hours ? Math.round(Number(hours[1]) * 60) : Number(/(\d{1,3})/.exec(value)?.[1] ?? Number.NaN)
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) return null
  return minutes
}
