import { config } from '../config.js'
import { isLatLng, type LatLng } from '../lib/geo.js'
import { log } from '../lib/log.js'
import type { Device } from './devices.js'
import { factValue } from './facts.js'
import { findSavedPlace, latLngOf, markPlaceUsed, normaliseAlias } from './savedPlaces.js'

/**
 * Turning what the owner said into somewhere real, via the Google Places API (New) Text Search.
 *
 * The gap this fills: `services/travel.ts` hands a waypoint's free text to Routes, which geocodes it
 * itself. That works for "14 High Street, Wandsworth" and fails silently for "the gym" — Routes
 * returns no route, `computeDriveMinutes` returns null, and the estimate ladder produces a confident
 * flat 30 minutes for a journey nobody ever priced. Text Search is the difference between Otto
 * knowing where it is sending them and guessing.
 *
 * Same discipline as travel.ts throughout, and for the same reasons: never throws, every failure is
 * null, one abort signal, one narrow field mask, and a per-device daily ceiling because this is a
 * personal server with the owner's card attached.
 */

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText'

/** Same as the Routes timeout: this also sits inside an agent turn the owner is waiting on. */
const TIMEOUT_MS = 8_000

/**
 * The four fields, and nothing else.
 *
 * `X-Goog-FieldMask` is mandatory on this method and the mask decides the SKU, exactly as it does
 * for Routes. Asking for reviews, opening hours or photos would move every lookup into a dearer tier
 * to render text nobody reads — the model gets a name and an address and that is the whole job.
 */
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location'

/** More than this is not a shortlist a human can answer, it is a list they give up on. */
const MAX_CANDIDATES = 5

/**
 * How far around the bias point Text Search prefers results.
 *
 * A BIAS, not a restriction: "Wembley Stadium" asked from Wandsworth must still resolve. Wide
 * enough to cover a city so a local search behaves locally, and results outside it are ranked lower
 * rather than dropped.
 */
const BIAS_RADIUS_M = 30_000

/**
 * Per-device ceiling on billed Places calls per day.
 *
 * Lower than the Routes ceiling deliberately. A journey needs at most one place lookup and often
 * none — a saved place or a full address never reaches the network — whereas a journey can need two
 * route calls and is rechecked. A device burning fifteen of these in a day is a loop, not a person.
 *
 * In memory, keyed on the UTC day, for the reason spelled out in travel.ts: it bounds THIS
 * process's spending, costs nothing to check, and a restart clearing it is correct because the
 * runaway it exists to stop does not survive the restart either. Unlike the travel budget, nothing
 * durable schedules a place lookup — every one of these is driven by a live conversation.
 */
export const MAX_PLACES_CALLS_PER_DAY = 15

const callsToday = new Map<string, { dayKey: string; count: number }>()

function claimPlacesCall(deviceId: string, nowMillis: number): boolean {
  const dayKey = new Date(nowMillis).toISOString().slice(0, 10)
  const entry = callsToday.get(deviceId)
  if (!entry || entry.dayKey !== dayKey) {
    callsToday.set(deviceId, { dayKey, count: 1 })
    return true
  }
  if (entry.count >= MAX_PLACES_CALLS_PER_DAY) return false
  entry.count += 1
  return true
}

/** Reset the in-memory budget. Exported for tests, which must not inherit each other's counts. */
export function resetPlacesBudget(): void {
  callsToday.clear()
}

/** One candidate answer to "where do they mean?". */
export type PlaceCandidate = {
  /** Google's stable id, or null for a place that never went through Places. */
  placeId: string | null
  /** What to call it: "Hartley & Co Dental". */
  label: string
  /** The formatted address. This is what goes on the calendar event and what a human reads. */
  address: string
  latLng: LatLng | null
}

/**
 * Where a resolved place came from, and it is load-bearing rather than diagnostic.
 *
 * `saved` and `fact` are the OWNER's own answer and carry full confidence. `places` is Google's best
 * guess at prose the owner typed once — good enough to plan from, not good enough to ring a phone
 * about unasked, which is why services/leaveBy.ts gets a `place-guessed` block for it. `literal` is
 * the pre-existing behaviour: text that already looks like an address, handed straight to Routes.
 */
export type PlaceSource = 'saved' | 'fact' | 'places' | 'literal'

export type ResolvedPlace = PlaceCandidate & {
  source: PlaceSource
  /**
   * The owner would recognise this as the place they meant.
   *
   * True for anything they authored or chose — a saved place, a home/work fact, an address they
   * typed, a candidate they picked out of an earlier ambiguity — and for a search result whose NAME
   * is exactly what they said ("Wembley Stadium"). False only for a single fuzzy hit: Google
   * returned one thing, it is probably right, and nobody has confirmed it.
   *
   * That last case is the one worth distinguishing. It is confident enough to plan from and to talk
   * about, and NOT confident enough to ring a phone about — see `place-guessed` in leaveBy.ts.
   */
  confirmed: boolean
}

export type PlaceResolution =
  | { kind: 'resolved'; place: ResolvedPlace }
  | { kind: 'ambiguous'; candidates: PlaceCandidate[] }
  | { kind: 'unknown'; note: string }

/**
 * Ask Google. Null means "could not find out", which is never the same as "there is no such place"
 * — the caller must not turn a network failure into a confident "I couldn't find it".
 *
 * The API key is a PARAMETER, not read from config, for the same reason as `computeDriveMinutes`:
 * config is parsed once at import and cannot be varied per test.
 */
export async function searchPlaces(p: {
  apiKey: string
  query: string
  bias: LatLng | null
  regionCode?: string
}): Promise<PlaceCandidate[] | null> {
  const body: Record<string, unknown> = { textQuery: p.query, pageSize: MAX_CANDIDATES }
  if (p.bias !== null) {
    body.locationBias = {
      circle: { center: { latitude: p.bias.lat, longitude: p.bias.lng }, radius: BIAS_RADIUS_M },
    }
  }
  if (p.regionCode) body.regionCode = p.regionCode

  try {
    const res = await fetch(PLACES_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': p.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      // Without a signal a black-holed socket hangs on undici's ~5 minute default, inside an agent
      // turn that will not answer the owner until this returns.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      log.warn({ status: res.status, body: text.slice(0, 300) }, 'places: searchText failed')
      return null
    }
    const json = (await res.json()) as {
      places?: Array<{
        id?: string
        displayName?: { text?: string }
        formattedAddress?: string
        location?: { latitude?: number; longitude?: number }
      }>
    }
    // An EMPTY array is a real answer ("no such place"), and must stay distinguishable from null.
    return (json.places ?? []).flatMap((raw) => {
      const address = raw.formattedAddress?.trim()
      if (!address) return []
      const coords = { lat: raw.location?.latitude ?? Number.NaN, lng: raw.location?.longitude ?? Number.NaN }
      return [
        {
          placeId: raw.id ?? null,
          label: raw.displayName?.text?.trim() || address,
          address,
          latLng: isLatLng(coords) ? coords : null,
        },
      ]
    })
  } catch (err) {
    // Includes the AbortError from the timeout. Every failure is the same failure to the caller.
    log.warn({ err }, 'places: searchText threw')
    return null
  }
}

/**
 * Text that is already an address, so handing it to Routes verbatim is correct and free.
 *
 * This is the pre-existing behaviour and the reason the whole feature is backwards compatible: a
 * calendar event whose location is "The Ship, Jews Row, London SW18 1TB" resolved fine before Places
 * existed and must not start costing a lookup, or asking a question, now.
 *
 * Deliberately conservative — a house number, or a UK postcode. A false negative costs one billed
 * lookup that returns the same address; a false positive sends unroutable prose to Routes and
 * revives exactly the silent failure this module was written to remove.
 */
export function looksLikeAddress(text: string): boolean {
  const t = text.trim()
  if (t.length < 6) return false
  if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(t)) return true // UK postcode
  return /^\d+[a-z]?[\s,]/i.test(t) || /,\s*\d+/.test(t)
}

/** A name that means the same place however they said it: "Wembley Stadium" vs "wembley stadium". */
const sameName = (a: string, b: string): boolean => normaliseAlias(a) === normaliseAlias(b)

/**
 * Which candidate, if any, we are entitled to pick without asking.
 *
 * One candidate is not a choice. Beyond that, the ONLY automatic winner is an exact name match that
 * nothing else ties with — "Wembley Stadium" should not become a question just because Google also
 * returned four shops on Wembley High Road. Anything genuinely plural ("the dentist") comes back
 * ambiguous, and the model asks.
 *
 * Relevance rank is deliberately NOT a tiebreak, and neither is distance: "the nearest dentist" is
 * not "their dentist", and a confidently wrong destination is the failure this whole module exists
 * to prevent.
 */
function unambiguousPick(
  candidates: PlaceCandidate[],
  query: string,
): { place: PlaceCandidate; confirmed: boolean } | null {
  const exact = candidates.filter((c) => sameName(c.label, query))
  // An exact name match is the owner's own words coming back — confirmed. A sole fuzzy hit is
  // Google's best guess at what they meant, which is worth planning from and not worth ringing on.
  if (exact.length === 1) return { place: exact[0]!, confirmed: true }
  if (candidates.length === 1) return { place: candidates[0]!, confirmed: false }
  return null
}

/**
 * What the owner said → somewhere real. NEVER guesses, and never throws.
 *
 * The ladder, cheapest and most trustworthy first:
 *  1. A place id they already chose from an earlier ambiguity — costs nothing, and skipping the
 *     search is also what stops "which dentist?" being asked twice in one conversation.
 *  2. A saved place. Their own answer, and free.
 *  3. `home`/`work`, which live in `facts` and are read by name by services/leaveBy.ts.
 *  4. Text that is already an address — the pre-Places behaviour, still free.
 *  5. Google.
 *
 * Steps 4 and 5 are in that order on purpose: an address needs no lookup, and reordering them would
 * spend a billed call to be told what the string already said.
 */
export async function resolvePlace(
  device: Device,
  query: string,
  opts: {
    /** From an earlier `ambiguous` answer the owner has now chosen between. */
    placeId?: string | null
    address?: string | null
    /** Bias for the text search — the owner's rough whereabouts, when something already knows it. */
    bias?: LatLng | null
    nowMillis?: number
  } = {},
): Promise<PlaceResolution> {
  const text = query.trim()
  if (text.length === 0) return { kind: 'unknown', note: 'no place was named' }

  // 1. Already chosen. `address` alone is enough — Routes can take either, and requiring both would
  //    make the model's follow-up call fail for want of a field it was never shown.
  const chosenAddress = opts.address?.trim()
  if (opts.placeId || chosenAddress) {
    return {
      kind: 'resolved',
      place: {
        placeId: opts.placeId ?? null,
        label: text,
        address: chosenAddress ?? text,
        latLng: null,
        source: 'places',
        // They picked it, or they typed it. Either way it is not our guess.
        confirmed: true,
      },
    }
  }

  // 2. Theirs.
  const saved = findSavedPlace(device.deviceId, text)
  if (saved) {
    markPlaceUsed(saved.placeRowId, opts.nowMillis)
    return {
      kind: 'resolved',
      place: {
        placeId: saved.googlePlaceId,
        label: saved.label,
        address: saved.address,
        latLng: latLngOf(saved),
        source: 'saved',
        confirmed: true,
      },
    }
  }

  // 3. home / work, which are facts and stay facts.
  const alias = normaliseAlias(text)
  const factKey = alias === 'home' ? 'home.address' : alias === 'work' || alias === 'office' ? 'work.address' : null
  if (factKey !== null) {
    const address = factValue(device.deviceId, factKey)?.trim()
    if (address) {
      return {
        kind: 'resolved',
        place: { placeId: null, label: alias, address, latLng: null, source: 'fact', confirmed: true },
      }
    }
    return {
      kind: 'unknown',
      note: `they have not told you their ${alias} address — ask for it and save it with remember_fact under "${factKey}"`,
    }
  }

  // 4. Already an address.
  if (looksLikeAddress(text)) {
    return {
      kind: 'resolved',
      place: { placeId: null, label: text, address: text, latLng: null, source: 'literal', confirmed: true },
    }
  }

  // 5. Google.
  if (config.maps === null) {
    return { kind: 'unknown', note: 'place lookup is not configured, so ask them for the address' }
  }
  const now = opts.nowMillis ?? Date.now()
  if (!claimPlacesCall(device.deviceId, now)) {
    log.warn({ deviceId: device.deviceId, cap: MAX_PLACES_CALLS_PER_DAY }, 'places: daily call budget spent')
    return { kind: 'unknown', note: "you have looked up a lot of places today — ask them for the address rather than searching again" }
  }

  const found = await searchPlaces({ apiKey: config.maps.apiKey, query: text, bias: opts.bias ?? null })
  if (found === null) {
    return { kind: 'unknown', note: 'the place lookup is unreachable right now — say so and ask for the address' }
  }
  if (found.length === 0) {
    return { kind: 'unknown', note: `nothing matching "${text}" was found` }
  }

  const pick = unambiguousPick(found, text)
  if (pick !== null) {
    return { kind: 'resolved', place: { ...pick.place, source: 'places', confirmed: pick.confirmed } }
  }
  return { kind: 'ambiguous', candidates: found }
}
