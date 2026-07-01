import { eq } from 'drizzle-orm'
import { google } from 'googleapis'
import { DateTime } from 'luxon'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { googleAccounts } from '../db/schema.js'
import { log } from '../lib/log.js'
import { getDevice } from './devices.js'

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

/** The consent URL to redirect the owner to; `state` carries the deviceId back to the callback. */
export function googleAuthUrl(deviceId: string): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: deviceId,
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

/** List the device's primary-calendar events in the given local time window. */
export async function listCalendarEvents(
  deviceId: string,
  timeMinLocalISO: string,
  timeMaxLocalISO: string,
): Promise<Array<{ summary: string; startIso: string; endIso: string }>> {
  const auth = authedClientFor(deviceId)
  const zone = zoneFor(deviceId)
  const timeMin = DateTime.fromISO(timeMinLocalISO, { zone }).toISO()
  const timeMax = DateTime.fromISO(timeMaxLocalISO, { zone }).toISO()
  const calendar = google.calendar({ version: 'v3', auth })
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: timeMin ?? undefined,
    timeMax: timeMax ?? undefined,
    singleEvents: true,
    orderBy: 'startTime',
  })
  const items = res.data.items ?? []
  return items.map((e) => ({
    summary: e.summary ?? '(no title)',
    startIso: e.start?.dateTime ?? e.start?.date ?? '',
    endIso: e.end?.dateTime ?? e.end?.date ?? '',
  }))
}

/** Create a timed event on the device's primary calendar from local wall-clock ISO strings. */
export async function createCalendarEvent(
  deviceId: string,
  params: { title: string; startIso: string; endIso: string },
): Promise<{ id: string; htmlLink?: string }> {
  const auth = authedClientFor(deviceId)
  const timeZone = zoneFor(deviceId)
  const calendar = google.calendar({ version: 'v3', auth })
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: params.title,
      start: { dateTime: params.startIso, timeZone },
      end: { dateTime: params.endIso, timeZone },
    },
  })
  return { id: res.data.id!, htmlLink: res.data.htmlLink ?? undefined }
}

/** Create a Google Task on the default list, optionally due at a local wall-clock ISO time. */
export async function createTask(
  deviceId: string,
  params: { title: string; dueIso?: string },
): Promise<{ id: string }> {
  const auth = authedClientFor(deviceId)
  const zone = zoneFor(deviceId)
  const tasksApi = google.tasks({ version: 'v1', auth })
  const due = params.dueIso
    ? DateTime.fromISO(params.dueIso, { zone }).toISO() ?? undefined
    : undefined
  const res = await tasksApi.tasks.insert({
    tasklist: '@default',
    requestBody: { title: params.title, due },
  })
  return { id: res.data.id! }
}
