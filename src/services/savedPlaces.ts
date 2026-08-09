import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { savedPlaces } from '../db/schema.js'
import { isLatLng, type LatLng } from '../lib/geo.js'
import { newSavedPlaceId } from '../lib/ids.js'

/**
 * Places the owner has a name for. The table layer only — the resolution ladder that decides
 * whether a name means a saved place, a fact, or a Google lookup lives in `places.ts`.
 *
 * Split that way because this half has no network, no config and no failure modes, so it stays
 * trivially testable and `places.ts` keeps one job: turning what the owner said into somewhere real.
 */

export type SavedPlace = typeof savedPlaces.$inferSelect

/**
 * Aliases Otto reads by name from `facts` instead, and therefore must never store here.
 *
 * Two rows that can disagree about where the owner lives is worse than one lookup that checks two
 * places: `resolveOrigin` (services/leaveBy.ts) reads `home.address`/`work.address` directly and
 * would keep using the fact while `manage_places` quietly edited a shadow copy nobody read.
 */
export const RESERVED_ALIASES: readonly string[] = ['home', 'work', 'the office', 'office']

/** Enough for a lifetime of named places; a runaway loop writing them is what this actually bounds. */
export const SAVED_PLACE_CAP = 200

/**
 * The lookup key for a name the owner spoke.
 *
 * Lowercased, punctuation-trimmed, and a leading article stripped, so "The Gym", "the gym" and
 * "gym" are one row rather than three. Deliberately nothing cleverer — no stemming, no fuzzy match:
 * this key decides whether Otto uses a remembered address without asking, and a near-match that
 * silently resolved "the dentist" to "the dentist's car park" would be worse than a miss, which
 * merely costs a Places lookup.
 */
export function normaliseAlias(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(?:the|my)\s+/, '')
    .replace(/['’]s\b/g, 's')
    .replace(/[.,!?]+$/, '')
    .replace(/\s+/g, ' ')
}

/** Coordinates are stored as integer micro-degrees; SQLite reals compare badly across platforms. */
const toMicro = (v: number): number => Math.round(v * 1e6)
const fromMicro = (v: number): number => v / 1e6

export function latLngOf(row: SavedPlace): LatLng | null {
  if (row.lat === null || row.lng === null) return null
  const candidate = { lat: fromMicro(row.lat), lng: fromMicro(row.lng) }
  return isLatLng(candidate) ? candidate : null
}

export function findSavedPlace(deviceId: string, alias: string): SavedPlace | undefined {
  return db
    .select()
    .from(savedPlaces)
    .where(and(eq(savedPlaces.deviceId, deviceId), eq(savedPlaces.alias, normaliseAlias(alias))))
    .get()
}

export function listSavedPlaces(deviceId: string): SavedPlace[] {
  return db
    .select()
    .from(savedPlaces)
    .where(eq(savedPlaces.deviceId, deviceId))
    .orderBy(desc(savedPlaces.useCount), desc(savedPlaces.lastUsedAtMillis))
    .all()
}

/**
 * Upsert by (deviceId, alias). Writing an existing alias REPLACES it — they changed gym.
 *
 * Returns null for a reserved alias rather than throwing, so the caller can say why in words.
 */
export function rememberPlace(params: {
  deviceId: string
  alias: string
  label?: string
  address: string
  googlePlaceId?: string | null
  latLng?: LatLng | null
  nowMillis?: number
}): SavedPlace | null {
  const alias = normaliseAlias(params.alias)
  if (alias.length === 0 || RESERVED_ALIASES.includes(alias)) return null

  const now = params.nowMillis ?? Date.now()
  const latLng = params.latLng ?? null
  const patch = {
    label: params.label?.trim() || params.alias.trim(),
    address: params.address.trim(),
    googlePlaceId: params.googlePlaceId ?? null,
    lat: latLng === null ? null : toMicro(latLng.lat),
    lng: latLng === null ? null : toMicro(latLng.lng),
    updatedAt: now,
  }

  const existing = findSavedPlace(params.deviceId, alias)
  if (existing) {
    db.update(savedPlaces).set(patch).where(eq(savedPlaces.placeRowId, existing.placeRowId)).run()
    return { ...existing, ...patch }
  }

  const row: SavedPlace = {
    placeRowId: newSavedPlaceId(),
    deviceId: params.deviceId,
    alias,
    useCount: 0,
    lastUsedAtMillis: null,
    createdAt: now,
    ...patch,
  }
  db.insert(savedPlaces).values(row).run()
  return row
}

export function forgetPlace(deviceId: string, alias: string): boolean {
  const res = db
    .delete(savedPlaces)
    .where(and(eq(savedPlaces.deviceId, deviceId), eq(savedPlaces.alias, normaliseAlias(alias))))
    .run()
  return res.changes > 0
}

/**
 * Record that a saved place was actually used to plan something.
 *
 * `useCount` is what makes a saved place beat a Places candidate in an ambiguity — "their dentist"
 * rather than "the nearest dentist" — so it has to be written on use, not on save.
 */
export function markPlaceUsed(placeRowId: string, nowMillis = Date.now()): void {
  db.update(savedPlaces)
    // Incremented in SQL rather than read-modify-written, the same way `nagCount` is in
    // services/nagging.ts: the conversational path and a scheduler recheck can plan the same
    // journey at once, and a lost update here would quietly demote a place in future ambiguities.
    .set({ useCount: sql`${savedPlaces.useCount} + 1`, lastUsedAtMillis: nowMillis })
    .where(eq(savedPlaces.placeRowId, placeRowId))
    .run()
}
