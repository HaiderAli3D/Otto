import { nextLocalTimeAt } from '../services/time.js'
import { parseQuietHours } from './quietHours.js'

/**
 * When the owner actually sleeps, and therefore when "morning" is for them.
 *
 * Both edges are RANGES, not instants, because that is how people describe themselves: "I go to
 * bed between 2 and 4 and get up somewhere between 10 and 2". Storing a single bedtime would force
 * a guess at authoring time and be wrong on both ends of it.
 *
 * Deliberately NOT a do-not-disturb window. Quiet hours (`device_settings.quiet_hours`) remain the
 * only thing that suppresses anything; this is context Otto reads and reasons about, and the one
 * input that decides which wall-clock hour a self-chosen rung lands on. An owner can have a routine
 * and no quiet hours at all — that is in fact the configuration this was built for.
 *
 * That boundary is narrower than it first reads, and the narrowing is deliberate. `impliedQuietHours`
 * below turns a routine INTO a quiet-hours string, and `setPreferences` writes that string into the
 * column once, at the moment the owner states their hours. Nothing derives a window at READ time:
 * `quietHoursFor` still consults the column and only the column, so an owner who says "quiet hours
 * off" is off, and a window they typed themselves is never overwritten by a later routine change.
 * A routine SEEDS a value the owner can then see and edit; it is still never consulted to decide
 * whether to suppress. Do not move that derivation to read time — see `services/settings.ts`.
 */
export type Window = { startMinute: number; endMinute: number }

export type Routine = { bed: Window; wake: Window }

/**
 * The routine assumed for a device that has never stated one.
 *
 * `wake` ending at 09:00 is load-bearing rather than cosmetic: `dayStartHour` reads the END of the
 * wake window, so this is what makes the default day start at 09:00 — the hour the nag ladder
 * hardcoded as `MORNING_HOUR` before routines existed. Every ladder test that predates this file
 * passes unchanged because of that one number.
 */
export const DEFAULT_ROUTINE: Routine = {
  bed: { startMinute: 23 * 60, endMinute: 1 * 60 },
  wake: { startMinute: 7 * 60, endMinute: 9 * 60 },
}

/**
 * Parse the two stored specs into a routine, or null if either is absent/unusable.
 *
 * All-or-nothing on purpose: a bed window with no wake window tells us nothing about when their day
 * starts, which is the only thing the rest of the system actually consumes. Half a routine that
 * silently behaved like a whole one would move every morning rung on the strength of a guess.
 *
 * Reuses `parseQuietHours` rather than growing a second HH:MM parser — it already treats a
 * midnight-spanning range as the normal case (which a bedtime of 23:00–01:00 is), already rejects
 * `start === end`, and already never throws on text the owner typed into a chat message.
 */
export function parseRoutine(bedSpec: string | null | undefined, wakeSpec: string | null | undefined): Routine | null {
  const bed = parseQuietHours(bedSpec)
  const wake = parseQuietHours(wakeSpec)
  if (bed === null || wake === null) return null
  return { bed, wake }
}

/**
 * The hour Otto CHOOSES when it needs "their morning" — a daily nag rung, a brief, a catch-up.
 *
 * The END of the wake window, not the start: this is the instant Otto picks for itself, so it must
 * be the point by which they are certainly up rather than the earliest they might be. For someone
 * who wakes between 10:00 and 14:00 that is 14:00, and a rung landing at 10:00 would be a coin flip
 * on whether it was heard at all.
 *
 * That distinction only matters because there are two kinds of caller. Anything DEFERRING a rung
 * out of a window uses the window's own end and wakes nobody; anything CHOOSING a time from scratch
 * comes here.
 */
export function dayStartHour(r: Routine): number {
  return Math.floor(r.wake.endMinute / 60)
}

export function dayStartMinute(r: Routine): number {
  return r.wake.endMinute % 60
}

/** The hour and minute of the LATEST bedtime — the edge at which their waking day ends. */
export function bedEndHour(r: Routine): number {
  return Math.floor(r.bed.endMinute / 60)
}

export function bedEndMinute(r: Routine): number {
  return r.bed.endMinute % 60
}

/**
 * The instant this waking day ends: the next occurrence of their LATEST bedtime.
 *
 * "The rest of today" for someone who goes to bed at two in the morning is not the rest of the
 * calendar day — a rung at 01:30 is still tonight to them, and midnight is the middle of their
 * evening. Anything asking "will this come up before they go to bed?" wants this, not `endOf('day')`.
 *
 * Wall-clock through `nextLocalTimeAt` rather than an added offset, for the reason the whole file
 * shares: a fixed "+14h" drifts by an hour on the two DST nights of the year.
 */
export function wakingDayEndsAt(r: Routine, zone: string, nowMillis: number): number {
  return nextLocalTimeAt(nowMillis, zone, bedEndHour(r), bedEndMinute(r))
}

/**
 * The quiet window a routine IMPLIES, in storage form (`"02:00-12:00"`), or null if degenerate.
 *
 * Latest bedtime to the point they are certainly up. Both edges mirror `dayStartHour`'s reasoning
 * above rather than inventing their own:
 *
 * - START at `bed.end`, the LATEST they go to bed, because going silent at the earliest would mute
 *   an hour they are reliably awake and happy to be reached in.
 * - END at `wake.end`, the same edge `dayStartHour` reads, because a window that lifted at the
 *   EARLIEST they might be up would let Otto speak first into a coin flip. Someone who says they
 *   are up at noon means nothing before noon.
 *
 * Null on the degenerate case — `parseQuietHours` rejects `start === end` as ambiguous between a
 * zero-length window and a 24-hour one, and nobody means either. Checked by parsing back what we
 * just formatted rather than by comparing minutes, so this can never disagree with the parser that
 * everything downstream actually uses.
 *
 * Formatted with `formatWindow` (hyphen), NOT `formatQuietHours` (en dash) — the latter is prose
 * for the owner, and feeding it back to `parseQuietHours` would silently produce null.
 */
export function impliedQuietHours(r: Routine): string | null {
  const spec = formatWindow({ startMinute: r.bed.endMinute, endMinute: r.wake.endMinute })
  return parseQuietHours(spec) === null ? null : spec
}

function hhmm(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60)
  return `${String(hour).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`
}

/** Render a window back to its stored form, e.g. `02:00-04:00`. */
export function formatWindow(w: Window): string {
  return `${hhmm(w.startMinute)}-${hhmm(w.endMinute)}`
}

/**
 * The routine as prose for the volatile prompt tail.
 *
 * Says explicitly that nothing is blocked, because the surrounding quiet-hours prose promises that
 * scheduling is moved automatically. Without this line Otto reads a routine as a restriction it
 * does not have to think about, and stops applying judgement at exactly the hours judgement is the
 * only thing there is.
 */
export function describeRoutine(r: Routine): string {
  const dayStart = hhmm(r.wake.endMinute)
  return [
    `Routine: the owner goes to bed between ${hhmm(r.bed.startMinute)} and ${hhmm(r.bed.endMinute)}`,
    `and gets up between ${hhmm(r.wake.startMinute)} and ${hhmm(r.wake.endMinute)}.`,
    `Their day starts at ${dayStart} — that is what "morning" means for them, and any hour inside`,
    `their sleep is the middle of their night however ordinary it looks on a clock.`,
    `Nothing stops you reaching them at any hour; judge each one yourself.`,
  ].join(' ')
}
