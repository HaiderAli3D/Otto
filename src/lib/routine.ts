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
