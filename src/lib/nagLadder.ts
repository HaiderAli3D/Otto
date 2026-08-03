import { nextLocalTimeAt } from '../services/time.js'
import { deferPastQuietHours, type QuietHours } from './quietHours.js'

export type NagPolicy = 'off' | 'gentle' | 'persistent'

export const NAG_POLICIES: NagPolicy[] = ['off', 'gentle', 'persistent']

export function isNagPolicy(v: unknown): v is NagPolicy {
  return typeof v === 'string' && (NAG_POLICIES as string[]).includes(v)
}

/** Stop pestering after this many nudges even on `persistent`; the reminder stays OPEN. */
export const MAX_NAGS = 8

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The hour a morning rung lands on: late enough to be awake, early enough to still act on it. */
const MORNING_HOUR = 9

/**
 * When to nudge next, or null when the ladder is exhausted (the reminder stays OPEN and still
 * shows in lists and digests — it just stops pestering).
 *
 * `nagCount` is how many nudges have ALREADY been sent, so 0 means "the first one is due".
 *
 * Morning rungs are computed as wall-clock 09:00 in the device zone rather than by adding hours to
 * a UTC instant — otherwise a UK owner's nudges drift by an hour every summer.
 *
 * `quiet` is the PRIMARY quiet-hours choke point for the whole system. Four of the five external
 * schedulers reach the ladder through this one function, so deferring here means nothing is ever
 * SCHEDULED into the window in the first place — far better than filtering at delivery, where a
 * suppressed nudge has already burned its rung. Omitting it (or passing null) reproduces the
 * pre-quiet-hours behaviour byte for byte, which is what the existing ladder tests pin.
 */
export function nextNagAt(params: {
  policy: NagPolicy
  nagCount: number
  dueAtMillis: number | null
  zone: string
  nowMillis: number
  quiet?: QuietHours
}): number | null {
  const { policy, nagCount, dueAtMillis, zone, nowMillis } = params
  const quiet = params.quiet ?? null
  if (policy === 'off') return null
  if (nagCount >= MAX_NAGS) return null

  // Undated ("someday") reminders never nag on a clock; they surface in lists and the digest.
  if (dueAtMillis === null) return null

  // First rung is the due time itself — unless it is already past, in which case nudge promptly.
  //
  // A still-future due time is NEVER deferred: that instant is the one the owner picked, so a
  // reminder due 23:30 nudges at 23:30 even inside quiet hours. Explicit per-item intent beats a
  // global default, and a quiet window that silently moved the owner's own chosen time would make
  // the feature feel broken rather than considerate. Once the due time is behind us we are picking
  // the instant ourselves, so the window applies again.
  if (nagCount === 0) {
    if (dueAtMillis >= nowMillis) return dueAtMillis
    return deferPastQuietHours(nowMillis, zone, quiet)
  }

  const base = Math.max(dueAtMillis, nowMillis)

  if (policy === 'gentle') {
    // due → +2h → next morning → stop
    if (nagCount === 1) return deferPastQuietHours(dueAtMillis + 2 * HOUR, zone, quiet)
    if (nagCount === 2) return deferPastQuietHours(nextLocalTimeAt(base, zone, MORNING_HOUR), zone, quiet)
    return null
  }

  // persistent: due → +30m → +2h → +6h → then daily at 09:00
  if (nagCount === 1) return deferPastQuietHours(dueAtMillis + 30 * MINUTE, zone, quiet)
  if (nagCount === 2) return deferPastQuietHours(dueAtMillis + 2 * HOUR, zone, quiet)
  if (nagCount === 3) return deferPastQuietHours(dueAtMillis + 6 * HOUR, zone, quiet)
  return deferPastQuietHours(nextLocalTimeAt(base, zone, MORNING_HOUR), zone, quiet)
}

/**
 * Escalating nudge wording, indexed by how many have already gone out. Templated rather than
 * LLM-generated: it is one sentence with one variable, the owner will see it dozens of times, and
 * rung-indexed phrasing reads as escalation instead of a bot repeating itself. It also works at
 * 3am with no API key and no latency.
 */
export function nudgeText(title: string, nagCount: number, overdueDescription?: string): string {
  switch (nagCount) {
    case 0:
      return `${title}.`
    case 1:
      return `Still need to ${lowerFirst(title)}? Say done when it's sorted.`
    case 2:
      return `Nudge: ${lowerFirst(title)} is still open.`
    default:
      return overdueDescription
        ? `${title} — ${overdueDescription}. Done, or shall I drop it?`
        : `${title} is still outstanding. Done, or shall I drop it?`
  }
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s
}
