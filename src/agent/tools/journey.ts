import type { Device } from '../../services/devices.js'
import { planJourney, type PlannedJourney } from '../../services/journey.js'
import type { TravelMode } from '../../services/travel.js'
import { epochMillisToLocalHuman, localIsoToEpochMillis } from '../../services/time.js'
import type { ToolDef } from './types.js'

/**
 * Planning a journey to somewhere that is not on the calendar yet.
 *
 * Deliberately a SECOND tool alongside create_leave_by_alarm rather than a merge, and the split is
 * by INPUT, not by behaviour: that one is given an event that already exists and reads it, this one
 * is given a place and a time and creates everything. That is a distinction the model can make from
 * the owner's sentence. Merging them into one tool with an optional eventDescription would make it
 * guess between searching and creating, and the failure mode of guessing wrong is a DUPLICATE
 * calendar event for a meeting that already exists — irreversible from the owner's side, and exactly
 * what `matchEvents` refuses to risk by asking instead.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const journeyTools: ToolDef[] = [
  {
    name: 'plan_journey',
    description:
      'They told you they are going somewhere at a particular time and it is NOT on their calendar ' +
      'yet — "I\'m going to the dentist at 3", "heading to Mum\'s Saturday lunchtime". Looks the ' +
      'place up, puts it on their calendar, works out how long it takes to get there, arms a "leave ' +
      'now" alarm and leaves a reminder they can mark done. If the thing is ALREADY on their ' +
      'calendar, use create_leave_by_alarm instead — this one would create a duplicate. Returns ' +
      'ambiguous if several places match: ask which one they mean and list them, never pick. ' +
      'Public transport is assumed unless it is a short walk; pass travelMode only if they said.',
    parameters: {
      type: 'object',
      properties: {
        destination: {
          type: 'string',
          description: 'Where they are going, in their words: "the dentist", "Wembley Stadium", or a full address.',
        },
        arriveByLocalISO: {
          type: 'string',
          description: 'Local wall-clock ISO with no offset — when they need to BE there.',
        },
        title: { type: 'string', description: 'What to call it on the calendar. Defaults to the place name.' },
        durationMinutes: { type: 'number', description: 'How long they will be there. Default 60.' },
        origin: {
          type: 'string',
          description: 'Where they are setting off from, if they said. Otherwise it is worked out.',
        },
        travelMode: {
          type: 'string',
          enum: ['DRIVE', 'TRANSIT', 'WALK', 'BICYCLE'],
          description: 'Only when they said how they are getting there. Otherwise leave it out.',
        },
        address: {
          type: 'string',
          description: 'The exact address from an earlier ambiguous list, once they have chosen. Skips the lookup.',
        },
        rememberAs: {
          type: 'string',
          description: 'Save the place under this name for next time, e.g. "the dentist". Not for home or work.',
        },
        alsoWakeMe: { type: 'boolean', description: 'Arm a second, earlier alarm to get up.' },
        getReadyMinutes: { type: 'number', description: 'Minutes between waking and leaving. Default 45.' },
      },
      required: ['destination', 'arriveByLocalISO'],
    },
  },
]

const GET_READY_MIN = 5
const GET_READY_MAX = 240
const MODES: readonly TravelMode[] = ['DRIVE', 'TRANSIT', 'WALK', 'BICYCLE']

/**
 * The model's view of a planned journey.
 *
 * No ids it cannot use and no millis it would have to do arithmetic on. `alarmId` and `reminderId`
 * ARE included because cancelling a journey means cancelling both, and there is no cancel_journey
 * tool — the prompt says so rather than the model discovering it.
 */
function journeyView(j: PlannedJourney, zone: string) {
  const local = (ms: number | null): string | null => (ms === null ? null : epochMillisToLocalHuman(ms, zone))
  return {
    destination: j.destination.address,
    knownAs: j.destination.source,
    mode: j.mode,
    travelMinutes: j.travelMinutes,
    // Only meaningful once a journey was actually costed, and omitted rather than defaulted so a
    // `true` never reads as "we guessed" about a plan that never got as far as guessing.
    estimated: j.estimated,
    walkMinutes: j.plan.walkMinutes ?? undefined,
    noRouteAtThatTime: j.noRoute ? true : undefined,
    startsAtLocal: local(j.plan.startMillis),
    leaveAtLocal: local(j.plan.leaveAtMillis),
    wakeAtLocal: local(j.plan.wakeAtMillis),
    onlyOneAlarmArmed: j.plan.mergedWithWake ? true : undefined,
    armed: j.plan.armed,
    alarmId: j.plan.armed ? (j.plan.alarmId ?? j.plan.wakeId) : undefined,
    reminderId: j.reminderId,
    onTheirCalendar: j.calendarEventId !== null,
    calendarNote: j.calendarNote ?? undefined,
    blocked: j.plan.blocked ?? undefined,
    note: j.plan.note,
  }
}

export async function createJourney(device: Device, a: Record<string, unknown>): Promise<unknown> {
  const zone = device.timezone
  const destinationQuery = String(a.destination ?? '').trim()
  if (destinationQuery.length === 0) return { error: 'plan_journey needs a destination' }

  let arriveByMillis: number
  try {
    arriveByMillis = localIsoToEpochMillis(String(a.arriveByLocalISO), zone)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid arriveByLocalISO' }
  }

  const rawGetReady = typeof a.getReadyMinutes === 'number' ? a.getReadyMinutes : undefined
  const rawMode = typeof a.travelMode === 'string' ? (a.travelMode.toUpperCase() as TravelMode) : null

  const outcome = await planJourney({
    device,
    destinationQuery,
    arriveByMillis,
    title: typeof a.title === 'string' ? a.title : null,
    durationMinutes: typeof a.durationMinutes === 'number' ? a.durationMinutes : null,
    originQuery: typeof a.origin === 'string' ? a.origin : null,
    address: typeof a.address === 'string' ? a.address : null,
    // An unrecognised mode is dropped rather than rejected: the rule is a better answer than an
    // error, and the model mis-spelling an enum should not cost the owner their journey.
    travelMode: rawMode && MODES.includes(rawMode) ? rawMode : null,
    rememberPlaceAs: typeof a.rememberAs === 'string' ? a.rememberAs : null,
    getReadyMinutes:
      rawGetReady === undefined ? undefined : Math.min(GET_READY_MAX, Math.max(GET_READY_MIN, Math.round(rawGetReady))),
    alsoWakeMe: typeof a.alsoWakeMe === 'boolean' ? a.alsoWakeMe : undefined,
  })

  if (outcome.kind === 'ambiguous') {
    return { ambiguous: outcome.candidates.map((c) => ({ name: c.label, address: c.address })) }
  }
  if (outcome.kind === 'unknown') return { error: outcome.note }
  return journeyView(outcome.journey, zone)
}
