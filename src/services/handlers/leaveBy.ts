// Owned by the LEAVE-BY / TRAVEL-TIME feature branch.
// Phase 0 seam: the scheduler already routes 'leave_by' here, so that branch fills in this file and
// never has to touch the switch in scheduler/loop.ts.
//
// No seeder: this is a per-EVENT chain, enqueued when a leave-by alarm is armed, not a standing
// per-device one. It has no first job to seed at boot.
import { log } from '../../lib/log.js'
import { cancelAlarm } from '../alarms.js'
import { getDevice } from '../devices.js'
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
    if (payload.alarmId) await cancelAlarm(device, payload.alarmId)
    if (payload.wakeId) await cancelAlarm(device, payload.wakeId)
    log.info({ jobId: job.id, eventId: payload.eventId }, 'leave_by: event gone or cancelled; alarms cancelled')
    return null
  }

  const plan = await computeLeaveByPlan({
    device,
    event,
    events,
    originAddress: payload.originAddress,
    getReadyMinutes: payload.getReadyMinutes,
    alsoWakeMe: payload.wantWake,
    now,
  })

  // The event stopped being a journey at all — it went all-day, lost its location, or turned into a
  // video call. An alarm that says "leave now" for something you no longer leave for is wrong in a
  // way a stale time is not, so this one does cancel.
  if (plan.leaveAtMillis === null || plan.travelMinutes === null) {
    if (payload.alarmId) await cancelAlarm(device, payload.alarmId)
    if (payload.wakeId) await cancelAlarm(device, payload.wakeId)
    log.info({ jobId: job.id, blocked: plan.blocked }, 'leave_by: no journey any more; alarms cancelled')
    return null
  }
  // Already past the departure by the time we looked. Re-arming into the past achieves nothing and
  // the armed alarm is either ringing or spent; leave it.
  if (plan.blocked === 'past') return null

  const moved = Math.abs(plan.startMillis! - payload.eventStartMillis)
  const drift = Math.abs(plan.travelMinutes - payload.travelMinutes)
  if (moved < MOVED_MS && drift <= TRAVEL_DRIFT_MINUTES) return null

  // The ids come from the PAYLOAD, not from the fresh plan: an event that moved across midnight
  // derives a different day key, and re-arming under a new id would leave the old alarm armed
  // alongside it. Same id, one row, one alarm.
  await armLeaveByPlan(
    device,
    { ...plan, alarmId: payload.alarmId, wakeId: payload.wakeId },
    { scheduleRecheck: false, now },
  )
  log.info({ jobId: job.id, moved, drift }, 'leave_by: re-armed after a change')
  return null
}
