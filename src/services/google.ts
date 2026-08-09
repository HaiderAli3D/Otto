import { eq } from 'drizzle-orm'
import { google } from 'googleapis'
import { DateTime } from 'luxon'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { googleAccounts } from '../db/schema.js'
import { log } from '../lib/log.js'
import { getDevice } from './devices.js'
import { issueOAuthState } from './oauthState.js'
import { enqueueOutbound } from './outbox.js'
import { localDateKey } from './time.js'

/** Parse a required local wall-clock ISO in the device zone, or throw so the tool surfaces it. */
function requireLocalIso(iso: string, zone: string, field: string): string {
  const dt = DateTime.fromISO(iso, { zone })
  if (!dt.isValid) throw new Error(`Invalid ${field} "${iso}": ${dt.invalidReason ?? 'unparseable'}`)
  return dt.toISO()!
}

/**
 * Google Calendar/Tasks integration. Each device links its own Google account via OAuth
 * (see `routes/oauth.ts`); we persist only the long-lived refresh token and mint short-lived
 * access tokens on demand. All wall-clock ISO strings coming in are LOCAL (no offset) and are
 * interpreted in the device's IANA timezone.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
]

/** A fresh OAuth2 client built from configured credentials. Throws if Google isn't configured. */
function oauthClient() {
  if (config.google === null) {
    throw new Error('Google OAuth is not configured (set GOOGLE_OAUTH_CLIENT_ID/SECRET).')
  }
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  )
}

/** Timezone for the device, defaulting to UTC when the device is unknown. */
function zoneFor(deviceId: string): string {
  return getDevice(deviceId)?.timezone ?? 'UTC'
}

/**
 * An OAuth2 client primed with the device's stored refresh token, ready to mint access tokens.
 * Throws if the device has never linked a Google account.
 */
function authedClientFor(deviceId: string) {
  const row = db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.deviceId, deviceId))
    .get()
  if (!row) {
    throw new Error(`No Google account linked for device ${deviceId}.`)
  }
  const client = oauthClient()
  client.setCredentials({ refresh_token: row.refreshToken })
  return client
}

/** True iff the device has a stored Google refresh token. */
export function hasGoogle(deviceId: string): boolean {
  if (config.google === null) return false
  const row = db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.deviceId, deviceId))
    .get()
  return row !== undefined && row.refreshToken.length > 0
}

/** The consent URL to redirect the owner to; `state` is an unguessable single-use CSRF nonce. */
export function googleAuthUrl(deviceId: string): string {
  const state = issueOAuthState(deviceId, Date.now())
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  })
}

/** Exchange an OAuth authorization code for a refresh token and persist it for the device. */
export async function exchangeCode(deviceId: string, code: string): Promise<void> {
  const client = oauthClient()
  const { tokens } = await client.getToken(code)
  const refreshToken = tokens.refresh_token
  if (!refreshToken) {
    log.warn({ deviceId }, 'google: getToken returned no refresh_token')
    throw new Error('Google did not return a refresh token (re-consent with prompt=consent).')
  }
  const now = Date.now()
  db.insert(googleAccounts)
    .values({ deviceId, refreshToken, updatedAt: now })
    .onConflictDoUpdate({
      target: googleAccounts.deviceId,
      set: { refreshToken, updatedAt: now },
    })
    .run()
}

/**
 * One primary-calendar event, with every field the leave-by planner needs.
 *
 * `id`, `location` and `status` were previously read off the API response and thrown away. All
 * three already come back under the `calendar.events` scope this app has held since day one, so
 * surfacing them is NOT a scope change and does NOT drag the owner back through the OAuth consent
 * flow — which it would have, had this needed `calendar.readonly` or anything wider.
 */
export type CalendarEvent = {
  id: string
  summary: string
  startIso: string
  endIso: string
  isAllDay: boolean
  location: string | null
  status: string | null
}

/** List the device's primary-calendar events in the given local time window. */
export async function listCalendarEvents(
  deviceId: string,
  timeMinLocalISO: string,
  timeMaxLocalISO: string,
): Promise<CalendarEvent[]> {
  const auth = authedClientFor(deviceId)
  const zone = zoneFor(deviceId)
  // Surface bad bounds as an error instead of silently sending an unbounded events.list (which
  // would return years of history the agent then reports as "today").
  const timeMin = requireLocalIso(timeMinLocalISO, zone, 'timeMinLocalISO')
  const timeMax = requireLocalIso(timeMaxLocalISO, zone, 'timeMaxLocalISO')
  const calendar = google.calendar({ version: 'v3', auth })
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    // An explicit page size, and deliberately NO pageToken loop. Every caller asks about a one- or
    // two-day window, which never holds 50 events; a pagination loop would add a second failure
    // mode and a latency tail to a scheduler job in exchange for nothing. If a window ever does
    // overflow, it truncates in start-time order — the near events, the ones a leave-by alarm could
    // still be armed for, are the ones kept.
    maxResults: 50,
  })
  const items = res.data.items ?? []
  return items.map((e) => ({
    id: e.id ?? '',
    summary: e.summary ?? '(no title)',
    startIso: e.start?.dateTime ?? e.start?.date ?? '',
    endIso: e.end?.dateTime ?? e.end?.date ?? '',
    // THE authoritative all-day test: Google populates `date` for all-day events and `dateTime` for
    // timed ones, and never both. Never infer this from the shape of `startIso` — a bare date is
    // what an all-day event happens to produce, not the definition, and getting it wrong either
    // arms a 07:00 alarm for someone's birthday or silently suppresses a real one.
    isAllDay: e.start?.dateTime == null && e.start?.date != null,
    location: e.location ?? null,
    status: e.status ?? null,
  }))
}

/** An OAuth refresh token that Google has revoked or that has expired past recovery. */
function isInvalidGrant(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}` : String(err)
  return /invalid_grant/i.test(text)
}

/**
 * `listCalendarEvents` that returns null instead of throwing.
 *
 * Every non-interactive caller uses this one. A revoked grant, an expired token or a Google outage
 * must not take down a scheduler job that also has an alarm to settle — and "the calendar is
 * unreachable" is a decision the caller has to make deliberately (leave the alarm alone) rather
 * than an exception thrown past it.
 *
 * A revoked grant is different from an outage: it never heals on its own, and a silently dead
 * calendar makes this whole feature silently useless. That one case earns exactly one queued
 * warning, deduped per device per local day — the outbox's unique index only covers PENDING rows,
 * so without the day key a scheduler hitting this every hour would queue a fresh nag each time the
 * last one had already been sent.
 */
export async function tryListCalendarEvents(
  deviceId: string,
  timeMinLocalISO: string,
  timeMaxLocalISO: string,
): Promise<CalendarEvent[] | null> {
  try {
    return await listCalendarEvents(deviceId, timeMinLocalISO, timeMaxLocalISO)
  } catch (err) {
    log.warn({ err, deviceId }, 'calendar: events.list failed; treating the calendar as unreachable')
    if (isInvalidGrant(err)) {
      const device = getDevice(deviceId)
      if (device?.whatsappNumber) {
        enqueueOutbound({
          waUserId: device.whatsappNumber,
          deviceId,
          kind: 'system_warning',
          body: "⚠️ My access to your Google Calendar has been revoked, so I can't see what's on or work out when you need to leave. Send me \"link google\" to reconnect it.",
          dedupeKey: `google-relink:${deviceId}:${localDateKey(Date.now(), device.timezone)}`,
        })
      }
    }
    return null
  }
}

/**
 * Create a timed event on the device's primary calendar from local wall-clock ISO strings.
 *
 * `location` is not cosmetic and omitting it used to break the leave-by feature outright. Every
 * planner reads the event back from Google and prices the journey from `event.location`
 * (services/leaveBy.ts `computeLeaveByPlan`); an event written without one comes back
 * `blocked: 'no-location'`, which `services/handlers/leaveBy.ts` reads as "this stopped being a
 * journey" and answers by CANCELLING both alarms — silently, 45 minutes before departure. So an
 * event Otto creates for somewhere it is also planning a journey to must carry the address.
 */
export async function createCalendarEvent(
  deviceId: string,
  params: {
    title: string
    startIso: string
    endIso: string
    location?: string | null
    /**
     * Drop Google Calendar's own default reminders for this event.
     *
     * Only the journey planner sets this. When Otto has already arranged a get-ready nudge, a
     * "leaving soon" nudge and a leave-now alarm, Calendar's default popup is a fourth notification
     * from a producer the server cannot see or coordinate with. Left alone for the ordinary
     * `create_calendar_event` tool, where the owner may well be relying on it.
     */
    suppressDefaultReminders?: boolean
  },
): Promise<{ id: string; htmlLink?: string }> {
  const auth = authedClientFor(deviceId)
  const timeZone = zoneFor(deviceId)
  const calendar = google.calendar({ version: 'v3', auth })
  const location = params.location?.trim()
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: params.title,
      start: { dateTime: params.startIso, timeZone },
      end: { dateTime: params.endIso, timeZone },
      ...(location ? { location } : {}),
      ...(params.suppressDefaultReminders ? { reminders: { useDefault: false, overrides: [] } } : {}),
    },
  })
  return { id: res.data.id!, htmlLink: res.data.htmlLink ?? undefined }
}

/**
 * One event by id, or null.
 *
 * Exists so a planner can create an event and then plan from GOOGLE's copy rather than from the
 * object it just built. That is not fastidiousness: `eventKeyOf` falls back to the summary when an
 * event has no id, and the leave-by recheck later looks the event up in Google's list by that key —
 * where it has a real id, matches nothing, and concludes the event was deleted. Which, again, it
 * answers by cancelling the alarms.
 */
export async function getCalendarEvent(deviceId: string, eventId: string): Promise<CalendarEvent | null> {
  try {
    const auth = authedClientFor(deviceId)
    const calendar = google.calendar({ version: 'v3', auth })
    const res = await calendar.events.get({ calendarId: 'primary', eventId })
    const e = res.data
    return {
      id: e.id ?? '',
      summary: e.summary ?? '(no title)',
      startIso: e.start?.dateTime ?? e.start?.date ?? '',
      endIso: e.end?.dateTime ?? e.end?.date ?? '',
      isAllDay: e.start?.dateTime == null && e.start?.date != null,
      location: e.location ?? null,
      status: e.status ?? null,
    }
  } catch (err) {
    log.warn({ err, deviceId, eventId }, 'calendar: events.get failed')
    return null
  }
}

/** Create a Google Task on the default list, optionally due at a local wall-clock ISO time. */
export async function createTask(
  deviceId: string,
  params: { title: string; dueIso?: string },
): Promise<{ id: string }> {
  const auth = authedClientFor(deviceId)
  const zone = zoneFor(deviceId)
  const tasksApi = google.tasks({ version: 'v1', auth })
  const due = params.dueIso ? requireLocalIso(params.dueIso, zone, 'dueLocalISO') : undefined
  const res = await tasksApi.tasks.insert({
    tasklist: '@default',
    requestBody: { title: params.title, due },
  })
  return { id: res.data.id! }
}
