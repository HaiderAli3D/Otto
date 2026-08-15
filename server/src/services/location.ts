import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { deviceLocations } from '../db/schema.js'
import { requestLocationData } from '../fcm/commands.js'
import { sendData } from '../fcm/sender.js'
import { isLatLng, type LatLng } from '../lib/geo.js'
import { log } from '../lib/log.js'
import { newRequestId } from '../lib/ids.js'
import type { Device } from './devices.js'
import { locationCapable } from './push.js'

/**
 * Asking the phone where the owner is.
 *
 * The whole feature rests on one judgement, and it is not a technical one: a fix is only worth
 * having when it PREDICTS something. At 09:00, where they are says nothing about where they will be
 * at 14:20 — so the pull belongs at the recheck, forty-five minutes before departure, not in the
 * conversational turn where it was first tempting to put it. See `shouldPull` below.
 */

/**
 * Beyond this a fix cannot tell which side of a river — or which tube station — they are on, and a
 * departure priced from the wrong side of either is worse than one priced from home, because it
 * LOOKS like an observation.
 */
export const MAX_FIX_ACCURACY_M = 250

/**
 * A fix this old is where they WERE. The Tube is the case that proves it: twenty minutes
 * underground and the phone's last known position is the station they got on at.
 */
export const MAX_FIX_AGE_MS = 5 * 60_000

/** How long a plan waits for an answer before carrying on without one. */
export const LOCATION_WAIT_MS = 45_000

/** How often the wait loop looks for an answer. Cheap: it is one indexed read of one row. */
const POLL_INTERVAL_MS = 1_500

/**
 * How close to departure "where are you now" starts being predictive.
 *
 * Ninety minutes is the honest edge of it. Inside that window the owner is plausibly already where
 * they will set off from; outside it, a fix is a fact about the past dressed as a fact about the
 * journey.
 */
export const GPS_USEFUL_WINDOW_MS = 90 * 60_000

export type DeviceLocation = typeof deviceLocations.$inferSelect

const toMicro = (v: number): number => Math.round(v * 1e6)
const fromMicro = (v: number): number => v / 1e6

/** Record whatever the phone said — a fix, or the reason there is not one. Upsert, never append. */
export function recordDeviceLocation(params: {
  deviceId: string
  requestId: string | null
  status: string
  latLng?: LatLng | null
  accuracyMeters?: number | null
  isMock?: boolean
  fixAtMillis?: number | null
  reason?: string | null
  nowMillis?: number
}): void {
  const now = params.nowMillis ?? Date.now()
  const latLng = params.latLng ?? null
  const row = {
    deviceId: params.deviceId,
    requestId: params.requestId,
    status: params.status,
    lat: latLng === null ? null : toMicro(latLng.lat),
    lng: latLng === null ? null : toMicro(latLng.lng),
    accuracyMeters: params.accuracyMeters ?? null,
    isMock: params.isMock ?? false,
    fixAtMillis: params.fixAtMillis ?? null,
    receivedAtMillis: now,
    reason: params.reason ?? null,
  }
  db.insert(deviceLocations)
    .values(row)
    .onConflictDoUpdate({ target: deviceLocations.deviceId, set: row })
    .run()
}

export function getDeviceLocation(deviceId: string): DeviceLocation | undefined {
  return db.select().from(deviceLocations).where(eq(deviceLocations.deviceId, deviceId)).get()
}

export type UsableFix = { latLng: LatLng; accuracyMeters: number | null; fixAtMillis: number }

/**
 * The stored fix, if it is good enough to plan a journey from. Null otherwise.
 *
 * A fix that fails either threshold is DISCARDED, not downgraded to a lesser confidence and quietly
 * used. That is the load-bearing decision here: the origin ladder already degrades honestly to
 * home/work, and a vague or stale fix is worse than no fix precisely because it looks like an
 * observation rather than an assumption. A mock fix is refused outright — planning a real journey
 * from a spoofed origin is not a thing to be tolerant about.
 */
export function usableFix(deviceId: string, nowMillis: number = Date.now()): UsableFix | null {
  const row = getDeviceLocation(deviceId)
  if (!row || row.status !== 'OK' || row.isMock) return null
  if (row.lat === null || row.lng === null || row.fixAtMillis === null) return null
  const latLng = { lat: fromMicro(row.lat), lng: fromMicro(row.lng) }
  if (!isLatLng(latLng)) return null
  if (nowMillis - row.fixAtMillis > MAX_FIX_AGE_MS) return null
  if (row.accuracyMeters !== null && row.accuracyMeters > MAX_FIX_ACCURACY_M) return null
  return { latLng, accuracyMeters: row.accuracyMeters, fixAtMillis: row.fixAtMillis }
}

/**
 * Why a plan did NOT use a fix, in the terms Otto explains it to the owner.
 *
 * Carried rather than logged because "I don't know where you are" is a sentence the owner should
 * hear, and a different one depending on which of these it was.
 */
export type LocationMiss = 'not-capable' | 'denied' | 'stale' | 'vague' | 'no-answer' | 'not-asked'

export type LocationOutcome = { fix: UsableFix } | { miss: LocationMiss }

/**
 * Is a fix worth asking for at all?
 *
 * Four conditions, and the second is the one that is easy to get backwards. A `high`-confidence
 * origin comes from the calendar event immediately before this one, which is where the owner WILL
 * be — better information than where they are standing now, not worse. `leaveBy.ts` already makes
 * exactly that argument about its own ladder; this respects it rather than overriding it.
 */
export function shouldPull(params: {
  device: Device
  leaveAtMillis: number
  originConfidence: 'high' | 'medium' | null
  explicitOrigin: boolean
  nowMillis?: number
}): boolean {
  const now = params.nowMillis ?? Date.now()
  if (params.explicitOrigin) return false
  if (params.originConfidence === 'high') return false
  if (params.leaveAtMillis - now > GPS_USEFUL_WINDOW_MS) return false
  return locationCapable(params.device, now)
}

/**
 * Ask, and wait a bounded time for the answer.
 *
 * Returns a fresh stored fix without asking when one is already good enough — the phone should not
 * be woken to re-answer a question it answered ninety seconds ago.
 *
 * NEVER throws and never blocks longer than [LOCATION_WAIT_MS]. A caller that could hang here would
 * hang a scheduler tick, and the scheduler will not start the next one until this returns.
 */
export async function requestLocation(
  device: Device,
  opts: { reason?: string | null; highAccuracy?: boolean; waitMs?: number; nowMillis?: number } = {},
): Promise<LocationOutcome> {
  const now = opts.nowMillis ?? Date.now()
  const existing = usableFix(device.deviceId, now)
  if (existing) return { fix: existing }

  if (!locationCapable(device, now)) return { miss: 'not-capable' }
  if (!device.fcmToken || !device.hmacSecret) return { miss: 'not-capable' }

  const requestId = newRequestId()
  const waitMs = opts.waitMs ?? LOCATION_WAIT_MS
  const data = requestLocationData({
    requestId,
    maxAgeSeconds: Math.floor(MAX_FIX_AGE_MS / 1000),
    expiresAtMillis: now + waitMs,
    highAccuracy: opts.highAccuracy ?? false,
    reason: opts.reason ?? null,
    secret: device.hmacSecret,
  })

  const sent = await sendData(device.fcmToken, data)
  if (!sent.ok) {
    log.warn({ deviceId: device.deviceId }, 'location: push failed')
    return { miss: 'no-answer' }
  }

  // Polling one indexed row rather than holding a promise the FCM path would have to resolve: the
  // answer arrives on a completely separate HTTP request, possibly in another process after a
  // restart, so there is nothing in memory for it to resolve against.
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const row = getDeviceLocation(device.deviceId)
    if (!row || row.requestId !== requestId) continue
    if (row.status !== 'OK') {
      return { miss: row.status === 'TIMEOUT' || row.status === 'UNAVAILABLE' ? 'no-answer' : 'denied' }
    }
    const fix = usableFix(device.deviceId, Date.now())
    if (fix) return { fix }
    // It answered, and the answer is not good enough to plan from. Which failure it was decides
    // what Otto says, so the two are distinguished rather than collapsed into "no fix".
    const stale = row.fixAtMillis !== null && Date.now() - row.fixAtMillis > MAX_FIX_AGE_MS
    return { miss: stale ? 'stale' : 'vague' }
  }
  return { miss: 'no-answer' }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One plain sentence naming the gap AND the substitute.
 *
 * Never just "I couldn't get your location": the owner needs to know what Otto used instead, or the
 * plan reads as authoritative when it was a fallback.
 */
export function describeMiss(miss: LocationMiss, substitute: string): string | null {
  switch (miss) {
    case 'denied':
      return `I don't have location permission on your phone, so I've worked it out from ${substitute}.`
    case 'stale':
      return `Your phone's last fix is too old to trust — looks like you were underground — so I've priced it from ${substitute}.`
    case 'vague':
      return `Your phone's location was too vague to price from, so I've used ${substitute}.`
    case 'no-answer':
      return `Your phone couldn't get a fix just now, so I've priced it from ${substitute}.`
    // Nothing was asked and nothing is owed: either it is too far out for a fix to mean anything, or
    // a better origin was already known. Saying something here would be noise about a non-event.
    case 'not-asked':
    case 'not-capable':
      return null
  }
}
