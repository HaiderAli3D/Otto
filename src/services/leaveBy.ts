import { DateTime } from 'luxon'
import { leaveByAlarmId, wakeAlarmId } from '../lib/ids.js'
import { log } from '../lib/log.js'
import { inQuietHours } from '../lib/quietHours.js'
import { armAlarm } from './alarms.js'
import type { Device } from './devices.js'
import { factValue } from './facts.js'
import type { CalendarEvent } from './google.js'
import { cancelJobs, enqueueJob } from './jobs.js'
import { getSettings, quietHoursFor } from './settings.js'
import { localDateKey } from './time.js'
import { estimateTravelMinutes } from './travel.js'

/**
 * Leave-by alarms: the one thing Otto has that nothing else does is the owner's ringer, and it has
 * never been pointed at "you need to leave now".
 *
 * The app accepts exactly four commands and the only per-alarm things this server controls are
 * `label` and `triggerAtMillis` — no ringtone, no priority, no channel. So a leave-by alarm is an
 * ordinary `armAlarm` whose LABEL carries all of the meaning, and every decision (where they are,
 * how long the journey takes, whether this is even a journey) is made here, server-side. The phone
 * reports no location and holds no location permission, ever.
 */

/** How far ahead a leave-by alarm is worth arming at all. */
export const MAX_LOOKAHEAD_MS = 36 * 3_600_000

/** Below this the departure has effectively happened; ring nothing and say so. */
export const LEAVE_SOON_MS = 5 * 60_000

/** A preceding event this long before the target still tells us where they are starting from. */
export const PRECEDING_WINDOW_MS = 3 * 3_600_000

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

  // Before 10:00, or the first thing they do all day, means they are setting off from home. A
  // weekday mid-block with something already behind them means they are at work. Evenings and
  // weekends are home again. Work falls back to home rather than to nothing: a wrong-but-plausible
  // OFFER is recoverable, and a missing one just means the feature never appears.
  const key = dt.hour < 10 || firstOfDay ? 'home.address' : !weekend && dt.hour < 18 ? 'work.address' : 'home.address'
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
  // window. Deliberately not iterated to a fixed point: one call, one answer.
  const guessDepartAt = Math.max(now, startMillis - settings.defaultTravelMinutes * 60_000)
  const travel = await estimateTravelMinutes(device, origin?.address ?? null, destination, guessDepartAt)
  const leaveAtMillis = startMillis - travel.minutes * 60_000
  const wakeAtMillis = leaveAtMillis - getReadyMinutes * 60_000
  const mergedWithWake = wantWake && leaveAtMillis - wakeAtMillis <= MERGE_WINDOW_MS
  const dayKey = localDateKey(startMillis, zone)

  const priced: LeaveByPlan = {
    ...base,
    destination,
    origin,
    travelMinutes: travel.minutes,
    travelSource: travel.source,
    estimated: travel.source !== 'routes',
    leaveAtMillis,
    leaveAtLocal: localIsoOf(leaveAtMillis, zone),
    wakeAtMillis: wantWake ? wakeAtMillis : null,
    wakeAtLocal: wantWake ? localIsoOf(wakeAtMillis, zone) : null,
    mergedWithWake,
    label: leaveByLabel(event.summary, startMillis, zone),
    wakeLabelText: wantWake ? wakeLabel(event.summary, leaveAtMillis, zone) : null,
    alarmId: mergedWithWake ? null : leaveByAlarmId(device.deviceId, eventKey, dayKey),
    wakeId: wantWake ? wakeAlarmId(device.deviceId, eventKey, dayKey) : null,
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
  const overrun = events.some((e) => {
    if (eventKeyOf(e) === eventKey || e.isAllDay || e.status === 'cancelled') return false
    const start = isoToMillis(e.startIso, zone)
    const end = isoToMillis(e.endIso, zone)
    return start !== null && end !== null && start < startMillis && end > leaveAtMillis
  })
  if (overrun) {
    return { ...priced, blocked: 'double-booked', note: `Something else runs past the ${hhmm(leaveAtMillis, zone)} departure for "${event.summary}".` }
  }

  // Judge quiet hours on the EARLIEST thing that would ring. A departure at 07:30 is fine; the
  // 06:45 wake-up that goes with it is the one that lands inside the window.
  const ringAt = wantWake ? Math.min(wakeAtMillis, leaveAtMillis) : leaveAtMillis
  if (inQuietHours(ringAt, zone, quietHoursFor(device))) {
    return { ...priced, blocked: 'quiet-hours', note: `That would ring at ${hhmm(ringAt, zone)}, inside their quiet hours.` }
  }
  if (priced.estimated) {
    return {
      ...priced,
      blocked: 'estimated',
      note: `${travel.minutes} minutes is an estimate, not live traffic — offer it rather than assuming it.`,
    }
  }
  return { ...priced, note: `${travel.minutes} minutes of live traffic puts the departure at ${hhmm(leaveAtMillis, zone)}.` }
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

  if (opts.scheduleRecheck) {
    scheduleRecheck(device, plan, now)
  }
  return { ...plan, armed: true }
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
