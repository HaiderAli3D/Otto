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

/**
 * `bedStated` is the difference between a bed window the OWNER gave and one this module supplied.
 *
 * Load-bearing rather than bookkeeping. Two things must never act on a bedtime nobody mentioned:
 * `impliedQuietHours`, which would go silent from an invented hour, and `describeRoutine`, which
 * would tell Otto a confident bedtime it will then be caught having made up. Everything else — the
 * day end, the leave-by day start — wants a usable answer more than it wants a stated one, and gets
 * the default's bed window without having to branch.
 */
export type Routine = { bed: Window; wake: Window; bedStated: boolean }

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
  // `true` because this window is a real answer for the callers that read it (`wakingDayEndsAt` and
  // friends), not a placeholder they must guard. Nothing ever derives quiet hours or prose from the
  // default routine — both of those paths start from `routineFor`, which returns only stated ones.
  bedStated: true,
}

/**
 * Parse the two stored specs into a routine, or null when the WAKE window is absent/unusable.
 *
 * The wake window alone is a routine, and the bed window is optional. This used to be
 * all-or-nothing, which made "I get up at 7" a write-only sentence: the value was stored, Otto
 * confirmed it, and then nothing read it. `routineFor` returned null, `schedulingRoutine` fell back
 * to the default 09:00 day start, and `describeRoutine` was never called — so the wake time was
 * absent from the next turn's prompt and Otto could not even recall having been told. Every
 * consumer that matters reads the WAKE half (`dayStartHour`, `briefAnchorHour`), so a stated wake
 * window is enough to be useful and refusing it was the whole bug.
 *
 * A missing bed window is filled from `DEFAULT_ROUTINE` and flagged with `bedStated: false`, so
 * callers that need a usable day end get one and the two callers that must not invent a bedtime can
 * tell. A bed window with no wake window is still null — it says nothing about when their day
 * starts, which is the thing the rest of the system actually consumes.
 *
 * Reuses `parseQuietHours` rather than growing a second HH:MM parser — it already treats a
 * midnight-spanning range as the normal case (which a bedtime of 23:00–01:00 is), already rejects
 * `start === end`, and already never throws on text the owner typed into a chat message.
 */
export function parseRoutine(bedSpec: string | null | undefined, wakeSpec: string | null | undefined): Routine | null {
  const wake = parseQuietHours(wakeSpec)
  if (wake === null) return null
  const bed = parseQuietHours(bedSpec)
  if (bed === null) return { bed: DEFAULT_ROUTINE.bed, wake, bedStated: false }
  return { bed, wake, bedStated: true }
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

/**
 * The wall clock the owner's BRIEF lands on — the START of the wake window.
 *
 * Deliberately the opposite edge from `dayStartHour`, and the two must not be re-merged. The
 * distinction is which side of the coin flip each one is willing to be on:
 *
 * - `dayStartHour` is Otto picking an instant for ITSELF with nothing to anchor to — a daily tail
 *   rung, a catch-up. It reads the END because a self-chosen chase that lands while they are still
 *   asleep is simply wasted, and there is no cost to waiting until they are certainly up.
 * - The brief is a STANDING APPOINTMENT the owner is promised, and it opens their day. Landing it at
 *   the latest hour they might rise means someone who says "I'm up between 7 and 9" is briefed at
 *   09:00 — two hours into a morning the brief was supposed to start. They can read it late; they
 *   cannot read it early.
 *
 * Sharing one edge is what made a perfectly ordinary sentence move the brief two hours and read as
 * Otto breaking. See `impliedQuietHours`, which ends on this same edge for the same reason.
 */
export function briefAnchorHour(r: Routine): number {
  return Math.floor(r.wake.startMinute / 60)
}

export function briefAnchorMinute(r: Routine): number {
  return r.wake.startMinute % 60
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
 * The quiet window a routine IMPLIES, in storage form (`"02:00-07:00"`), or null when it cannot say.
 *
 * Latest bedtime to the EARLIEST they might be up:
 *
 * - START at `bed.end`, the LATEST they go to bed, because going silent at the earliest would mute
 *   an hour they are reliably awake and happy to be reached in.
 * - END at `wake.start`, the same edge `briefAnchorHour` reads. This used to be `wake.end`, on the
 *   argument that lifting at the earliest would let Otto speak first into a coin flip. That
 *   argument was wrong in one direction and expensive in the other. Quiet hours are not only a
 *   licence to speak — `planRungs` drops any warning the window would push past its own deadline,
 *   so an owner who said "up between 7 and 9" silently lost EVERY advance warning on an 08:00
 *   deadline: ten rungs, all deferred to 09:00, all after the thing. Ending at the earliest they
 *   might be up costs at most one message landing while they are still dozing; ending at the latest
 *   cost them the entire run-up on anything due in their own morning.
 *
 * Null when the bed window was never stated (`bedStated: false`), because there is nothing to start
 * the window from and `DEFAULT_ROUTINE`'s bedtime is this module's assumption rather than theirs.
 * A wake-only routine still sets the day start and the brief; it just does not silence anything.
 *
 * Also null on the degenerate case — `parseQuietHours` rejects `start === end` as ambiguous between
 * a zero-length window and a 24-hour one, and nobody means either. Checked by parsing back what we
 * just formatted rather than by comparing minutes, so this can never disagree with the parser that
 * everything downstream actually uses.
 *
 * Formatted with `formatWindow` (hyphen), NOT `formatQuietHours` (en dash) — the latter is prose
 * for the owner, and feeding it back to `parseQuietHours` would silently produce null.
 */
export function impliedQuietHours(r: Routine): string | null {
  if (!r.bedStated) return null
  const spec = formatWindow({ startMinute: r.bed.endMinute, endMinute: r.wake.startMinute })
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
  // The bed half is omitted entirely when they never gave one, rather than rendered from
  // `DEFAULT_ROUTINE`. `parseRoutine` fills that window so the scheduling callers have a usable day
  // end, but stating it here would have Otto tell the owner a bedtime they never mentioned — and
  // then act on it, and then be caught having invented it. Saying less is the only honest option.
  const sleep = r.bedStated
    ? [
        `the owner goes to bed between ${hhmm(r.bed.startMinute)} and ${hhmm(r.bed.endMinute)}`,
        `and gets up between ${hhmm(r.wake.startMinute)} and ${hhmm(r.wake.endMinute)}.`,
      ]
    : [
        `the owner gets up between ${hhmm(r.wake.startMinute)} and ${hhmm(r.wake.endMinute)}.`,
        `They have not said when they go to bed — do not assume, and ask if it matters.`,
      ]
  return [
    `Routine:`,
    ...sleep,
    `Their day starts at ${dayStart} — that is what "morning" means for them, and any hour inside`,
    `their sleep is the middle of their night however ordinary it looks on a clock.`,
    `Nothing stops you reaching them at any hour; judge each one yourself.`,
  ].join(' ')
}
