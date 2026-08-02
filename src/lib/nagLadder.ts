import { DateTime } from 'luxon'

export type NagPolicy = 'off' | 'gentle' | 'persistent'

export const NAG_POLICIES: NagPolicy[] = ['off', 'gentle', 'persistent']

export function isNagPolicy(v: unknown): v is NagPolicy {
  return typeof v === 'string' && (NAG_POLICIES as string[]).includes(v)
}

/** Stop pestering after this many nudges even on `persistent`; the reminder stays OPEN. */
export const MAX_NAGS = 8

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** 09:00 local on the next day strictly after `fromMillis`, in the owner's zone. */
function nextMorning(fromMillis: number, zone: string, hour = 9): number {
  const from = DateTime.fromMillis(fromMillis, { zone })
  let target = from.set({ hour, minute: 0, second: 0, millisecond: 0 })
  if (target <= from) target = target.plus({ days: 1 })
  return target.toMillis()
}

/**
 * When to nudge next, or null when the ladder is exhausted (the reminder stays OPEN and still
 * shows in lists and digests — it just stops pestering).
 *
 * `nagCount` is how many nudges have ALREADY been sent, so 0 means "the first one is due".
 *
 * Morning rungs are computed as wall-clock 09:00 in the device zone rather than by adding hours to
 * a UTC instant — otherwise a UK owner's nudges drift by an hour every summer.
 */
export function nextNagAt(params: {
  policy: NagPolicy
  nagCount: number
  dueAtMillis: number | null
  zone: string
  nowMillis: number
}): number | null {
  const { policy, nagCount, dueAtMillis, zone, nowMillis } = params
  if (policy === 'off') return null
  if (nagCount >= MAX_NAGS) return null

  // Undated ("someday") reminders never nag on a clock; they surface in lists and the digest.
  if (dueAtMillis === null) return null

  // First rung is the due time itself — unless it is already past, in which case nudge promptly.
  if (nagCount === 0) return Math.max(dueAtMillis, nowMillis)

  const base = Math.max(dueAtMillis, nowMillis)

  if (policy === 'gentle') {
    // due → +2h → next morning → stop
    if (nagCount === 1) return dueAtMillis + 2 * HOUR
    if (nagCount === 2) return nextMorning(base, zone)
    return null
  }

  // persistent: due → +30m → +2h → +6h → then daily at 09:00
  if (nagCount === 1) return dueAtMillis + 30 * MINUTE
  if (nagCount === 2) return dueAtMillis + 2 * HOUR
  if (nagCount === 3) return dueAtMillis + 6 * HOUR
  return nextMorning(base, zone)
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
