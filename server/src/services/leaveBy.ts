import { DateTime } from 'luxon'
import { leaveByAlarmId, wakeAlarmId } from '../lib/ids.js'
import { log } from '../lib/log.js'
import { inQuietHours } from '../lib/quietHours.js'
import { dayStartHour } from '../lib/routine.js'
import { armAlarm, cancelAlarm, getAlarm } from './alarms.js'
import type { Device } from './devices.js'
import { factValue } from './facts.js'
import type { CalendarEvent } from './google.js'
import { cancelJobs, enqueueJob } from './jobs.js'
import { getSettings, quietHoursFor, schedulingRoutine } from './settings.js'
import { localDateKey } from './time.js'
import { estimateJourneyMinutes, TRANSIT_SLACK_MINUTES, type TravelMode, type Waypoint } from './travel.js'
import type { LatLng } from '../lib/geo.js'

/**
 * Leave-by alarms: the one thing Otto has that nothing else does is the owner's ringer, and it has
 * never been pointed at "you need to leave now".
 *
 * The only per-alarm things this server controls are `label` and `triggerAtMillis` — no ringtone, no
 * priority, no channel. So a leave-by alarm is an ordinary `armAlarm` whose LABEL carries all of the
 * meaning, and every decision (how long the journey takes, whether this is even a journey) is made
 * here, server-side.
 *
 * ⚠️ This used to say "the phone reports no location and holds no location permission, ever", and
 * that was true until app 1.2.0. It is now false in one narrow, deliberate way: the phone answers
 * ONE question when asked, and only ever when asked. It registers no update stream and stores no
 * coordinate. `resolveOrigin` below is unchanged and still never guesses — a fix reaches this module
 * through `originLatLng`, the same door the owner's own stated origin uses, and only after
 * `services/location.ts` has judged it fresh and precise enough to be worth more than the ladder.
 * See `shouldPull` there for the rule about WHEN asking is worth anything at all.
 */

/** How far ahead a leave-by alarm is worth arming at all. */
export const MAX_LOOKAHEAD_MS = 36 * 3_600_000

/** Below this the departure has effectively happened; ring nothing and say so. */
export const LEAVE_SOON_MS = 5 * 60_000

/** A preceding event this long before the target still tells us where they are starting from. */
export const PRECEDING_WINDOW_MS = 3 * 3_600_000

/**
 * How long after their day starts the owner is assumed to still be at home, and by when they are
 * assumed to have left work. Offsets rather than clock hours so both track a stated routine; the
 * values reproduce the original fixed 10:00 and 18:00 for the default 09:00 day start.
 */
const AT_HOME_HOURS_AFTER_DAY_START = 1
const AT_WORK_HOURS_AFTER_DAY_START = 9

/** Two alarms closer together than this are noise, not information. */
export const MERGE_WINDOW_MS = 20 * 60_000

/** How long before departure the single recheck runs. */
export const RECHECK_LEAD_MS = 45 * 60_000

/** Traffic moves; below this the re-arm would only churn the watchdog and the phone. */
export const TRAVEL_DRIFT_MINUTES = 5

/** The owner reads three words off a ringing lock screen. Everything else is decoration. */
const SUMMARY_MAX = 30
const LABEL_MAX = 60

/**
 * A location that is not a place you travel to.
 *
 * By far the most common false positive this feature can produce is a leave-by alarm for a video
 * call, so a virtual location disqualifies an event outright — as a destination AND as an origin.
 *
 * Keywords are anchored at the START, plus a URL anywhere (which is what a pasted invite looks
 * like). Anchoring keeps a real place whose NAME contains one of these words — "The Phone Box,
 * Hackney" — out of the net, and it is a substring test rather than a word boundary, so a location
 * beginning "Remoterie" is a false positive and Outlook's "Microsoft Teams Meeting" is a false
 * negative. Both are known and both are the cheap side of the trade: the URL test catches nearly
 * every real Teams invite anyway, because Outlook writes the join link into the location too.
 */
const VIRTUAL_PREFIX =
  /^(https?:\/\/|zoom|meet\.google|teams|webex|hangout|phone|call|tbd|tba|online|virtual|remote)/i
const CONTAINS_URL = /https?:\/\//i

export function isVirtualLocation(location: string): boolean {
  const trimmed = location.trim()
  return VIRTUAL_PREFIX.test(trimmed) || CONTAINS_URL.test(trimmed)
}

/**
 * Why this plan is an OFFER rather than an armed alarm — null when nothing stood in the way.
 *
 * The first group is structural: there is no journey here and no alarm will be armed by any path.
 * The second group ('double-booked', 'quiet-hours', 'estimated') is about confidence: the plan is
 * sound but nobody asked for it, so a proactive path only ever offers. An EXPLICIT request clears
 * the second group, because asking IS consent.
 */
export type LeaveByBlocked =
  | 'all-day'
  | 'no-start'
  | 'cancelled'
  | 'no-location'
  | 'virtual'
  | 'too-far-out'
  | 'past'
  | 'place-guessed'
  | 'double-booked'
  | 'quiet-hours'
  | 'estimated'

const STRUCTURAL: readonly LeaveByBlocked[] = [
  'all-day',
  'no-start',
  'cancelled',
  'no-location',
  'virtual',
  'too-far-out',
  'past',
  // Structural, not a confidence worry, and the placement is the decision rather than an oversight.
  // Every other block in the second group is about how sure we are of a NUMBER, which asking clears
  // — "they asked, asking is consent". This one is about not being sure of the PLACE, and consent to
  // an alarm is not consent to an alarm for somewhere they never named. A sole fuzzy search hit is
  // worth planning from and worth talking about; it is not worth ringing a phone about. The owner
  // says "yes, that one" and it becomes a saved place, which is confirmed, and then it arms.
  'place-guessed',
]

export type OriginResolution = { address: string; confidence: 'high' | 'medium' } | null

export type LeaveByPlan = {
  eventKey: string
  summary: string
  startMillis: number | null
  startLocal: string | null
  destination: string | null
  origin: OriginResolution
  travelMinutes: number | null
  travelSource: 'routes' | 'fact' | 'default' | null
  /** How they are getting there. Transit unless it is a short walk — see services/travel.ts. */
  mode: TravelMode
  /** Carried so the recheck routes to the same building the plan did. */
  destinationPlaceId: string | null
  /** What the walk would be, when we paid to find out. Lets Otto offer it as an alternative. */
  walkMinutes: number | null
  /** Google says this cannot be made at all — no service at that hour. Never a number to plan on. */
  noRoute: boolean
  /** True unless the number came from live traffic. Only a live number is ever auto-armed. */
  estimated: boolean
  leaveAtMillis: number | null
  leaveAtLocal: string | null
  wantWake: boolean
  getReadyMinutes: number
  wakeAtMillis: number | null
  wakeAtLocal: string | null
  /** Wake and departure are close enough that only the wake alarm is armed, carrying both times. */
  mergedWithWake: boolean
  label: string | null
  wakeLabelText: string | null
  blocked: LeaveByBlocked | null
  armed: boolean
  /** Deterministic, so every path that plans this event converges on the same row. */
  alarmId: string | null
  wakeId: string | null
  /**
   * The derived ids for this event and day that this plan does NOT use, and must therefore cancel.
   *
   * Both ids exist as soon as the event and the day do; which of them a plan arms depends on the
   * get-ready gap and on `alsoWakeMe`, and BOTH of those can change between one plan and the next.
   * Without this the counterpart from the previous plan stays armed alongside the new one — the
   * owner asks for a shorter get-ready time, the two alarms merge, and the old "leave now" alarm is
   * left ringing with no way to reach it, because the tool only ever returns the id it just armed.
   */
  staleIds: string[]
  /** One plain sentence the model can hand to the owner without inventing anything. */
  note: string
}

export type LeaveByRequest = {
  device: Device
  event: CalendarEvent
  /** The window the event came from, used to find the preceding event and the day's shape. */
  events?: CalendarEvent[]
  /** Overrides origin resolution entirely — the owner said where they are starting from. */
  originAddress?: string | null
  /**
   * Coordinates for either end, when something already knows them.
   *
   * Only ever an OPTIMISATION here: they let `chooseTravelMode` rule a walk out from the straight
   * line and skip a billed probe. A missing pair costs one call, never a wrong answer.
   */
  originLatLng?: LatLng | null
  destinationLatLng?: LatLng | null
  /** Google's id for the destination, preferred over re-geocoding an address Places already read. */
  destinationPlaceId?: string | null
  /**
   * The owner would recognise the destination as the place they meant. Defaults to true so every
   * existing caller — which resolves the destination from a calendar event the owner authored — is
   * unaffected. `planJourney` passes what `resolvePlace` actually decided.
   */
  destinationConfirmed?: boolean
  /** "I'll drive", "I'm cycling". Wins over the transit-unless-short-walk rule. */
  travelMode?: TravelMode | null
  getReadyMinutes?: number
  /** undefined defers to `settings.autoWakeAlarm`; an explicit boolean wins. */
  alsoWakeMe?: boolean
  now?: number
}

/** What the recheck job carries. The job row IS the cache — there is no leave-by table. */
export type LeaveByJobPayload = {
  /** The event KEY (`id` when Google gave one, else the summary), not necessarily an event id. */
  eventId: string
  eventStartMillis: number
  summary: string
  destination: string
  originAddress: string | null
  travelMinutes: number
  /**
   * How they were getting there when this was planned.
   *
   * Optional because rows enqueued before this field existed are read after the deploy. `undefined`
   * means "decide by the rule", which reprices an old row one recheck later — the same safe-default
   * reasoning as `DEFAULT_TIMING_KIND` in lib/rungPlan.ts, applied to the only value that would
   * otherwise silently change under an in-flight journey.
   */
  mode?: TravelMode
  /** Routes the recheck to the same building rather than re-geocoding prose Places already read. */
  destinationPlaceId?: string | null
  getReadyMinutes: number
  wantWake: boolean
  /** Null when the plan merged into the wake alarm; then `wakeId` is the alarm that exists. */
  alarmId: string | null
  wakeId: string | null
}

/** A bare local wall-clock ISO for an arbitrary instant — `localIsoAt` pins the hour, we can't. */
export function localIsoOf(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("yyyy-MM-dd'T'HH:mm:ss")
}

/** Epoch millis for a calendar ISO. Offset-bearing strings carry their own instant; bare dates don't. */
function isoToMillis(iso: string, zone: string): number | null {
  if (!iso) return null
  const dt = DateTime.fromISO(iso, { zone })
  return dt.isValid ? dt.toMillis() : null
}

const hhmm = (ms: number, zone: string): string => DateTime.fromMillis(ms, { zone }).toFormat('HH:mm')

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/**
 * Action first, because the owner reads maybe three words off a ringing lock screen before deciding
 * whether to care. The summary is what gets truncated; the verb never is. The whole label is capped
 * as well — `fcm/sender.ts` notes that an oversized data payload comes back INVALID_ARGUMENT, and a
 * model-supplied summary is the only unbounded thing in it.
 */
export function leaveByLabel(summary: string, startMillis: number, zone: string): string {
  return truncate(`Leave now — ${truncate(summary, SUMMARY_MAX)}, ${hhmm(startMillis, zone)}`, LABEL_MAX)
}

/** The wake label carries the LEAVE time, which is the number they actually need on waking. */
export function wakeLabel(summary: string, leaveAtMillis: number, zone: string): string {
  return truncate(`Up — leave ${hhmm(leaveAtMillis, zone)} for ${truncate(summary, SUMMARY_MAX)}`, LABEL_MAX)
}

/** The stable key for an event across rechecks: Google's id, or the summary when it gave none. */
export const eventKeyOf = (e: CalendarEvent): string => e.id || e.summary

/** Epoch millis of an event's start, or null when it has no usable one. */
export const eventStartMillis = (e: CalendarEvent, zone: string): number | null => isoToMillis(e.startIso, zone)

/**
 * Epoch millis of an event's end, or null when it has no usable one.
 *
 * The twin of `eventStartMillis`, and the reason both exist: `isoToMillis` is private to this
 * module, and `toCalendarEvent` falls back to '' when Google returned no end at all, so every
 * caller outside here would otherwise have to reinvent the same null check.
 */
export const eventEndMillis = (e: CalendarEvent, zone: string): number | null => isoToMillis(e.endIso, zone)

/**
 * Does this event occupy any part of the half-open window [fromMillis, toMillis)?
 *
 * Extracted from `computeLeaveByPlan`'s overrun check, which was the only overlap test in the
 * system, so that a second caller cannot grow a second answer to the same question. The two
 * exclusions are the whole reason it is a function rather than an inlined comparison.
 *
 * An all-day entry never counts. It spans midnight to midnight, so any caller that forgot would
 * conclude the owner is busy for twenty-four hours — which for the leave-by planner means every
 * departure that day reads as double-booked, and for a day plan means that a single "Annual leave"
 * makes the day off the one day nothing can be planned on.
 *
 * Half-open at both ends, so 10:00-11:00 and 11:00-12:00 do NOT overlap. Back-to-back is what a
 * planned day is supposed to look like, and a closed comparison would refuse to write the second
 * block of every pair.
 */
export function overlapsWindow(
  e: CalendarEvent,
  fromMillis: number,
  toMillis: number,
  zone: string,
): boolean {
  if (e.isAllDay || e.status === 'cancelled') return false
  const start = isoToMillis(e.startIso, zone)
  const end = isoToMillis(e.endIso, zone)
  return start !== null && end !== null && start < toMillis && end > fromMillis
}

/**
 * Where the journey starts. NEVER a guess — an unknown origin returns null and the caller degrades
 * to the estimate ladder, which can never auto-arm.
 *
 * 1. The event immediately before the target, if it is a real place and ends close enough that they
 *    are plausibly still there. This is the only 'high' confidence answer, and the only one drawn
 *    from something the owner actually did rather than something we assumed.
 * 2. A fact, chosen by time of day in the device's zone. 'medium' at best: it is a default address,
 *    not an observation.
 * 3. Nothing.
 */
export function resolveOrigin(params: {
  device: Device
  targetKey: string
  targetStartMillis: number
  events: CalendarEvent[]
}): OriginResolution {
  const zone = params.device.timezone
  const preceding = params.events
    .filter((e) => eventKeyOf(e) !== params.targetKey && !e.isAllDay && e.status !== 'cancelled')
    .map((e) => ({ e, start: isoToMillis(e.startIso, zone), end: isoToMillis(e.endIso, zone) }))
    .filter((c): c is { e: CalendarEvent; start: number; end: number } => c.start !== null && c.end !== null)
    .filter((c) => c.end <= params.targetStartMillis && c.end >= params.targetStartMillis - PRECEDING_WINDOW_MS)
    .filter((c) => {
      const loc = c.e.location?.trim()
      return loc !== undefined && loc.length > 0 && !isVirtualLocation(loc)
    })
    .sort((a, b) => b.end - a.end)[0]
  if (preceding) return { address: preceding.e.location!.trim(), confidence: 'high' }

  const dt = DateTime.fromMillis(params.targetStartMillis, { zone })
  const weekend = dt.weekday >= 6
  const firstOfDay = !params.events.some((e) => {
    if (eventKeyOf(e) === params.targetKey || e.isAllDay || e.status === 'cancelled') return false
    const start = isoToMillis(e.startIso, zone)
    if (start === null || start >= params.targetStartMillis) return false
    return DateTime.fromMillis(start, { zone }).toISODate() === dt.toISODate()
  })

  // Early in THEIR day, or the first thing they do all day, means they are setting off from home. A
  // weekday mid-block with something already behind them means they are at work. Evenings and
  // weekends are home again. Work falls back to home rather than to nothing: a wrong-but-plausible
  // OFFER is recoverable, and a missing one just means the feature never appears.
  //
  // Measured from the owner's own day start rather than from a fixed 10:00 and 18:00. Those two
  // numbers were the same guess as the ladder's hardcoded 09:00 morning, and they fail the same way:
  // for someone who gets up at 14:00, every single 11:00 event would be priced from their work
  // address while they were still asleep at home. Identical arithmetic for the default routine,
  // whose day starts at 09:00.
  const dayStart = dayStartHour(schedulingRoutine(params.device))
  const atHomeUntil = dayStart + AT_HOME_HOURS_AFTER_DAY_START
  const atWorkUntil = dayStart + AT_WORK_HOURS_AFTER_DAY_START
  const key =
    dt.hour < atHomeUntil || firstOfDay
      ? 'home.address'
      : !weekend && dt.hour < atWorkUntil
        ? 'work.address'
        : 'home.address'
  const raw = factValue(params.device.deviceId, key) ?? (key === 'work.address' ? factValue(params.device.deviceId, 'home.address') : null)
  const address = raw?.trim()
  if (address === undefined || address.length === 0 || isVirtualLocation(address)) return null
  return { address, confidence: 'medium' }
}

/**
 * Everything about a leave-by alarm except arming it. No writes, no pushes — so the recheck can ask
 * "what would this be now?" and compare, and the tool can report a blocked plan without side
 * effects. Exactly one network call, to Routes, and only when there is an origin and a key.
 */
export async function computeLeaveByPlan(req: LeaveByRequest): Promise<LeaveByPlan> {
  const { device, event } = req
  const zone = device.timezone
  const now = req.now ?? Date.now()
  const events = req.events ?? []
  const settings = getSettings(device.deviceId)
  const getReadyMinutes = req.getReadyMinutes ?? settings.getReadyMinutes
  const wantWake = req.alsoWakeMe ?? settings.autoWakeAlarm
  const eventKey = eventKeyOf(event)
  const startMillis = isoToMillis(event.startIso, zone)

  const base: LeaveByPlan = {
    eventKey,
    summary: event.summary,
    startMillis,
    startLocal: startMillis === null ? null : localIsoOf(startMillis, zone),
    destination: null,
    origin: null,
    travelMinutes: null,
    travelSource: null,
    mode: req.travelMode ?? 'TRANSIT',
    destinationPlaceId: req.destinationPlaceId ?? null,
    walkMinutes: null,
    noRoute: false,
    estimated: true,
    leaveAtMillis: null,
    leaveAtLocal: null,
    wantWake,
    getReadyMinutes,
    wakeAtMillis: null,
    wakeAtLocal: null,
    mergedWithWake: false,
    label: null,
    wakeLabelText: null,
    blocked: null,
    armed: false,
    alarmId: null,
    wakeId: null,
    staleIds: [],
    note: '',
  }

  if (event.isAllDay) {
    return { ...base, blocked: 'all-day', note: `"${event.summary}" is an all-day entry, so there is no time to leave for.` }
  }
  if (startMillis === null) {
    return { ...base, blocked: 'no-start', note: `"${event.summary}" has no usable start time.` }
  }
  if (event.status === 'cancelled') {
    return { ...base, blocked: 'cancelled', note: `"${event.summary}" is cancelled.` }
  }
  if (startMillis - now > MAX_LOOKAHEAD_MS) {
    return { ...base, blocked: 'too-far-out', note: `"${event.summary}" is more than 36 hours away; traffic that far ahead is a guess.` }
  }

  const destination = event.location?.trim() ?? ''
  if (destination.length === 0) {
    return { ...base, blocked: 'no-location', note: `"${event.summary}" has no location, so there is nothing to work out a journey to.` }
  }
  if (isVirtualLocation(destination)) {
    return { ...base, blocked: 'virtual', destination, note: `"${event.summary}" is online, so there is nowhere to leave for.` }
  }

  const override = req.originAddress?.trim()
  const origin: OriginResolution =
    override !== undefined && override.length > 0 && !isVirtualLocation(override)
      ? { address: override, confidence: 'high' }
      : resolveOrigin({ device, targetKey: eventKey, targetStartMillis: startMillis, events })

  // Bootstrap the departure time from the configured default so Routes gets a plausible traffic
  // window. Deliberately not iterated to a fixed point: one call, one answer. That argument is
  // DRIVE-specific and transit does not use this number at all — it asks the timetable by arrival
  // time instead, which is the quantity we actually know.
  const guessDepartAt = Math.max(now, startMillis - settings.defaultTravelMinutes * 60_000)
  const originWaypoint: Waypoint | null =
    req.originLatLng != null ? { latLng: req.originLatLng } : origin === null ? null : { address: origin.address }
  const destinationWaypoint: Waypoint = req.destinationPlaceId
    ? { placeId: req.destinationPlaceId }
    : { address: destination }
  const travel = await estimateJourneyMinutes({
    device,
    origin: originWaypoint,
    destination: destinationWaypoint,
    originLatLng: req.originLatLng ?? null,
    destinationLatLng: req.destinationLatLng ?? null,
    modeOverride: req.travelMode ?? null,
    arriveByMillis: startMillis,
    departAtMillis: guessDepartAt,
  })
  // Slack for a transit journey, and ONLY for one priced from a real timetable.
  //
  // A driving estimate is continuous in the departure time, so being a minute out costs a minute.
  // A timetable is a step function: Routes answers with one itinerary, and missing its first leg by
  // ninety seconds can cost a full headway. A missed connection is not the owner being late.
  //
  // Gated on `source === 'routes'` because the fallback ladder returns the same flat number whatever
  // mode was asked for — padding a guess would be arithmetic on a number that means nothing.
  const slackMinutes = travel.mode === 'TRANSIT' && travel.source === 'routes' ? TRANSIT_SLACK_MINUTES : 0
  const leaveAtMillis = startMillis - (travel.minutes + slackMinutes) * 60_000
  const dayKey = localDateKey(startMillis, zone)

  // The get-up alarm is bounds-checked against `now` in its own right, not left to ride on the
  // departure's check. "Wake me in time for the 9am dentist", asked at 08:00 with a 30-minute
  // journey, puts the departure at 08:30 — comfortably armable — and the wake alarm at 07:45,
  // three quarters of an hour in the PAST. Arming that is worse than not: the app marks a trigger
  // more than a minute stale MISSED, so nothing rings and no ARMED report ever comes back, the
  // arm-ack watchdog resends three times and then warns the owner an alarm may not have reached
  // their phone, and the model has meanwhile been handed a wake time that has already gone and will
  // promise it. Drop the wake half, keep the departure, and say so in `note`.
  const wakeAtMillis = leaveAtMillis - getReadyMinutes * 60_000
  const wakeArmable = wantWake && wakeAtMillis > now + LEAVE_SOON_MS
  const mergedWithWake = wakeArmable && leaveAtMillis - wakeAtMillis <= MERGE_WINDOW_MS
  const wakeNote = wantWake && !wakeArmable ? ' There is no time for a separate get-up alarm, so only the departure is armed.' : ''

  // Both ids for this event and day, then the two decisions about which of them this plan uses.
  // The unused one goes to `staleIds` rather than being forgotten — see the field's doc comment.
  const leaveId = leaveByAlarmId(device.deviceId, eventKey, dayKey)
  const wakeIdOfDay = wakeAlarmId(device.deviceId, eventKey, dayKey)
  const alarmId = mergedWithWake ? null : leaveId
  const wakeId = wakeArmable ? wakeIdOfDay : null

  const priced: LeaveByPlan = {
    ...base,
    destination,
    origin,
    travelMinutes: travel.minutes,
    travelSource: travel.source,
    mode: travel.mode,
    destinationPlaceId: req.destinationPlaceId ?? null,
    walkMinutes: travel.walkMinutes,
    noRoute: travel.noRoute,
    estimated: travel.source !== 'routes',
    leaveAtMillis,
    leaveAtLocal: localIsoOf(leaveAtMillis, zone),
    wakeAtMillis: wakeArmable ? wakeAtMillis : null,
    wakeAtLocal: wakeArmable ? localIsoOf(wakeAtMillis, zone) : null,
    mergedWithWake,
    label: leaveByLabel(event.summary, startMillis, zone),
    wakeLabelText: wakeArmable ? wakeLabel(event.summary, leaveAtMillis, zone) : null,
    alarmId,
    wakeId,
    staleIds: [alarmId === null ? leaveId : null, wakeId === null ? wakeIdOfDay : null].filter(
      (id): id is string => id !== null,
    ),
  }

  if (leaveAtMillis <= now + LEAVE_SOON_MS) {
    const late = Math.max(0, Math.round((now - leaveAtMillis) / 60_000))
    return {
      ...priced,
      blocked: 'past',
      note:
        late > 0
          ? `They needed to leave ${late} minute${late === 1 ? '' : 's'} ago for "${event.summary}" — nothing armed.`
          : `They need to leave for "${event.summary}" right now — too late to be worth an alarm.`,
    }
  }

  // Someone is still in the room with them when they should be walking out. Worth offering, never
  // worth arming unasked: the honest answer is a conversation, not a ringer.
  const overrun = events.some(
    (e) => eventKeyOf(e) !== eventKey && overlapsWindow(e, leaveAtMillis, startMillis, zone),
  )
  if (overrun) {
    return {
      ...priced,
      blocked: 'double-booked',
      note: `Something else runs past the ${hhmm(leaveAtMillis, zone)} departure for "${event.summary}".${wakeNote}`,
    }
  }

  // Judge quiet hours on the EARLIEST thing that would ring — and only on something that WOULD
  // ring: a wake time already in the past is not armed, so it must not veto the departure either.
  const ringAt = wakeArmable ? Math.min(wakeAtMillis, leaveAtMillis) : leaveAtMillis
  if (inQuietHours(ringAt, zone, quietHoursFor(device))) {
    return { ...priced, blocked: 'quiet-hours', note: `That would ring at ${hhmm(ringAt, zone)}, inside their quiet hours.${wakeNote}` }
  }
  // Judged AFTER 'past' and 'double-booked' so the owner hears the more urgent problem first, and
  // before 'estimated' because not knowing WHERE beats not knowing how long.
  if (req.destinationConfirmed === false) {
    return {
      ...priced,
      blocked: 'place-guessed',
      note: `"${destination}" is the one place that came back for that, but they never confirmed it — check it is the right one before anything rings.${wakeNote}`,
    }
  }
  if (priced.estimated) {
    return {
      ...priced,
      blocked: 'estimated',
      note: `${travel.minutes} minutes is an estimate, not live traffic — offer it rather than assuming it.${wakeNote}`,
    }
  }
  return { ...priced, note: `${travel.minutes} minutes of live traffic puts the departure at ${hhmm(leaveAtMillis, zone)}.${wakeNote}` }
}

/**
 * May this plan ring the phone by itself?
 *
 * The owner's explicit decision, and the one that keeps the feature alive: a colleague's calendar
 * invite must never ring the phone at 05:40 unasked. One wrong early alarm and the whole thing gets
 * switched off. So unless `autoLeaveByAlarm` is on, a proactive plan is an OFFER; and even with it
 * on, only a plan with nothing at all against it arms.
 */
export function mayArm(plan: LeaveByPlan, opts: { explicit: boolean; autoLeaveByAlarm: boolean }): boolean {
  if (plan.leaveAtMillis === null) return false
  if (plan.blocked === null) return opts.explicit || opts.autoLeaveByAlarm
  return opts.explicit && !STRUCTURAL.includes(plan.blocked)
}

/**
 * Arm the plan's alarms and leave exactly one recheck behind.
 *
 * Both ids are derived, so this is a replace rather than an add however many times it runs — that
 * is what makes the tool, a proactive plan and the recheck itself safe to interleave.
 */
export async function armLeaveByPlan(
  device: Device,
  plan: LeaveByPlan,
  opts: { scheduleRecheck: boolean; now?: number },
): Promise<LeaveByPlan> {
  const now = opts.now ?? Date.now()
  if (plan.leaveAtMillis === null || plan.startMillis === null || plan.travelMinutes === null) return plan

  if (plan.alarmId !== null && plan.label !== null) {
    await armAlarm(device, { alarmId: plan.alarmId, triggerAtMillis: plan.leaveAtMillis, label: plan.label })
  }
  if (plan.wakeId !== null && plan.wakeAtMillis !== null && plan.wakeLabelText !== null) {
    await armAlarm(device, { alarmId: plan.wakeId, triggerAtMillis: plan.wakeAtMillis, label: plan.wakeLabelText })
  }

  // Retire the counterpart this plan does not use. Arm FIRST and cancel after: a crash in between
  // leaves a duplicate, which the next plan for this event collapses, rather than no alarm at all.
  // Only a row that exists and is still ARMED is touched — otherwise every plan would push a
  // pointless CANCEL to the phone for an id that has never been armed. `cancelAlarm` also drops the
  // recheck job anchored on that id, which is what stops a re-plan leaving two of them behind.
  for (const staleId of plan.staleIds) {
    if (getAlarm(staleId)?.state === 'ARMED') await cancelAlarm(device, staleId)
  }

  if (opts.scheduleRecheck) {
    scheduleRecheck(device, plan, now)
  }
  return { ...plan, armed: true }
}

/**
 * Retire any leave-by machinery hanging off an event that has just been removed or moved.
 *
 * The recheck already does this when it runs (`handlers/leaveBy.ts` cancels both alarms when the
 * event has vanished), but it runs exactly ONCE, at departure minus forty-five minutes. Delete the
 * event after that moment and nothing else ever looks: the alarm stays armed and the phone rings,
 * at full volume, over the lockscreen, to send the owner somewhere they are no longer going. That
 * is the single worst outcome this feature can produce, and it is the one the ringer is loudest
 * about.
 *
 * No lookup table is needed because the ids are DERIVED - `leaveByAlarmId`/`wakeAlarmId` are a
 * hash of (kind, deviceId, eventKey, dayKey), so the alarm for an event can be recomputed from the
 * event. That property was built to make duplicate alarms unrepresentable; it pays for itself a
 * second time here.
 *
 * Three days are checked rather than one. An event that MOVED is re-armed by the recheck under the
 * ids it was originally armed with (`handlers/leaveBy.ts` pins them deliberately), so the live
 * alarm can be filed under the day the event used to be on rather than the day it is on now.
 *
 * Only rows that exist and are still ARMED are touched, so this never pushes a pointless CANCEL to
 * the phone. `cancelAlarm` also drops the recheck job anchored on the id, which is what stops a
 * deleted event leaving a job behind to wake up and find nothing.
 */
export async function releaseLeaveByFor(
  device: Device,
  eventKey: string,
  eventStartMillis: number,
): Promise<string[]> {
  const cancelled: string[] = []
  const day = DateTime.fromMillis(eventStartMillis, { zone: device.timezone })
  for (const offset of [-1, 0, 1]) {
    const dayKey = localDateKey(day.plus({ days: offset }).toMillis(), device.timezone)
    for (const id of [
      leaveByAlarmId(device.deviceId, eventKey, dayKey),
      wakeAlarmId(device.deviceId, eventKey, dayKey),
    ]) {
      if (getAlarm(id)?.state !== 'ARMED') continue
      await cancelAlarm(device, id)
      cancelled.push(id)
    }
  }
  if (cancelled.length > 0) {
    log.info({ deviceId: device.deviceId, eventKey, cancelled }, 'leave-by: released for a removed or moved event')
  }
  return cancelled
}

/**
 * Leave ONE 'leave_by' job at departure minus 45 minutes, carrying enough to re-decide.
 *
 * The job row is the cache: there is no table of planned journeys, and there does not need to be —
 * the only thing anyone ever asks is "is this still true?", and the only time worth asking is just
 * before it matters. Anchored on the alarm id so `cancelJobs` collapses a re-plan to one row.
 */
function scheduleRecheck(device: Device, plan: LeaveByPlan, now: number): void {
  const anchor = plan.alarmId ?? plan.wakeId
  if (anchor === null || plan.leaveAtMillis === null || plan.travelMinutes === null) return
  const runAt = Math.max(plan.leaveAtMillis - RECHECK_LEAD_MS, now + 60_000)
  // Nothing to recheck if the departure lands first — the alarm will already have rung.
  if (runAt >= plan.leaveAtMillis) return
  const payload: LeaveByJobPayload = {
    eventId: plan.eventKey,
    eventStartMillis: plan.startMillis!,
    summary: plan.summary,
    destination: plan.destination ?? '',
    originAddress: plan.origin?.address ?? null,
    travelMinutes: plan.travelMinutes,
    mode: plan.mode,
    destinationPlaceId: plan.destinationPlaceId,
    getReadyMinutes: plan.getReadyMinutes,
    wantWake: plan.wantWake,
    alarmId: plan.alarmId,
    wakeId: plan.wakeId,
  }
  cancelJobs('leave_by', anchor)
  enqueueJob('leave_by', runAt, { alarmId: anchor, deviceId: device.deviceId, payload })
}

/**
 * Plan an event and arm it if it is allowed to. The one entry point every caller other than the
 * recheck uses; `explicit` is the difference between the owner asking and Otto deciding.
 */
export async function planLeaveBy(req: LeaveByRequest & { explicit: boolean }): Promise<LeaveByPlan> {
  const plan = await computeLeaveByPlan(req)
  const settings = getSettings(req.device.deviceId)
  if (!mayArm(plan, { explicit: req.explicit, autoLeaveByAlarm: settings.autoLeaveByAlarm })) {
    log.debug({ deviceId: req.device.deviceId, blocked: plan.blocked }, 'leave-by: offering rather than arming')
    return plan
  }
  return armLeaveByPlan(req.device, plan, { scheduleRecheck: true, now: req.now })
}

/**
 * Which events in the window the owner could have meant.
 *
 * Substring in either direction and nothing cleverer, deliberately: the caller's contract is to ASK
 * when this returns more than one, so a fuzzy matcher that confidently picks the wrong standup is
 * strictly worse than a blunt one that surfaces both. A supplied start time narrows a tie but never
 * eliminates every candidate — the model's guess at "tomorrow morning" is often an hour out.
 */
export function matchEvents(
  events: CalendarEvent[],
  description: string,
  startMillis: number | null,
  zone: string,
): CalendarEvent[] {
  const needle = description.trim().toLowerCase()
  const live = events.filter((e) => e.status !== 'cancelled')
  const byText =
    needle.length === 0
      ? live
      : live.filter((e) => {
          const summary = e.summary.trim().toLowerCase()
          return summary.includes(needle) || needle.includes(summary)
        })
  if (startMillis === null || byText.length < 2) return byText
  const NEAR_MS = 90 * 60_000
  const byTime = byText.filter((e) => {
    const start = isoToMillis(e.startIso, zone)
    return start !== null && Math.abs(start - startMillis) <= NEAR_MS
  })
  return byTime.length > 0 ? byTime : byText
}
