import { DateTime } from 'luxon'
import type { Device } from '../../services/devices.js'
import {
  CALENDAR_PAGE_SIZE,
  createCalendarEvent,
  deleteCalendarEvent,
  hasGoogle,
  NOT_ORGANISER,
  tryListCalendarEvents,
  updateCalendarEvent,
  type CalendarEvent,
} from '../../services/google.js'
import {
  eventKeyOf,
  localIsoOf,
  matchEvents,
  MAX_LOOKAHEAD_MS,
  overlapsWindow,
  releaseLeaveByFor,
} from '../../services/leaveBy.js'
import { schedulingRoutine } from '../../services/settings.js'
import { epochMillisToLocalHuman, localIsoToEpochMillis } from '../../services/time.js'
import { dayStartHour, dayStartMinute } from '../../lib/routine.js'
import type { ToolDef } from './types.js'

/**
 * Changing a calendar that already has something on it.
 *
 * Kept OUT of `googleTools` and spread LAST in `buildTools`, for the reason spelled out beside
 * `googleLinkTools`: `googleTools` is spread fourth, so adding to it pushes every tool after it down
 * the cached prompt prefix and bills every user a full-price turn at deploy. The end of the list
 * shifts nothing already in the prefix.
 *
 * Three tools rather than one `manage_calendar_event` with an action enum. `manage_places` is the
 * precedent for merging, but the argument that settled `plan_journey` vs `create_leave_by_alarm`
 * applies here and points the other way: split by INPUT, on a distinction the model can make
 * straight from the owner's sentence. "Get rid of the 3pm", "move the 3pm to 4" and "plan my day"
 * are three different sentences, and this is a low-effort model choosing between twenty-seven tools.
 *
 * None of the three takes a raw Google id as its only handle on an event. `eventId` is accepted but
 * always re-resolved against a fresh listing, because `calendarEventView` hands the model
 * `eventKeyOf(e)`, which falls back to the SUMMARY when Google gave no id. An id-trusting delete
 * tool would eventually be handed a title, send it to `events.delete`, take the 404 for "already
 * gone", and tell the owner a meeting was cancelled that is still sitting on their calendar.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const calendarEditTools: ToolDef[] = [
  {
    name: 'delete_calendar_event',
    description:
      'Take one event off their Google Calendar — "cancel my 3pm", "get rid of the dentist thing", ' +
      '"that meeting is off". Name it the way they did; you do not need an id. Pass ' +
      'eventStartLocalISO whenever they said which day, because without one only the next 36 hours ' +
      'are searched. If exactly one event matches, it is deleted and named back to you — do that ' +
      'rather than asking permission first. If two or more could match it comes back ambiguous: ' +
      'list them and ask which, never pick. This cannot be undone from their side, so the whole ' +
      'event is handed back to you and you can put it straight back with create_calendar_event if ' +
      'they say you got the wrong one. It removes ONE occurrence of a repeating event unless you ' +
      'pass scope "series". Nobody else on the event is emailed.',
    parameters: {
      type: 'object',
      properties: {
        eventDescription: {
          type: 'string',
          description: 'What they called it, matched against the event titles in the window.',
        },
        eventStartLocalISO: {
          type: 'string',
          description:
            'Local wall-clock ISO with no offset, for when they said it is. This picks the DAY that ' +
            'gets searched, and settles a tie between two events with similar names.',
        },
        eventId: {
          type: 'string',
          description: 'From list_calendar_events, when you have one. It is still checked against the calendar.',
        },
        scope: {
          type: 'string',
          enum: ['this', 'series'],
          description:
            'Only for a repeating event. "this" cancels that one day, "series" cancels every ' +
            'occurrence including the ones already past. Ask which they mean rather than guessing.',
        },
      },
      required: ['eventDescription'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Change something already on their Google Calendar — "push the dentist to Thursday at 4", ' +
      '"call it a review, not a catch-up", "it is at the Ship now". Same matching as ' +
      'delete_calendar_event: name it the way they did, pass eventStartLocalISO when they said the ' +
      'day, and if it comes back ambiguous ask which rather than picking. Moving the start moves the ' +
      'end with it so the meeting keeps its length — pass newEndLocalISO too only if they said it ' +
      'runs differently now. Confirm with the times that come back, not the ones you asked for. ' +
      'Changing a repeating event changes that one occurrence, never the series.',
    parameters: {
      type: 'object',
      properties: {
        eventDescription: { type: 'string', description: 'What they called it.' },
        eventStartLocalISO: {
          type: 'string',
          description: 'Local wall-clock ISO with no offset, for when it is NOW. Picks the day that gets searched.',
        },
        eventId: { type: 'string', description: 'From list_calendar_events, when you have one.' },
        newTitle: { type: 'string', description: 'What it should be called instead.' },
        newStartLocalISO: {
          type: 'string',
          description: 'The new start, local wall-clock with no offset. The end moves with it and the length is kept.',
        },
        newEndLocalISO: {
          type: 'string',
          description: 'The new end. Pass on its own to change only how long it runs.',
        },
        newLocation: {
          type: 'string',
          description:
            'Where it is now. A full address if you have one — that is what travel time is worked ' +
            'out from, and an event without one can never get a leave-by alarm.',
        },
      },
      required: ['eventDescription'],
    },
  },
  {
    name: 'plan_day',
    description:
      'Put a whole set of time-blocks on their calendar in ONE call — "plan my day", "block out ' +
      'tomorrow morning for the report". Send every block in one call; never loop ' +
      'create_calendar_event. It re-reads the day itself and works AROUND what is already there: a ' +
      'block that would land on top of an existing event is refused rather than written, and comes ' +
      'back under skipped naming what got in the way. Their existing events are never moved, ' +
      'shortened or written over. None of these blocks ring or chase — they are the shape of the ' +
      'day, not alarms; if they want telling when one starts that is create_alarm as well. If ' +
      'allWritten comes back false then some blocks are NOT on their calendar: say exactly which ' +
      'and why, and do not call the day planned.',
    parameters: {
      type: 'object',
      properties: {
        blocks: {
          type: 'array',
          description: 'Every block for the day, in one call. Twelve at most, and they must not overlap each other.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'What the block is for, in their words: "deep work on the deck".' },
              startLocalISO: { type: 'string', description: 'Local wall-clock ISO with no offset.' },
              endLocalISO: { type: 'string', description: 'Local wall-clock ISO with no offset.' },
              location: { type: 'string', description: 'Only if the block happens somewhere — the gym, the office.' },
            },
            required: ['title', 'startLocalISO', 'endLocalISO'],
          },
        },
      },
      required: ['blocks'],
    },
  },
]

/** Cap on how many events come back in an error or ambiguity list — this is prompt budget. */
const CANDIDATE_LIMIT = 8

/**
 * Twelve blocks is a day, not a limit anyone reaches by accident — and it is twelve sequential
 * `events.insert` round-trips inside one turn, which is the real ceiling. Rejected rather than
 * truncated: a silently shortened day reported as planned is the exact failure this tool exists to
 * prevent.
 */
const MAX_BLOCKS = 12

/** Epoch millis of a Google ISO string (bare date or offset-bearing dateTime), or null. */
function isoMillis(iso: string, zone: string): number | null {
  const dt = DateTime.fromISO(iso, { zone })
  return dt.isValid ? dt.toMillis() : null
}

/**
 * The model's view of an event it might have meant.
 *
 * Carries `eventId`, unlike the candidate view `create_leave_by_alarm` uses. That tool re-matches on
 * the description next turn, so an id would be waste; here the follow-up IS "the second one", and it
 * has to land on exactly that event rather than run the same fuzzy match again and tie again.
 */
function candidateView(e: CalendarEvent, zone: string) {
  const start = isoMillis(e.startIso, zone)
  return {
    eventId: e.id,
    summary: e.summary,
    startsAtLocal: start === null ? null : epochMillisToLocalHuman(start, zone),
    location: e.location ?? undefined,
    allDay: e.isAllDay ? true : undefined,
  }
}

type Resolved = { event: CalendarEvent; events: CalendarEvent[]; zone: string }

/**
 * Which day gets searched.
 *
 * A supplied start means THAT local day, midnight to midnight: narrow enough that the matcher sees a
 * handful of candidates rather than a fortnight of them, and wide enough that the model's guess at
 * the hour ("your 3-ish thing") cannot miss. No start falls back to the same 36 hours
 * `create_leave_by_alarm` uses, so there is one default horizon in the system rather than two that
 * drift apart.
 *
 * Built with calendar arithmetic and never by adding 86,400,000ms: on the two days a year that
 * carry a DST change, that lands on the wrong date, which is how a delete tool ends up searching
 * yesterday.
 */
function searchWindow(startMillis: number | null, zone: string, now: number): { from: string; to: string } {
  if (startMillis === null) {
    return { from: localIsoOf(now, zone), to: localIsoOf(now + MAX_LOOKAHEAD_MS, zone) }
  }
  const day = DateTime.fromMillis(startMillis, { zone }).startOf('day')
  return { from: localIsoOf(day.toMillis(), zone), to: localIsoOf(day.plus({ days: 1 }).toMillis(), zone) }
}

/**
 * Work out which single event the owner meant, or say why that is not answerable yet.
 *
 * The ladder is `create_leave_by_alarm`'s, deliberately: zero matches returns candidates, two or
 * more returns `ambiguous`, and NEITHER picks. Confidently cancelling the wrong standup is worse
 * than one extra question, and unlike a wrongly-armed alarm it cannot be slept through and noticed
 * later.
 */
async function resolveOne(
  device: Device,
  a: Record<string, unknown>,
): Promise<{ ok: true; found: Resolved } | { ok: false; answer: unknown }> {
  const zone = device.timezone
  const now = Date.now()

  const description = typeof a.eventDescription === 'string' ? a.eventDescription.trim() : ''
  const eventId = typeof a.eventId === 'string' ? a.eventId.trim() : ''
  if (description === '' && eventId === '') {
    // Not a formality. `matchEvents` treats an empty needle as "everything in the window", which is
    // harmless for a tool that asks when it sees more than one — but on a day holding exactly one
    // event it is a single confident match, and a deletion nobody asked for.
    return { ok: false, answer: { error: 'say which event they mean — pass eventDescription in their words' } }
  }

  let startMillis: number | null = null
  if (a.eventStartLocalISO !== undefined) {
    try {
      startMillis = localIsoToEpochMillis(String(a.eventStartLocalISO), zone)
    } catch (err) {
      return { ok: false, answer: { error: err instanceof Error ? err.message : 'invalid eventStartLocalISO' } }
    }
  }

  const { from, to } = searchWindow(startMillis, zone, now)
  const events = await tryListCalendarEvents(device.deviceId, from, to)
  if (events === null) {
    return { ok: false, answer: { error: 'calendar unreachable right now — say so and offer to try again' } }
  }

  // A full page means there was probably more, and there is deliberately no pagination. Reporting
  // "you have no dentist appointment" off a window we could only half see is worse than admitting
  // the window was too crowded to answer from.
  const truncated = events.length >= CALENDAR_PAGE_SIZE

  const byId = eventId === '' ? undefined : events.find((e) => e.id === eventId)
  if (eventId !== '' && byId === undefined) {
    return {
      ok: false,
      answer: {
        error: `nothing with id ${eventId} is on their calendar in that window`,
        hint: 'call list_calendar_events for the day they mean and use the eventId from that, or pass eventStartLocalISO',
      },
    }
  }

  const matches = byId !== undefined ? [byId] : matchEvents(events, description, startMillis, zone)

  if (matches.length === 0) {
    return {
      ok: false,
      answer: {
        error: truncated
          ? `their calendar is too full in that window to be sure — nothing obviously matching "${description}" was visible`
          : `no event matching "${description}"${startMillis === null ? ' in the next 36 hours' : ' on that day'}`,
        hint:
          startMillis === null
            ? 'if it is further off than tomorrow, pass eventStartLocalISO for the day it is on'
            : 'check the day with list_calendar_events before telling them it does not exist',
        candidates: events.filter((e) => e.status !== 'cancelled').slice(0, CANDIDATE_LIMIT).map((e) => candidateView(e, zone)),
      },
    }
  }
  if (matches.length > 1) {
    return { ok: false, answer: { ambiguous: matches.slice(0, CANDIDATE_LIMIT).map((e) => candidateView(e, zone)) } }
  }

  const event = matches[0]!
  if (event.id === '') {
    // `eventKeyOf` falls back to the summary when Google gave no id, and `matchEvents` is happy to
    // hand such a row back. Sending a title to events.delete earns a 404, which this code would
    // read as "it was already gone" — so Otto would cheerfully report a meeting cancelled that is
    // still there. Refuse instead. Never fall back to the summary.
    return { ok: false, answer: { error: 'Google has no id for that event, so nothing can be changed or removed by it' } }
  }
  return { ok: true, found: { event, events, zone } }
}

/** Google's own generated entries — birthdays, out-of-office, focus time — are not ours to edit. */
function refuseGeneratedEntry(event: CalendarEvent): { error: string } | null {
  if (event.eventType === null || event.eventType === 'default') return null
  return {
    error:
      `"${event.summary}" is a ${event.eventType} entry that Google generates rather than an ordinary ` +
      'event, so it cannot be changed or removed from here — that has to be done in Google Calendar itself',
  }
}

export async function deleteCalendarEventTool(device: Device, a: Record<string, unknown>): Promise<unknown> {
  if (!hasGoogle(device.deviceId)) return { error: 'calendar not connected' }
  const resolved = await resolveOne(device, a)
  if (!resolved.ok) return resolved.answer
  const { event, zone } = resolved.found

  const generated = refuseGeneratedEntry(event)
  if (generated) return generated

  const scope = a.scope === 'series' ? 'series' : a.scope === 'this' ? 'this' : null
  if (event.recurringEventId !== null && scope === null) {
    // The one ambiguity the owner's words genuinely do not settle. "Cancel my standup" is as likely
    // to mean today's as all of them, and the two are not equally recoverable: one occurrence can be
    // put back with create_calendar_event, a deleted series cannot be put back at all.
    return {
      needsScope: true,
      summary: event.summary,
      startsAtLocal: epochMillisToLocalHuman(isoMillis(event.startIso, zone) ?? Date.now(), zone),
      question: 'that one repeats — ask whether they mean just this occurrence or the whole series, then call again with scope',
    }
  }

  const targetId = scope === 'series' ? (event.recurringEventId ?? event.id) : event.id
  const startMillis = isoMillis(event.startIso, zone)

  let gone: boolean
  try {
    gone = await deleteCalendarEvent(device.deviceId, targetId)
  } catch (err) {
    if (err instanceof Error && err.message === NOT_ORGANISER) {
      return {
        error: `"${event.summary}" belongs to whoever organised it — it cannot be cancelled from here, only declined or removed in Google Calendar`,
      }
    }
    throw err
  }

  // Retire the ringer BEFORE reporting success. An event can be deleted after its single recheck has
  // already run, and nothing else would ever look again — the phone would ring at full volume to
  // send them somewhere they are no longer going.
  const alarms = startMillis === null ? [] : await releaseLeaveByFor(device, eventKeyOf(event), startMillis)

  if (!gone) {
    return {
      deleted: false,
      alreadyGone: true,
      summary: event.summary,
      note: 'Google no longer had that event — it was already off their calendar, so say that rather than saying you cancelled it',
    }
  }

  return {
    deleted: true,
    summary: event.summary,
    startedLocal: startMillis === null ? null : epochMillisToLocalHuman(startMillis, zone),
    // The whole event, handed back, because there is no undelete in the Calendar API and this is the
    // cheapest thing that turns an irreversible action into a recoverable one: "no, not that one" is
    // answerable next turn with a create_calendar_event that has every field it needs.
    restoreWith:
      scope === 'series'
        ? undefined
        : {
            title: event.summary,
            startLocalISO: event.startIso,
            endLocalISO: event.endIso,
            location: event.location ?? undefined,
          },
    seriesDeleted: scope === 'series' ? true : undefined,
    occurrenceOnly: event.recurringEventId !== null && scope !== 'series' ? true : undefined,
    leaveByAlarmsCancelled: alarms.length > 0 ? alarms.length : undefined,
    otherPeopleOnIt: event.attendeeCount > 1 ? true : undefined,
    note:
      event.attendeeCount > 1
        ? 'other people were on that one and it has come off their calendars too — nobody was emailed, so tell them they may want to message the others'
        : undefined,
  }
}

export async function updateCalendarEventTool(device: Device, a: Record<string, unknown>): Promise<unknown> {
  if (!hasGoogle(device.deviceId)) return { error: 'calendar not connected' }

  const newTitle = typeof a.newTitle === 'string' && a.newTitle.trim() !== '' ? a.newTitle.trim() : undefined
  // A blank location is treated as absent, never as "clear it" — the same call `manage_places` makes
  // about an address. An event with no location can never get a leave-by alarm, so a model emitting
  // '' for "unchanged" would quietly break the feature that reads it.
  const newLocation = typeof a.newLocation === 'string' && a.newLocation.trim() !== '' ? a.newLocation.trim() : undefined
  const hasTimeChange = a.newStartLocalISO !== undefined || a.newEndLocalISO !== undefined
  if (newTitle === undefined && newLocation === undefined && !hasTimeChange) {
    return { error: 'update needs at least one of newTitle, newStartLocalISO, newEndLocalISO or newLocation' }
  }

  const resolved = await resolveOne(device, a)
  if (!resolved.ok) return resolved.answer
  const { event, zone } = resolved.found

  const generated = refuseGeneratedEntry(event)
  if (generated) return generated

  const oldStart = isoMillis(event.startIso, zone)
  const oldEnd = isoMillis(event.endIso, zone)

  if (event.isAllDay && hasTimeChange) {
    // An all-day entry has `date`, not `dateTime`. Patching a dateTime in beside a live date is
    // rejected by Google with a message no owner should ever have to read.
    return {
      error: `"${event.summary}" is an all-day entry — it has no start time to move. Delete it and create a timed one, or change only its title or location.`,
    }
  }

  let newStart: number | undefined
  let newEnd: number | undefined
  try {
    if (a.newStartLocalISO !== undefined) newStart = localIsoToEpochMillis(String(a.newStartLocalISO), zone)
    if (a.newEndLocalISO !== undefined) newEnd = localIsoToEpochMillis(String(a.newEndLocalISO), zone)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid time' }
  }

  // Moving only the start MUST move the end. "Move my 3pm to 4" means the whole meeting slides, and
  // the alternative is not merely surprising but broken: a 15:00-16:00 event restarted at 16:00 with
  // its old end is zero-length, which Google rejects outright.
  let durationKept = false
  if (newStart !== undefined && newEnd === undefined && oldStart !== null && oldEnd !== null) {
    newEnd = newStart + (oldEnd - oldStart)
    durationKept = true
  }
  const effectiveStart = newStart ?? oldStart
  const effectiveEnd = newEnd ?? oldEnd
  if (effectiveStart !== null && effectiveEnd !== null && effectiveEnd <= effectiveStart) {
    return { error: 'that would end before it starts' }
  }

  let updated: CalendarEvent | null
  try {
    updated = await updateCalendarEvent(device.deviceId, event.id, {
      title: newTitle,
      startIso: newStart === undefined ? undefined : localIsoOf(newStart, zone),
      endIso: newEnd === undefined ? undefined : localIsoOf(newEnd, zone),
      location: newLocation,
    })
  } catch (err) {
    if (err instanceof Error && err.message === NOT_ORGANISER) {
      return {
        error: `"${event.summary}" belongs to whoever organised it — it cannot be moved or renamed from here, only in Google Calendar`,
      }
    }
    throw err
  }
  if (updated === null) {
    return { error: `Google no longer had "${event.summary}" — it looks like it was already removed` }
  }

  // A priced journey is wrong the moment the time or the place changes, and re-planning one nobody
  // asked for would break the rule that no alarm is ever armed except on an explicit call. So the
  // stale one goes and Otto is told to offer, rather than a new one appearing on its own.
  const timeOrPlaceMoved = newStart !== undefined || newEnd !== undefined || newLocation !== undefined
  const alarms =
    timeOrPlaceMoved && oldStart !== null ? await releaseLeaveByFor(device, eventKeyOf(event), oldStart) : []

  const updatedStart = isoMillis(updated.startIso, zone)
  const updatedEnd = isoMillis(updated.endIso, zone)
  return {
    updated: true,
    summary: updated.summary,
    startsLocal: updatedStart === null ? null : epochMillisToLocalHuman(updatedStart, zone),
    endsLocal: updatedEnd === null ? null : epochMillisToLocalHuman(updatedEnd, zone),
    location: updated.location ?? undefined,
    movedFromLocal: newStart !== undefined && oldStart !== null ? epochMillisToLocalHuman(oldStart, zone) : undefined,
    durationKept: durationKept ? true : undefined,
    occurrenceOnly: updated.recurringEventId !== null ? true : undefined,
    leaveByAlarmsCancelled: alarms.length > 0 ? alarms.length : undefined,
    note:
      alarms.length > 0
        ? 'the leave-by alarm for that no longer matches — say it has been cancelled and offer to set a new one'
        : updated.attendeeCount > 1
          ? 'other people are on that one and their copy has moved too — nobody was emailed, so they may want to message them'
          : undefined,
  }
}

type Block = { title: string; start: number; end: number; location?: string }

export async function planDay(device: Device, a: Record<string, unknown>): Promise<unknown> {
  if (!hasGoogle(device.deviceId)) return { error: 'calendar not connected' }
  const zone = device.timezone

  const raw = a.blocks
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'plan_day needs a blocks array — send every block for the day in one call' }
  }
  if (raw.length > MAX_BLOCKS) {
    return { error: `${raw.length} blocks is more than the ${MAX_BLOCKS} this takes at once — send the ones that matter` }
  }

  // Everything the model can get wrong is rejected BEFORE a single write. Half a day on the calendar
  // and an error is worse than no day and an error, because only one of those is easy to retry.
  const blocks: Block[] = []
  for (const [i, item] of raw.entries()) {
    const b = (item ?? {}) as Record<string, unknown>
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    const where = `block ${i + 1}${title === '' ? '' : ` ("${title}")`}`
    if (title === '') return { error: `block ${i + 1} has no title — every block needs one` }
    let start: number
    let end: number
    try {
      start = localIsoToEpochMillis(String(b.startLocalISO), zone)
      end = localIsoToEpochMillis(String(b.endLocalISO), zone)
    } catch (err) {
      return { error: `${where}: ${err instanceof Error ? err.message : 'invalid time'}` }
    }
    if (end <= start) return { error: `${where} ends before it starts` }
    const location = typeof b.location === 'string' && b.location.trim() !== '' ? b.location.trim() : undefined
    blocks.push({ title, start, end, location })
  }

  blocks.sort((x, y) => x.start - y.start)
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1]!
    const cur = blocks[i]!
    if (cur.start < prev.end) {
      // The model's own plan contradicts itself. Writing the half of it that happens to fit would
      // leave a day nobody designed, so the whole call is refused and it can send a fixed one.
      return {
        error: `"${prev.title}" and "${cur.title}" overlap each other — send blocks that do not collide`,
      }
    }
  }

  const windowFrom = localIsoOf(blocks[0]!.start, zone)
  const windowTo = localIsoOf(blocks[blocks.length - 1]!.end, zone)
  const existing = await tryListCalendarEvents(device.deviceId, windowFrom, windowTo)
  if (existing === null) {
    // Without the read there is no clash guarantee, and the one promise this tool makes is that it
    // never writes over a real meeting. Refusing is the only honest answer.
    return { error: 'calendar unreachable right now, so nothing was written — say so and offer to try again' }
  }

  // Their day start is the END of the wake window - the point by which they are certainly up - so a
  // block before it is one they would be asleep for. Reported, never refused: a 05:30 gym block is a
  // perfectly ordinary thing to want, and a planner that argues with it is worse than one that says
  // what it noticed.
  const routine = schedulingRoutine(device)
  const dayStarts = dayStartHour(routine) * 60 + dayStartMinute(routine)
  const outsideTheirDay: string[] = []

  const created: Array<{ title: string; startsLocal: string }> = []
  const skipped: Array<{ title: string; startsLocal: string; clashesWith: string }> = []
  const failed: Array<{ title: string; startsLocal: string; reason: string }> = []
  let stopped = false

  for (const block of blocks) {
    const startsLocal = epochMillisToLocalHuman(block.start, zone)
    if (stopped) {
      failed.push({ title: block.title, startsLocal, reason: 'not attempted — the calendar stopped answering partway through' })
      continue
    }
    const clash = existing.find((e) => overlapsWindow(e, block.start, block.end, zone))
    if (clash) {
      skipped.push({ title: block.title, startsLocal, clashesWith: clash.summary })
      continue
    }
    try {
      await createCalendarEvent(device.deviceId, {
        title: block.title,
        startIso: localIsoOf(block.start, zone),
        endIso: localIsoOf(block.end, zone),
        location: block.location ?? null,
        // These are the shape of the day, not appointments to be interrupted about. A dozen Calendar
        // popups from a producer this server cannot see would teach the owner to mute the lot.
        suppressDefaultReminders: true,
      })
      created.push({ title: block.title, startsLocal })
      const at = DateTime.fromMillis(block.start, { zone })
      if (at.hour * 60 + at.minute < dayStarts) outsideTheirDay.push(block.title)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failed.push({ title: block.title, startsLocal, reason })
      // A revoked grant fails identically for every remaining block, so pressing on buys nothing but
      // latency and a longer list of the same sentence.
      if (/invalid_grant/i.test(reason)) stopped = true
    }
  }

  const allWritten = skipped.length === 0 && failed.length === 0
  return {
    allWritten,
    created,
    skipped: skipped.length > 0 ? skipped : undefined,
    failed: failed.length > 0 ? failed : undefined,
    // Written, but worth a word when you confirm - they may have meant the afternoon.
    outsideTheirDay: outsideTheirDay.length > 0 ? outsideTheirDay : undefined,
    // An imperative sentence inside the result, in the register of add_note's `reminder` field. Three
    // arrays are too easy for a model to skim past on the way to saying "all done" — and a day
    // reported as planned when a third of it never landed is the one failure this tool exists to
    // make impossible.
    mustTell: allWritten
      ? undefined
      : `${skipped.length + failed.length} of the ${blocks.length} blocks are NOT on their calendar. Name which ones and why. Do not call the day planned.`,
  }
}
