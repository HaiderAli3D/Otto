// Owned by the LEAVE-BY / TRAVEL-TIME feature branch.
// Phase 0 seam: the scheduler already routes 'leave_by' here, so that branch fills in this file and
// never has to touch the switch in scheduler/loop.ts.
//
// No seeder: this is a per-EVENT chain, enqueued when a leave-by alarm is armed, not a standing
// per-device one. It has no first job to seed at boot.
import { log } from '../../lib/log.js'
import { cancelAlarm, getAlarm } from '../alarms.js'
import { getDevice } from '../devices.js'
import { describeMiss, requestLocation, shouldPull } from '../location.js'
import { enqueueAndTryFlush } from '../outbox.js'
import { tryListCalendarEvents } from '../google.js'
import type { Job } from '../jobs.js'
import { jobPayload } from '../jobs.js'
import {
  armLeaveByPlan,
  computeLeaveByPlan,
  eventKeyOf,
  localIsoOf,
  MAX_LOOKAHEAD_MS,
  TRAVEL_DRIFT_MINUTES,
  type LeaveByJobPayload,
} from '../leaveBy.js'
import type { JobOutcome } from './types.js'

/** An event that moved by less than this is the same event; anything more re-arms. */
const MOVED_MS = 60_000

/**
 * The id if the owner has not cancelled it, null if they have.
 *
 * `planView` hands the model the derived id and `cancel_alarm` takes it, so "cancel that" between
 * arming and this recheck is an ordinary thing to happen. Cancelling an alarm drops the recheck job
 * anchored on it — but a plan can arm two alarms and only one of them is the anchor, so a
 * half-cancel still arrives here. Re-arming a CANCELLED id would take the row back to ARMED and
 * ring the phone for a journey they explicitly called off. A cancelled alarm is a decision, not a
 * stale row.
 */
function liveId(id: string | null): string | null {
  if (id === null) return null
  return getAlarm(id)?.state === 'CANCELLED' ? null : id
}

/**
 * The single recheck, 45 minutes before departure: is this journey still the journey we armed?
 *
 * Three outcomes, and the asymmetry between them is deliberate.
 *
 * - The calendar is UNREACHABLE: leave the alarm exactly as it is and end the chain. A stale
 *   "leave now" is a mild annoyance; cancelling a real departure because Google had a bad minute is
 *   the owner missing the thing. Never let an outage cancel an alarm.
 * - The event is GONE or cancelled: cancel. This is the one case we know something for certain.
 * - It moved, or traffic did, by enough to matter: re-arm with the SAME derived alarm id, so the
 *   upsert replaces the row, the watchdog, and the phone's copy. A duplicate is not merely avoided
 *   here, it is unrepresentable.
 *
 * One recheck is enough — always returns null. A chain that re-armed and re-scheduled itself would
 * poll traffic every minute right up to departure, and the answer it is looking for is one that
 * either already happened or is not going to.
 */
export async function runLeaveBy(job: Job): Promise<JobOutcome> {
  const payload = jobPayload<LeaveByJobPayload>(job)
  if (!payload || !job.deviceId) {
    log.warn({ jobId: job.id }, 'leave_by: job carries no usable payload; dropping')
    return null
  }
  const device = getDevice(job.deviceId)
  if (!device) return null
  const zone = device.timezone
  const now = Date.now()

  // Ask what this job may still touch BEFORE spending a calendar read and a billed Routes call on
  // it: an owner who cancelled both alarms has already answered every question this job asks.
  const alarmId = liveId(payload.alarmId)
  const wakeId = liveId(payload.wakeId)
  if (alarmId === null && wakeId === null) {
    log.info({ jobId: job.id, eventId: payload.eventId }, 'leave_by: alarms already cancelled; nothing to recheck')
    return null
  }

  // Search from now to well past the original start: the whole reason this job exists is that the
  // event may have MOVED, and a window pinned to where it used to be would report it deleted.
  const events = await tryListCalendarEvents(
    device.deviceId,
    localIsoOf(now, zone),
    localIsoOf(Math.max(payload.eventStartMillis, now) + MAX_LOOKAHEAD_MS, zone),
  )
  if (events === null) {
    log.warn({ jobId: job.id, deviceId: device.deviceId }, 'leave_by: calendar unreachable; leaving the alarm alone')
    return null
  }

  const event = events.find((e) => eventKeyOf(e) === payload.eventId)
  if (!event || event.status === 'cancelled') {
    if (alarmId) await cancelAlarm(device, alarmId)
    if (wakeId) await cancelAlarm(device, wakeId)
    log.info({ jobId: job.id, eventId: payload.eventId }, 'leave_by: event gone or cancelled; alarms cancelled')
    return null
  }

  // Where are they NOW?
  //
  // This is the only place in the system that asks, and the placement is the whole reason the answer
  // is worth having. The tempting spot was the conversational turn — the owner says "I'm going to
  // the dentist at 3" and Otto asks the phone. But at 09:00, where they are says nothing about where
  // they will be at 14:20, and the pull would have blocked the reply for up to forty-five seconds to
  // learn something irrelevant. Here, forty-five minutes before departure, "where are you" is
  // finally predictive — and this is a job handler, so nobody is waiting on it.
  //
  // Only ever an IMPROVEMENT on the ladder: a miss leaves `originAddress` exactly as it was.
  const pullFrom = payload.originAddress
  let locationNote: string | null = null
  let originLatLng = null as { lat: number; lng: number } | null
  if (
    shouldPull({
      device,
      leaveAtMillis: payload.eventStartMillis - payload.travelMinutes * 60_000,
      // The payload's origin came from `resolveOrigin`, and a preceding calendar event is a BETTER
      // answer than a live fix — it is where they will be, not where they are. We cannot tell the
      // two apart from the payload alone, so `medium` is assumed and the gain is only ever real
      // when the ladder had nothing better.
      originConfidence: pullFrom === null ? null : 'medium',
      explicitOrigin: false,
      nowMillis: now,
    })
  ) {
    const outcome = await requestLocation(device, {
      reason: `work out when to leave for ${payload.summary}`,
      nowMillis: now,
    })
    if ('fix' in outcome) {
      originLatLng = outcome.fix.latLng
    } else {
      locationNote = describeMiss(outcome.miss, pullFrom === null ? 'their usual starting point' : 'their saved address')
    }
  }
  if (locationNote) log.debug({ jobId: job.id, note: locationNote }, 'leave_by: planning without a live fix')

  const plan = await computeLeaveByPlan({
    device,
    event,
    events,
    // A live fix wins over the ladder's guess, and enters through the SAME door the owner's own
    // stated origin uses — `resolveOrigin` stays pure, synchronous and untouched, which is the
    // single most important regression-avoidance decision on this side.
    originLatLng,
    originAddress: payload.originAddress,
    // Carried so the recheck asks about the SAME journey. Without the mode a walk gets re-priced as
    // transit and the departure moves for no reason the owner could explain; without the place id
    // the destination is re-geocoded from prose and can land on a different branch of the chain.
    // `mode` is undefined on rows enqueued before the field existed — that reprices by the rule,
    // which is the correct new behaviour arriving one recheck late.
    travelMode: payload.mode ?? null,
    destinationPlaceId: payload.destinationPlaceId ?? null,
    getReadyMinutes: payload.getReadyMinutes,
    alsoWakeMe: payload.wantWake,
    now,
  })

  // The event stopped being a journey at all — it went all-day, lost its location, or turned into a
  // video call. An alarm that says "leave now" for something you no longer leave for is wrong in a
  // way a stale time is not, so this one does cancel.
  if (plan.leaveAtMillis === null || plan.travelMinutes === null) {
    if (alarmId) await cancelAlarm(device, alarmId)
    if (wakeId) await cancelAlarm(device, wakeId)
    log.info({ jobId: job.id, blocked: plan.blocked }, 'leave_by: no journey any more; alarms cancelled')
    return null
  }

  // `blocked: 'past'` reaches here as three different situations, and only ONE of them may cancel.
  //
  // (a) The event moved EARLIER. The alarm is still sitting in the future and, when it rings, will
  //     announce a departure for a meeting that already started. That is not a stale time, it is a
  //     false one, and the owner acts on it. This one cancels.
  //
  // (b) The departure is simply IMMINENT. `computeLeaveByPlan` returns 'past' for anything inside
  //     LEAVE_SOON_MS, not only for what has gone — and a plan armed close to its departure
  //     schedules this recheck at now+60s, because leaveAt − RECHECK_LEAD_MS is already behind. So
  //     an alarm the owner explicitly asked for arrives here a minute after arming, five minutes
  //     from a departure that is entirely correct.
  //
  // (c) The recheck is running late after a restart or a backlog. The armed alarm IS the departure,
  //     ringing about now.
  //
  // In (b) and (c) nothing is wrong: time passed. Cancelling there is the precise failure this
  // feature must never produce — a real departure, silently unarmed, sixty seconds after the owner
  // asked for it. So the gate is whether the EVENT MOVED, not whether the clock advanced. A grown
  // travel estimate is deliberately not a reason either: ringing slightly late still gets them out
  // of the door, and silence does not.
  if (plan.blocked === 'past') {
    const movedEarlier = plan.startMillis !== null && payload.eventStartMillis - plan.startMillis >= MOVED_MS
    if (!movedEarlier) {
      log.info(
        { jobId: job.id, eventId: payload.eventId },
        'leave_by: departure is imminent but the event has not moved; leaving the alarm to ring',
      )
      return null
    }
    for (const id of [alarmId, wakeId]) {
      if (id === null) continue
      const armed = getAlarm(id)
      // An alarm at or behind `now` is the ring itself and is left strictly alone; only one still
      // ahead of a departure that has already gone can be announcing something false.
      if (armed?.state === 'ARMED' && armed.triggerAtMillis > now) await cancelAlarm(device, id)
    }
    log.info({ jobId: job.id, eventId: payload.eventId }, 'leave_by: event moved earlier; cancelled anything still ahead')
    return null
  }

  const moved = Math.abs(plan.startMillis! - payload.eventStartMillis)
  const drift = Math.abs(plan.travelMinutes - payload.travelMinutes)
  // A changed MODE always re-arms, whatever the drift. A five-minute threshold is a statement about
  // the same journey taking a little longer; it means nothing once walking has become transit, and
  // the two can easily differ by less than five minutes while leaving at completely different times
  // — or by a great deal while the threshold was never consulted.
  const modeChanged = payload.mode !== undefined && plan.mode !== payload.mode
  if (!modeChanged && moved < MOVED_MS && drift <= TRAVEL_DRIFT_MINUTES) return null

  // The ids come from the PAYLOAD, not from the fresh plan: an event that moved across midnight
  // derives a different day key, and re-arming under a new id would leave the old alarm armed
  // alongside it. Same id, one row, one alarm.
  //
  // `staleIds` is emptied for exactly that reason. The fresh plan's stale list is derived from the
  // fresh day key, so it names ids that either never existed or — worse, on the same day — name the
  // very id being re-armed here, and armLeaveByPlan would arm it and then cancel it. The pinned
  // pair IS the set of alarms this chain owns; there is no third one to retire.
  const previousLeaveAt = payload.eventStartMillis - payload.travelMinutes * 60_000
  await armLeaveByPlan(device, { ...plan, alarmId, wakeId, staleIds: [] }, { scheduleRecheck: false, now })
  log.info({ jobId: job.id, moved, drift, modeChanged, mode: plan.mode }, 'leave_by: re-armed after a change')

  // A re-arm this large is not a correction, it is different information — and until now it happened
  // in silence. A live fix discovered at the recheck can legitimately move a departure by an hour
  // (they are at the office, not at home), leaving the owner's mental model and the armed alarm
  // disagreeing with nothing to reconcile them.
  //
  // Only for a MOVE, and only a big one. An alarm quietly shifting four minutes needs no announcement
  // and would train them to ignore the ones that matter.
  const shift = plan.leaveAtMillis === null ? 0 : Math.abs(plan.leaveAtMillis - previousLeaveAt)
  if (shift > TELL_THEM_MS && device.whatsappNumber && plan.leaveAtMillis !== null) {
    const earlier = plan.leaveAtMillis < previousLeaveAt
    await enqueueAndTryFlush({
      waUserId: device.whatsappNumber,
      deviceId: device.deviceId,
      kind: 'nudge',
      body:
        `Change of plan for ${payload.summary} — you now need to leave at ` +
        `${hhmm(plan.leaveAtMillis, device.timezone)}, ${earlier ? 'earlier' : 'later'} than I said. ` +
        `${plan.travelMinutes} minutes by ${plan.mode.toLowerCase()}. The alarm has moved.`,
      dedupeKey: `leaveby-moved:${alarmId ?? wakeId}:${plan.leaveAtMillis}`,
    })
  }
  return null
}

/**
 * How far a departure may move at the recheck before the owner is told.
 *
 * Fifteen minutes is the line between "traffic" and "different plan". Below it the alarm simply
 * rings when it rings; above it they are holding a time in their head that is no longer true.
 */
const TELL_THEM_MS = 15 * 60_000

const hhmm = (ms: number, zone: string): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone, hour12: false }).format(ms)
