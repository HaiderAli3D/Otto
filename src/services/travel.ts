import { config } from '../config.js'
import { log } from '../lib/log.js'
import type { Device } from './devices.js'
import { factValue } from './facts.js'
import { getSettings } from './settings.js'

/**
 * Travel time between two free-text addresses, via the Google Routes API v2.
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
 * be the bill. In memory rather than in the database on purpose: it needs to bound *this process's*
 * spending and cost nothing to check, and a restart clearing it is the correct failure mode — the
 * runaway loop it exists to stop does not survive the restart either.
 */
export const MAX_TRAVEL_CALLS_PER_DAY = 20

const callsToday = new Map<string, { dayKey: string; count: number }>()

/** UTC day, not the device's: this bounds SPEND, and the bill is not keyed on anyone's timezone. */
function claimTravelCall(deviceId: string, nowMillis: number): boolean {
  const dayKey = new Date(nowMillis).toISOString().slice(0, 10)
  const entry = callsToday.get(deviceId)
  if (!entry || entry.dayKey !== dayKey) {
    callsToday.set(deviceId, { dayKey, count: 1 })
    return true
  }
  if (entry.count >= MAX_TRAVEL_CALLS_PER_DAY) return false
  entry.count += 1
  return true
}

/** Reset the in-memory budget. Exported for tests, which must not inherit each other's counts. */
export function resetTravelBudget(): void {
  callsToday.clear()
}

/**
 * Driving minutes between two free-text addresses, or null if we could not find out.
 *
 * The API key is a PARAMETER, not read from `config` — the same split as `adminTokenRequired`, and
 * for the same reason: `config` is parsed once at import and cannot be varied per test, so a
 * function that reached for `config.maps` here would be untestable in a suite that deliberately
 * leaves the key unset. `estimateTravelMinutes` below is the one place that consults config.
 *
 * Deliberately ONE call: no fixed-point iteration towards a departure time consistent with the
 * travel time it implies. The residual error over a 30-minute drive is a couple of minutes, which
 * is smaller than the buffer the caller already adds, and each iteration is another billed request
 * and another second of latency.
 */
export async function computeDriveMinutes(p: {
  apiKey: string
  originAddress: string
  destinationAddress: string
  departAtMillis: number
}): Promise<number | null> {
  const departureTime = new Date(Math.max(p.departAtMillis, Date.now() + DEPARTURE_FLOOR_MS)).toISOString()
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
      body: JSON.stringify({
        origin: { address: p.originAddress },
        destination: { address: p.destinationAddress },
        travelMode: 'DRIVE',
        // Not TRAFFIC_AWARE_OPTIMAL: a higher SKU and seconds of extra latency, to buy precision
        // that disappears into the get-ready buffer anyway.
        routingPreference: 'TRAFFIC_AWARE',
        departureTime,
      }),
      // Without a signal a black-holed socket hangs on undici's ~5 minute default, inside an agent
      // turn or a scheduler tick that will not start the next one until this returns.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.warn({ status: res.status, body: body.slice(0, 300) }, 'routes: computeRoutes failed')
      return null
    }
    const json = (await res.json()) as { routes?: Array<{ duration?: string }> }
    // No route at all is the normal answer for an unroutable address — an ocean crossing, or a
    // "home.address" fact that turned out to be prose. Null, not an error: the caller degrades.
    const duration = json.routes?.[0]?.duration
    if (typeof duration !== 'string') return null
    const seconds = Number.parseFloat(duration.replace(/s$/, ''))
    if (!Number.isFinite(seconds) || seconds < 0) return null
    return Math.ceil(seconds / 60)
  } catch (err) {
    // Includes the AbortError from the timeout. Every failure is the same failure to the caller.
    log.warn({ err }, 'routes: computeRoutes threw')
    return null
  }
}

export type TravelEstimate = { minutes: number; source: 'routes' | 'fact' | 'default' }

/**
 * How long the journey takes, by the best means available. NEVER fails.
 *
 * The ladder is real traffic → what the owner told us → the configured default, and `source` is
 * carried out so the caller can act on the difference: only a 'routes' answer is ever good enough
 * to arm an alarm without being asked. A guess that rings the phone at 05:40 is the failure that
 * kills this feature; a guess that produces a slightly wrong OFFER costs nothing.
 *
 * A missing origin skips straight to the ladder rather than guessing one — the phone reports no
 * location, ever, so "we don't know where they are" is a real and common state.
 */
export async function estimateTravelMinutes(
  device: Device,
  originAddress: string | null,
  destinationAddress: string,
  departAtMillis: number,
): Promise<TravelEstimate> {
  if (config.maps !== null && originAddress && destinationAddress) {
    if (claimTravelCall(device.deviceId, Date.now())) {
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
  const stated = parseBufferMinutes(factValue(device.deviceId, 'travel.default_buffer'))
  if (stated !== null) return { minutes: stated, source: 'fact' }
  return { minutes: getSettings(device.deviceId).defaultTravelMinutes, source: 'default' }
}

/**
 * Minutes out of a fact value.
 *
 * Facts are documented to the model as ONE short sentence, so this is prose ("about 40 minutes to
 * most places") far more often than it is a number. Take the first plausible integer and ignore
 * anything absurd; an unparseable fact falls through to the settings default rather than throwing.
 */
function parseBufferMinutes(value: string | null): number | null {
  if (!value) return null
  const m = /(\d{1,3})/.exec(value)
  if (!m) return null
  const minutes = Number(m[1])
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) return null
  return minutes
}
