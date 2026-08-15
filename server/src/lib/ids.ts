import { createHash } from 'node:crypto'
import { monotonicFactory, ulid } from 'ulid'

/** Server-generated stable alarm id. Idempotent arming on the app keys off this. */
export const newAlarmId = (): string => `alm_${ulid()}`

/** Reminder id. Distinct prefix from alarms so a mixed-up id fails loudly rather than silently. */
export const newReminderId = (): string => `rem_${ulid()}`

export const newFactId = (): string => `fct_${ulid()}`

/** A saved place. Never shown to the model — it addresses places by alias, which is the point. */
export const newSavedPlaceId = (): string => `plc_${ulid()}`

/**
 * One "where are you?" question.
 *
 * Never reused: it is what pairs an answer arriving on a separate HTTP request — possibly in another
 * process, after a restart — with the question still waiting for it. Two overlapping requests would
 * otherwise be indistinguishable on the wire.
 */
export const newRequestId = (): string => `loc_${ulid()}`

/**
 * A note. Shown to the model, because deleting one needs the id and nothing else identifies it.
 *
 * MONOTONIC, unlike every other id here, and that is load-bearing rather than tidy. Notes are an
 * append-only log read back in the order they were written, and two added in one turn — "milk" then
 * "and bread" — land in the same millisecond. A plain `ulid()` re-randomises its low bits on every
 * call, so those two would sort by coin flip and the list would silently reorder itself. The
 * monotonic factory guarantees the second id sorts after the first within the same millisecond,
 * which is exactly the tiebreaker `readNotes` orders on.
 */
const noteUlid = monotonicFactory()
export const newNoteId = (): string => `not_${noteUlid()}`

/** Joins the parts of a derived id. A control character, so it cannot occur in a summary. */
const SEP = '\u0000'

/**
 * A DERIVED alarm id: the same inputs always give the same id.
 *
 * This is how duplicate leave-by alarms are structurally prevented rather than defended against.
 * Three independent paths can decide the same event needs the same alarm — a proactive plan, an
 * explicit tool call, and the leave-by recheck — and with a random `newAlarmId()` each would create
 * its own row and the phone would ring three times. Deriving the id means all three converge on ONE
 * row through `armAlarm`'s idempotent upsert, whichever order they run in.
 *
 * Keeps the `alm_` prefix so every id in the alarms table reads the same way, and is truncated to a
 * ULID's 26 characters so nothing downstream meets an unfamiliar shape. Joined on a separator that
 * cannot appear in the parts: with a plain concatenation, ("ab","c") and ("a","bc") would hash the
 * same, and a summary is free text.
 */
function derivedAlarmId(kind: string, deviceId: string, eventKey: string, dayKey: string): string {
  const digest = createHash('sha256').update([kind, deviceId, eventKey, dayKey].join(SEP)).digest('hex')
  return `alm_${digest.slice(0, 26)}`
}

/** The "leave now" alarm for one event on one local day. */
export const leaveByAlarmId = (deviceId: string, eventKey: string, dayKey: string): string =>
  derivedAlarmId('leaveby', deviceId, eventKey, dayKey)

/** The get-up alarm for the same event. A different kind, so the two can never collide. */
export const wakeAlarmId = (deviceId: string, eventKey: string, dayKey: string): string =>
  derivedAlarmId('wake', deviceId, eventKey, dayKey)
