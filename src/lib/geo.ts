/**
 * Straight-line distance between two coordinates.
 *
 * Zero imports on purpose. Both `services/places.ts` (which produces coordinates) and
 * `services/travel.ts` (which decides whether a walk is even worth pricing) need this, and a helper
 * living in either of them would make the other import a module it has no other business knowing
 * about. `lib/` is where this codebase already puts arithmetic that several services share.
 */

export type LatLng = { lat: number; lng: number }

/** IUGG mean Earth radius. The choice is irrelevant at the distances this is used for. */
const EARTH_RADIUS_M = 6_371_008.8

const toRadians = (deg: number): number => (deg * Math.PI) / 180

/**
 * Great-circle distance in metres.
 *
 * Used as a CHEAP LOWER BOUND, never as a travel distance: street distance is never shorter than the
 * straight line, so "further apart than X as the crow flies" is a sound reason to skip asking a paid
 * API about a walk, while "close together" proves nothing (a river with no bridge is 200 m and forty
 * minutes). Every caller must only ever use it to rule a route OUT.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** True when both coordinates are real numbers in range. Google occasionally omits one half. */
export function isLatLng(value: unknown): value is LatLng {
  if (typeof value !== 'object' || value === null) return false
  const { lat, lng } = value as Partial<LatLng>
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  )
}
