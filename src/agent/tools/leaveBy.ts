import type { ToolDef } from './types.js'
import type { Device } from '../../services/devices.js'
import { hasGoogle, tryListCalendarEvents, type CalendarEvent } from '../../services/google.js'
import {
  eventStartMillis,
  localIsoOf,
  matchEvents,
  MAX_LOOKAHEAD_MS,
  planLeaveBy,
  type LeaveByPlan,
} from '../../services/leaveBy.js'
import { epochMillisToLocalHuman, localIsoToEpochMillis } from '../../services/time.js'

/**
 * Leave-by / travel-time alarms.
 *
 * Present whether or not Google or Maps is connected, like every other integration tool: the tool
 * block renders at position 0 of the prompt and a list that changed shape per device would throw
 * that device's prompt cache away on every single request. Both "not connected" answers are
 * returned at CALL time instead — see the contract in ./index.ts.
 *
 * A literal array, never a function.
 */
export const leaveByTools: ToolDef[] = [
  {
    name: 'create_leave_by_alarm',
    description:
      'Work out when the owner has to LEAVE for a calendar event, and arm an alarm for that ' +
      'moment. Use it whenever they ask to be told, warned or woken in time to get somewhere — ' +
      '"make sure I leave for the dentist", "wake me in time for the 9am". The event must already ' +
      'be on their calendar; this reads it, works out the journey and sets the alarm. It does NOT ' +
      'create the event. Returns leaveAtLocal and estimated: if estimated is true the travel time ' +
      'is a fallback rather than live traffic, and you must say so. If it returns ambiguous, ask ' +
      'which one they mean rather than picking.',
    parameters: {
      type: 'object',
      properties: {
        eventDescription: {
          type: 'string',
          description: 'What they called it, matched against event titles in the next 36 hours.',
        },
        eventStartLocalISO: {
          type: 'string',
          description: 'Local wall-clock ISO with no offset, when they said when it is. Narrows a tie.',
        },
        originAddress: {
          type: 'string',
          description: 'Where they are setting off from, if they said. Otherwise it is worked out.',
        },
        alsoWakeMe: { type: 'boolean', description: 'Arm a second, earlier alarm to get up.' },
        getReadyMinutes: { type: 'number', description: 'Minutes between waking and leaving. Default 45.' },
      },
      required: ['eventDescription'],
    },
  },
]

/** Cap on how many events come back in an error/ambiguity list — this is prompt budget. */
const CANDIDATE_LIMIT = 8

const GET_READY_MIN = 5
const GET_READY_MAX = 240

function eventView(e: CalendarEvent, zone: string) {
  const start = eventStartMillis(e, zone)
  return {
    summary: e.summary,
    startsAtLocal: start === null ? null : epochMillisToLocalHuman(start, zone),
    location: e.location,
  }
}

/**
 * The model's view of a plan. Deliberately no ids it cannot use and no millis it would have to do
 * arithmetic on — everything that matters is already a local time or a boolean.
 */
function planView(plan: LeaveByPlan, zone: string) {
  const local = (ms: number | null): string | null => (ms === null ? null : epochMillisToLocalHuman(ms, zone))
  return {
    event: plan.summary,
    startsAtLocal: local(plan.startMillis),
    destination: plan.destination,
    from: plan.origin?.address ?? null,
    originConfidence: plan.origin?.confidence ?? null,
    travelMinutes: plan.travelMinutes,
    // Only meaningful once a journey was actually costed; omitted rather than defaulted to true,
    // which would read as "we guessed" about a plan that never got as far as guessing.
    estimated: plan.travelMinutes === null ? undefined : plan.estimated,
    leaveAtLocal: local(plan.leaveAtMillis),
    wakeAtLocal: local(plan.wakeAtMillis),
    onlyOneAlarmArmed: plan.mergedWithWake ? true : undefined,
    armed: plan.armed,
    alarmId: plan.armed ? (plan.alarmId ?? plan.wakeId) : undefined,
    blocked: plan.blocked ?? undefined,
    note: plan.note,
  }
}

/**
 * Resolve the event they meant, then plan and arm.
 *
 * Zero matches returns candidates and two or more returns `ambiguous` rather than picking — the
 * same discipline the prompt already enforces for completing reminders, and for the same reason:
 * confidently arming an alarm for the wrong meeting is worse than one extra question.
 *
 * This is `explicit`, so it arms even when the travel time is only an estimate or the departure
 * falls in quiet hours. They asked; asking is consent. Proactive planning has the opposite default.
 */
export async function createLeaveByAlarm(device: Device, a: Record<string, unknown>): Promise<unknown> {
  if (!hasGoogle(device.deviceId)) return { error: 'calendar not connected' }
  const zone = device.timezone
  const now = Date.now()

  const events = await tryListCalendarEvents(device.deviceId, localIsoOf(now, zone), localIsoOf(now + MAX_LOOKAHEAD_MS, zone))
  if (events === null) return { error: 'calendar unreachable right now — say so and offer to try again' }

  let startMillis: number | null = null
  if (a.eventStartLocalISO !== undefined) {
    try {
      startMillis = localIsoToEpochMillis(String(a.eventStartLocalISO), zone)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'invalid eventStartLocalISO' }
    }
  }

  const description = String(a.eventDescription ?? '')
  const matches = matchEvents(events, description, startMillis, zone)
  if (matches.length === 0) {
    return {
      error: `no event matching "${description}" in the next 36 hours`,
      candidates: events
        .filter((e) => !e.isAllDay && e.status !== 'cancelled')
        .slice(0, CANDIDATE_LIMIT)
        .map((e) => eventView(e, zone)),
    }
  }
  if (matches.length > 1) {
    return { ambiguous: matches.slice(0, CANDIDATE_LIMIT).map((e) => eventView(e, zone)) }
  }

  const rawGetReady = typeof a.getReadyMinutes === 'number' ? a.getReadyMinutes : undefined
  const plan = await planLeaveBy({
    device,
    event: matches[0]!,
    events,
    originAddress: a.originAddress === undefined ? null : String(a.originAddress),
    getReadyMinutes:
      rawGetReady === undefined
        ? undefined
        : Math.min(GET_READY_MAX, Math.max(GET_READY_MIN, Math.round(rawGetReady))),
    alsoWakeMe: typeof a.alsoWakeMe === 'boolean' ? a.alsoWakeMe : undefined,
    explicit: true,
    now,
  })
  return planView(plan, zone)
}
