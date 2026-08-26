import { DateTime } from 'luxon'
import { log } from '../lib/log.js'
import { normaliseOffsets } from '../lib/rungPlan.js'
import type { Device } from './devices.js'
import { createCalendarEvent, getCalendarEvent, hasGoogle, tryListCalendarEvents, type CalendarEvent } from './google.js'
import {
  localIsoOf,
  MAX_LOOKAHEAD_MS,
  planLeaveBy,
  type LeaveByPlan,
} from './leaveBy.js'
import { resolvePlace, type PlaceCandidate, type ResolvedPlace } from './places.js'
import { createReminder } from './reminders.js'
import { rememberPlace } from './savedPlaces.js'
import { getSettings } from './settings.js'
import { TRANSIT_SLACK_MINUTES, type TravelMode } from './travel.js'

/**
 * "I'm going to the dentist at 3pm."
 *
 * The gap between this and `create_leave_by_alarm` is not how they work but what they are GIVEN.
 * That one is handed an event that already exists and reads it. This one is handed a place and a
 * time and has to make everything: work out where that place is, put it on the calendar, price the
 * journey, arm the departure, and leave a reminder behind that the owner can mark done.
 *
 * It does not reimplement any of the leave-by machinery. `computeLeaveByPlan` owns the guardrail
 * ladder, the merge window, the derived ids, `staleIds`, `mayArm` and the recheck — roughly forty
 * pinned tests' worth — and the leave-by half of a planned journey is byte-for-byte the leave-by
 * that already works. This module is the ORDERING around it, and the ordering is the design.
 *
 * Lives here rather than in leaveBy.ts because that module's contract is "everything about a
 * leave-by alarm except arming it: no writes, no pushes", and `handlers/leaveBy.ts` imports it on a
 * scheduler path. This writes a calendar event and a reminder, and dragging google.ts, reminders.ts
 * and places.ts into that import graph would make its doc comment false.
 */

/** How long a journey's calendar entry lasts when the owner did not say. */
const DEFAULT_EVENT_MINUTES = 60

/** How far ahead of walking out "you'll be leaving soon" lands. */
const LEAVING_SOON_LEAD_MINUTES = 10

/** The day-before heads-up. Pruned automatically when the journey is planned the same day. */
const DAY_BEFORE_MINUTES = 24 * 60

/**
 * A rung this close to an alarm IS the alarm, said twice.
 *
 * The ringer wins every collision, every time. It is the one channel that interrupts and the one the
 * owner cannot miss; a notification arriving in the same minute reads as a duplicate, and duplicates
 * are how an owner learns to swipe a whole tier away.
 */
export const ALARM_RUNG_GUARD_MINUTES = 5

export type JourneyRequest = {
  device: Device
  /** What they called the place. "the dentist", "Wembley Stadium", "14 High Street".  */
  destinationQuery: string
  arriveByMillis: number
  title?: string | null
  durationMinutes?: number | null
  /** Where they are setting off from, if they said. Otherwise it is worked out. */
  originQuery?: string | null
  /** The owner's answer to an earlier ambiguity — skips the lookup entirely. */
  placeId?: string | null
  address?: string | null
  /** "I'll drive", "I'm cycling". Wins over the transit-unless-short-walk rule. */
  travelMode?: TravelMode | null
  /** Save the destination under this name so it is free and unambiguous next time. */
  rememberPlaceAs?: string | null
  getReadyMinutes?: number
  alsoWakeMe?: boolean
  now?: number
}

export type PlannedJourney = {
  destination: ResolvedPlace
  mode: TravelMode
  travelMinutes: number
  estimated: boolean
  noRoute: boolean
  calendarEventId: string | null
  /** Set when the calendar entry could NOT be written. The journey still stands. */
  calendarNote: string | null
  plan: LeaveByPlan
  reminderId: string
  leadMinutes: number[]
}

export type JourneyOutcome =
  | { kind: 'ambiguous'; candidates: PlaceCandidate[] }
  | { kind: 'unknown'; note: string }
  | { kind: 'planned'; journey: PlannedJourney }

/**
 * When to warn them, in minutes before the appointment starts.
 *
 * `travelMinutes` itself is deliberately ABSENT from the candidates. That instant is the leave-now
 * alarm, and a nudge at the same second is the alarm said twice on a quieter channel.
 *
 * The get-up alarm collides for a reason that is structural rather than unlucky: it fires at
 * `leaveAt − getReady`, and the "time to start getting ready" rung is `start − (travel + getReady)`.
 * Those are the same expression. So the filter runs against the instants that will actually RING,
 * which is why this can only be computed AFTER `planLeaveBy` returns — only then is it known
 * whether a wake alarm was armed at all, or merged into the departure.
 */
export function journeyLeadMinutes(p: {
  dueAtMillis: number
  travelMinutes: number
  getReadyMinutes: number
  /** Instants that will ring: the departure alarm and the get-up alarm, when armed. */
  ringingAt: number[]
}): number[] {
  const guardMs = ALARM_RUNG_GUARD_MINUTES * 60_000
  return [DAY_BEFORE_MINUTES, p.travelMinutes + p.getReadyMinutes, p.travelMinutes + LEAVING_SOON_LEAD_MINUTES]
    .filter((m) => m > 0)
    .filter((m) => !p.ringingAt.some((at) => Math.abs(p.dueAtMillis - m * 60_000 - at) <= guardMs))
    .sort((a, b) => b - a)
}

/**
 * A CalendarEvent shape for an entry we could not write to Google.
 *
 * Every field Google would have supplied is at its "we know nothing" value, `id` included — which
 * is the honest answer and also the one the rest of the system reads correctly: an empty id makes
 * `eventKeyOf` fall back to the summary, and the calendar-editing tools refuse outright to act on
 * an event whose id never came from Google.
 */
function syntheticEvent(p: { title: string; startIso: string; endIso: string; location: string }): CalendarEvent {
  return {
    id: '',
    summary: p.title,
    startIso: p.startIso,
    endIso: p.endIso,
    isAllDay: false,
    location: p.location,
    status: null,
    // Nobody was invited, so there is no RSVP to read — the "we know nothing" value, like the rest.
    selfResponse: null,
    recurringEventId: null,
    organizerSelf: false,
    attendeeCount: 0,
    eventType: null,
  }
}

/**
 * Resolve, record, price, arm, and leave something behind to mark done.
 *
 * THE ORDER IS THE DESIGN. Nothing is created on a question: the destination is resolved before any
 * billed route call, any calendar write, any alarm and any reminder, and an ambiguous or unknown
 * place returns immediately. The expensive and irreversible half never runs on a destination we are
 * not sure of.
 */
export async function planJourney(req: JourneyRequest): Promise<JourneyOutcome> {
  const { device } = req
  const zone = device.timezone
  const now = req.now ?? Date.now()
  const settings = getSettings(device.deviceId)

  // 1. Where are they going?
  const resolution = await resolvePlace(device, req.destinationQuery, {
    placeId: req.placeId ?? null,
    address: req.address ?? null,
    nowMillis: now,
  })
  if (resolution.kind !== 'resolved') return resolution
  const destination = resolution.place

  // 2. Where are they starting? An explicit origin is resolved the same way; otherwise it is left
  //    to `resolveOrigin` inside computeLeaveByPlan, which reads the calendar and the home/work
  //    facts and — crucially — returns null rather than guessing.
  let originAddress: string | null = null
  if (req.originQuery) {
    const from = await resolvePlace(device, req.originQuery, { nowMillis: now })
    if (from.kind === 'resolved') originAddress = from.place.address
  }

  // 3. The calendar window, read ONCE. `resolveOrigin` needs the preceding event, the double-booked
  //    check needs the day, and a null (unreachable, or Google never linked) degrades rather than
  //    failing — this is not a reason to refuse to plan a journey.
  const events =
    (await tryListCalendarEvents(device.deviceId, localIsoOf(now, zone), localIsoOf(now + MAX_LOOKAHEAD_MS, zone))) ??
    []

  // 4. Put it on the calendar, WITH the resolved address, and then read Google's copy back.
  //
  //    Both halves are load-bearing and both failure modes end the same way — the recheck cancelling
  //    the alarms 45 minutes before departure, silently. An event with no location comes back
  //    `blocked: 'no-location'`, which handlers/leaveBy.ts reads as "this stopped being a journey".
  //    And planning from the object we just built rather than Google's means `eventKeyOf` falls back
  //    to the summary, which never matches the real id the recheck looks the event up by.
  const title = (req.title?.trim() || destination.label).slice(0, 120)
  const durationMinutes = Math.min(Math.max(req.durationMinutes ?? DEFAULT_EVENT_MINUTES, 5), 24 * 60)
  const startIso = localIsoOf(req.arriveByMillis, zone)
  const endIso = localIsoOf(req.arriveByMillis + durationMinutes * 60_000, zone)

  let event = syntheticEvent({ title, startIso, endIso, location: destination.address })
  let calendarEventId: string | null = null
  let calendarNote: string | null = null
  if (hasGoogle(device.deviceId)) {
    try {
      const created = await createCalendarEvent(device.deviceId, {
        title,
        startIso,
        endIso,
        location: destination.address,
        // Otto has already arranged a get-ready nudge, a leaving-soon nudge and a leave-now alarm.
        // Calendar's own default popup would be a fourth notification from a producer this server
        // cannot see or coordinate with.
        suppressDefaultReminders: true,
      })
      calendarEventId = created.id
      event = (await getCalendarEvent(device.deviceId, created.id)) ?? { ...event, id: created.id }
    } catch (err) {
      log.warn({ err, deviceId: device.deviceId }, 'journey: could not write the calendar entry')
      calendarNote = 'the calendar entry could not be written, so this is not on their calendar'
    }
  } else {
    calendarNote = 'Google is not connected, so this is not on their calendar'
  }

  // 5. Price it and arm it. `explicit: true` because they asked — that clears 'estimated',
  //    'quiet-hours' and 'double-booked', exactly as create_leave_by_alarm does. It does NOT clear
  //    'place-guessed', which is structural: consent to an alarm is not consent to an alarm for
  //    somewhere they never named.
  const plan = await planLeaveBy({
    device,
    event,
    events,
    originAddress,
    destinationPlaceId: destination.placeId,
    destinationLatLng: destination.latLng,
    destinationConfirmed: destination.confirmed,
    travelMode: req.travelMode ?? null,
    getReadyMinutes: req.getReadyMinutes,
    alsoWakeMe: req.alsoWakeMe,
    explicit: true,
    now,
  })

  // 6. Something to mark done. `ring: false` and no escalation are rules, not defaults: the
  //    leave-now alarm IS the ring, and a reminder that armed its own would be the second object for
  //    one thing that ALARMS_VS_REMINDERS forbids. Escalation would arm a THIRD alarm on a path
  //    exempt from both the daily budget and quiet hours.
  const getReadyMinutes = plan.getReadyMinutes
  const ringingAt = [plan.leaveAtMillis, plan.wakeAtMillis].filter((at): at is number => at !== null)
  const leadMinutes = journeyLeadMinutes({
    dueAtMillis: req.arriveByMillis,
    travelMinutes: plan.travelMinutes ?? settings.defaultTravelMinutes,
    getReadyMinutes,
    ringingAt,
  })
  // Through the same repair the model's own plans go through, so a journey's schedule can never be
  // a shape `nextNagAt` has not seen.
  const normalised = normaliseOffsets('leadMinutes', leadMinutes, 'lead')

  const reminder = await createReminder(device, {
    title,
    detail: journeyDetail(destination, plan),
    dueAtMillis: req.arriveByMillis,
    timing: 'appointment',
    nagPolicy: 'persistent',
    // An empty chase array is the owner's choice: nothing follows them once they should be there.
    // `planRungs` reads it as maxChases 0, so the ladder ends after the leads and the reminder sits
    // as a thing they can mark done rather than a thing that keeps asking.
    nagPlan: { leadMinutes: normalised.ok ? normalised.minutes : leadMinutes, chaseMinutes: [] },
    ring: false,
    escalateWithAlarm: false,
  })

  if (req.rememberPlaceAs) {
    rememberPlace({
      deviceId: device.deviceId,
      alias: req.rememberPlaceAs,
      label: destination.label,
      address: destination.address,
      googlePlaceId: destination.placeId,
      latLng: destination.latLng,
      nowMillis: now,
    })
  }

  log.info(
    { deviceId: device.deviceId, mode: plan.mode, armed: plan.armed, blocked: plan.blocked, reminderId: reminder.reminderId },
    'journey planned',
  )

  return {
    kind: 'planned',
    journey: {
      destination,
      mode: plan.mode,
      travelMinutes: plan.travelMinutes ?? settings.defaultTravelMinutes,
      estimated: plan.estimated,
      noRoute: plan.noRoute,
      calendarEventId,
      calendarNote,
      plan,
      reminderId: reminder.reminderId,
      leadMinutes: normalised.ok ? normalised.minutes : leadMinutes,
    },
  }
}

/**
 * The one line every nudge about this journey repeats. Where, how, and roughly how long.
 *
 * The journey time, not the departure time. Transit slack is already inside the leave-by alarm and
 * saying so here would put an arithmetic footnote in front of the owner every single nudge.
 */
function journeyDetail(destination: ResolvedPlace, plan: LeaveByPlan): string {
  const mins = plan.travelMinutes
  return mins === null
    ? destination.address
    : `${destination.address} — ${plan.mode.toLowerCase()}, about ${mins} minutes`
}

/** Local wall-clock ISO for a journey time the model supplied, or null when it is unusable. */
export function journeyStartMillis(localIso: string, zone: string): number | null {
  const dt = DateTime.fromISO(localIso, { zone })
  return dt.isValid ? dt.toMillis() : null
}
