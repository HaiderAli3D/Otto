import { eq } from 'drizzle-orm'
import { google, type calendar_v3 } from 'googleapis'
import { DateTime } from 'luxon'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { googleAccounts } from '../db/schema.js'
import { log } from '../lib/log.js'
import { getDevice } from './devices.js'
import { issueOAuthState } from './oauthState.js'
import { enqueueOutbound } from './outbox.js'
import { localDateKey, localIsoToEpochMillis } from './time.js'

/** Parse a required local wall-clock ISO in the device zone, or throw so the tool surfaces it. */
function requireLocalIso(iso: string, zone: string, field: string): string {
  const dt = DateTime.fromISO(iso, { zone })
  if (!dt.isValid) throw new Error(`Invalid ${field} "${iso}": ${dt.invalidReason ?? 'unparseable'}`)
  return dt.toISO()!
}

/**
 * Validate a bare local wall-clock ISO destined for an event BODY, and hand it back unchanged.
 *
 * Deliberately not `requireLocalIso`, which returns an absolute offset-bearing ISO. That is right
 * for the `timeMin`/`timeMax` query params, where an instant is what is being asked for, and wrong
 * here: an event body carries `{ dateTime, timeZone }`, and the whole point of that pair is that the
 * wall-clock time is interpreted in the named zone. Bake an offset into `dateTime` and Google
 * honours the offset and ignores the zone - identical most of the year, an hour out around a DST
 * change, and silent either way.
 *
 * `localIsoToEpochMillis` is borrowed purely as the validator, because it already rejects an
 * offset-bearing string with the message the model needs to correct itself.
 */
function requireBodyLocalIso(iso: string, zone: string, field: string): string {
  try {
    localIsoToEpochMillis(iso, zone)
  } catch (err) {
    throw new Error(`${field}: ${err instanceof Error ? err.message : 'unparseable'}`)
  }
  return iso
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

/**
 * The link to SEND the owner when they need to connect or reconnect Google.
 *
 * Deliberately points at this server's own `/oauth/google/start` rather than at `googleAuthUrl`'s
 * Google URL. That one embeds a single-use state nonce with a short life, so a message sitting
 * unread in WhatsApp — which is exactly what the revoked-grant warning is — would carry a dead
 * link by the time it was tapped. `/start` mints a fresh nonce on every visit, so this URL keeps
 * working however long the owner takes.
 */
export function googleLinkUrl(deviceId: string): string {
  return `${config.publicOrigin}/oauth/google/start?deviceId=${encodeURIComponent(deviceId)}`
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
  /**
   * The series this is one occurrence OF, or null for a one-off.
   *
   * `listCalendarEvents` sets `singleEvents`, so a repeating meeting arrives as instances whose own
   * ids look like `{base}_20260804T110000Z`. Deleting that id cancels that day; deleting this one
   * cancels the series. Reading them apart is the difference between "cancel today's standup" and
   * cancelling every standup there will ever be.
   */
  recurringEventId: string | null
  /** True when the owner is the organiser — so cancelling it cancels it for everyone invited. */
  organizerSelf: boolean
  /** How many people are on it. 0 or 1 means nobody else's calendar is affected by a change. */
  attendeeCount: number
  /** 'default' for an ordinary entry; birthdays, out-of-office and focus time are not editable like one. */
  eventType: string | null
}

/**
 * Google's event resource, as every caller here reads it.
 *
 * ONE copy, deliberately. This mapping was written out twice (list and get) and a third caller was
 * about to make it three — and the all-day test below is the single most consequential line in this
 * file, so three chances to get it subtly different is three too many.
 */
function toCalendarEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  return {
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
    recurringEventId: e.recurringEventId ?? null,
    organizerSelf: e.organizer?.self === true,
    attendeeCount: (e.attendees ?? []).length,
    eventType: e.eventType ?? null,
  }
}

/**
 * The page size every listing uses, exported because a caller has to be able to recognise a FULL
 * one. There is deliberately no pagination (see `listCalendarEvents`), so a window holding exactly
 * this many events was probably truncated — and a search that reports "you have no dentist
 * appointment" off a truncated page is worse than one that admits it could not see the whole window.
 */
export const CALENDAR_PAGE_SIZE = 50

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
    maxResults: CALENDAR_PAGE_SIZE,
  })
  return (res.data.items ?? []).map(toCalendarEvent)
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
    if (isInvalidGrant(err)) noteRevokedGrant(deviceId)
    return null
  }
}

/**
 * Queue the one warning that a revoked grant earns, deduped per device per local day.
 *
 * Extracted from `tryListCalendarEvents` because reading the calendar was, until now, the ONLY
 * operation that could notice a revoked grant — so a delete or a move that failed for the same
 * reason failed silently and forever, with the owner told nothing and no way back offered. Every
 * write path calls this too.
 *
 * The outbox's unique index only covers PENDING rows, so without the day key a caller hitting this
 * repeatedly would queue a fresh nag each time the last one had already been sent.
 */
export function noteRevokedGrant(deviceId: string): void {
  const device = getDevice(deviceId)
  if (!device?.whatsappNumber) return
  enqueueOutbound({
    waUserId: device.whatsappNumber,
    deviceId,
    kind: 'system_warning',
    // The URL goes in the body, rather than an instruction to ask for it. The instruction this
    // replaced ("send me \"link google\"") named something no agent tool implemented, so the one
    // self-healing path the server has was a dead end: the warning fired, the owner did as told,
    // and nothing happened. A tappable link cannot be misrouted.
    body:
      "⚠️ My access to your Google Calendar has been revoked, so I can't see what's on or " +
      `work out when you need to leave. Tap to reconnect: ${googleLinkUrl(deviceId)}`,
    dedupeKey: `google-relink:${deviceId}:${localDateKey(Date.now(), device.timezone)}`,
  })
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
     * Set by the journey planner and by the day planner, and by nothing else. When Otto has already
     * arranged a get-ready nudge, a "leaving soon" nudge and a leave-now alarm, Calendar's default
     * popup is a fourth notification from a producer the server cannot see or coordinate with - and
     * a day laid out as eight blocks is that same problem eight times over, for entries that are the
     * SHAPE of the day rather than appointments to be interrupted about. Left alone for the ordinary
     * `create_calendar_event` tool, where the owner may well be relying on it.
     */
    suppressDefaultReminders?: boolean
  },
): Promise<{ id: string; htmlLink?: string }> {
  const auth = authedClientFor(deviceId)
  const timeZone = zoneFor(deviceId)
  const calendar = google.calendar({ version: 'v3', auth })
  const location = params.location?.trim()
  // Validated here like every sibling in this file, and unlike the version this replaces. An
  // offset-bearing string sent as `{ dateTime: '...+01:00', timeZone: 'Europe/London' }` has Google
  // honour the offset and ignore the zone - right most of the year, an hour out around a DST
  // change, and silent either way. `requireLocalIso` rejects it with the field named instead.
  const startIso = requireBodyLocalIso(params.startIso, timeZone, 'startLocalISO')
  const endIso = requireBodyLocalIso(params.endIso, timeZone, 'endLocalISO')
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: params.title,
      start: { dateTime: startIso, timeZone },
      end: { dateTime: endIso, timeZone },
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
    return toCalendarEvent(res.data)
  } catch (err) {
    log.warn({ err, deviceId, eventId }, 'calendar: events.get failed')
    return null
  }
}

/**
 * The HTTP status behind a googleapis rejection, or null.
 *
 * Three places are checked rather than one because gaxios has moved the status between `code`,
 * `status` and `response.status` across major versions, and being wrong in the permissive direction
 * is the worst outcome in this file: a transient 503 mistaken for a 404 has Otto tell the owner an
 * event "was already off your calendar" while it sits there, still on it.
 */
function httpStatusOf(err: unknown): number | null {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } }
  for (const v of [e?.code, e?.status, e?.response?.status]) {
    if (typeof v === 'number') return v
    if (typeof v === 'string' && /^\d{3}$/.test(v)) return Number(v)
  }
  return null
}

/**
 * An event Google no longer has.
 *
 * 404 (never existed) and 410 (already deleted) are the same fact from the owner's side, and this
 * is the race these tools actually hit: the event is resolved from a fresh listing and written to a
 * moment later, with a phone in the owner's pocket that can delete it in between.
 */
function isGone(err: unknown): boolean {
  const status = httpStatusOf(err)
  return status === 404 || status === 410
}

/** Someone else's event. `events.patch` on a meeting the owner was merely invited to answers 403. */
function isNotOurs(err: unknown): boolean {
  return httpStatusOf(err) === 403
}

/**
 * Thrown when Google refuses the write because the owner does not own the event.
 *
 * A sentinel rather than a message, so the tool layer can say something the owner can act on
 * without any part of this module knowing how Otto talks.
 */
export const NOT_ORGANISER = 'NOT_ORGANISER'

/**
 * Take one event off the device's primary calendar.
 *
 * `true` when it went, `false` when Google no longer had it. The second is a return value rather
 * than a throw because it is the owner's desired end state either way - the same call `deleteNote`
 * makes - but the two are kept DISTINCT all the way out to the model, because "I've cancelled it"
 * and "that was already gone" are different sentences to say to someone.
 *
 * `sendUpdates: 'none'` is a decision, not a default restated. Google's alternative is emailing
 * every attendee a cancellation notice. An assistant that silently mails the owner's colleagues on
 * the strength of one WhatsApp message is worse than one that changes only their own calendar and
 * says so - and it is the single consequence here that cannot be taken back. The tool description
 * and the prompt both promise nobody was told; this argument is the line that keeps that true.
 *
 * On a repeating event this is always ONE occurrence, because `listCalendarEvents` sets
 * `singleEvents` and the id resolved from it is an instance id. The series is reachable only
 * through `recurringEventId`, and only when the caller asked for it by name.
 */
export async function deleteCalendarEvent(deviceId: string, eventId: string): Promise<boolean> {
  const auth = authedClientFor(deviceId)
  const calendar = google.calendar({ version: 'v3', auth })
  try {
    await calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'none' })
    return true
  } catch (err) {
    if (isGone(err)) {
      log.warn({ deviceId, eventId }, 'calendar: events.delete found nothing there')
      return false
    }
    // A write is the ONLY thing some owners ever ask for in a week, so a revoked grant has to be
    // noticed here too. Until this existed, only reading the calendar queued the reconnect link -
    // so a delete against a revoked grant failed silently, forever, with the way back never sent.
    if (isInvalidGrant(err)) noteRevokedGrant(deviceId)
    if (isNotOurs(err)) throw new Error(NOT_ORGANISER)
    throw err
  }
}

/**
 * Patch one event and hand back GOOGLE's copy.
 *
 * Returning Google's version rather than the request is the discipline `planJourney` already
 * follows when it reads its own event back: Otto confirms from what happened, not from what was
 * asked for. `null` means Google no longer had it.
 *
 * A PATCH, never an UPDATE. `events.update` replaces the whole resource, so renaming a meeting
 * would silently drop its attendees, its description, its conference link and its reminder
 * overrides - none of which appear anywhere in `CalendarEvent`, which is exactly why nobody would
 * ever notice. Only the fields present in `patch` are sent.
 */
export async function updateCalendarEvent(
  deviceId: string,
  eventId: string,
  patch: { title?: string; startIso?: string; endIso?: string; location?: string },
): Promise<CalendarEvent | null> {
  const auth = authedClientFor(deviceId)
  const timeZone = zoneFor(deviceId)
  const calendar = google.calendar({ version: 'v3', auth })
  const startIso =
    patch.startIso === undefined ? undefined : requireBodyLocalIso(patch.startIso, timeZone, 'newStartLocalISO')
  const endIso =
    patch.endIso === undefined ? undefined : requireBodyLocalIso(patch.endIso, timeZone, 'newEndLocalISO')
  try {
    const res = await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'none',
      requestBody: {
        ...(patch.title !== undefined ? { summary: patch.title } : {}),
        ...(startIso !== undefined ? { start: { dateTime: startIso, timeZone } } : {}),
        ...(endIso !== undefined ? { end: { dateTime: endIso, timeZone } } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
      },
    })
    return toCalendarEvent(res.data)
  } catch (err) {
    if (isGone(err)) return null
    if (isInvalidGrant(err)) noteRevokedGrant(deviceId)
    if (isNotOurs(err)) throw new Error(NOT_ORGANISER)
    throw err
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
