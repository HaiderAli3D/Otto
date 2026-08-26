import { DateTime } from 'luxon'

/**
 * A do-not-disturb window as minutes from local midnight, or `null` for "no quiet hours".
 *
 * Minutes-from-midnight rather than a pair of `DateTime`s because the window is a recurring
 * wall-clock rule, not an instant: it means the same thing on every day of the year and in whatever
 * zone the device reports. The instant is only computed at the moment something needs deferring.
 */
export type QuietHours = { startMinute: number; endMinute: number } | null

const HH_MM = /^(\d{1,2}):(\d{2})$/

function parseHhMm(s: string): number | null {
  const m = HH_MM.exec(s.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/**
 * Parse `"22:00-07:00"` into a window. `"off"`, `""`, garbage, or `start === end` all give null.
 *
 * Never throws. This reads a free-text setting the owner typed into a chat message, so the failure
 * mode has to be "no quiet hours" — an exception here would take down whatever job was checking,
 * and a thrown error at 3am is strictly worse than a nudge the owner didn't want.
 */
export function parseQuietHours(spec: string | null | undefined): QuietHours {
  if (!spec) return null
  const trimmed = spec.trim().toLowerCase()
  if (trimmed === '' || trimmed === 'off' || trimmed === 'none') return null
  const parts = trimmed.split('-')
  if (parts.length !== 2) return null
  const startMinute = parseHhMm(parts[0]!)
  const endMinute = parseHhMm(parts[1]!)
  if (startMinute === null || endMinute === null) return null
  // start === end is ambiguous between a zero-length window and a 24h one, and nobody means either.
  if (startMinute === endMinute) return null
  return { startMinute, endMinute }
}

function hhmm(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60)
  return `${String(hour).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`
}

/** Render for the owner, e.g. `22:00–07:00` or `off`. En dash: this is prose, not an input format. */
export function formatQuietHours(q: QuietHours): string {
  if (q === null) return 'off'
  return `${hhmm(q.startMinute)}–${hhmm(q.endMinute)}`
}

/**
 * Is this minute-of-day inside the window? Null window ⇒ never.
 *
 * Split out from `inQuietHours` so that a caller holding a wall-clock TIME rather than an instant —
 * `setPreferences`, checking whether a configured brief hour is one the delivery gate would ever
 * honour — asks the same implementation rather than growing a second copy of the rule below. Two
 * copies of a midnight-spanning comparison is exactly the kind of thing that agrees for a year and
 * then disagrees about one edge.
 */
export function minuteInQuietHours(minuteOfDay: number, q: QuietHours): boolean {
  if (q === null) return false
  // Spanning midnight is the DEFAULT case, not an edge — quiet hours are for sleeping. When
  // start > end the window is the union of [start, midnight) and [midnight, end), so the test is
  // an OR. The end is exclusive, which is what makes deferPastQuietHours idempotent.
  if (q.startMinute > q.endMinute) return minuteOfDay >= q.startMinute || minuteOfDay < q.endMinute
  return minuteOfDay >= q.startMinute && minuteOfDay < q.endMinute
}

/** Is this instant inside the window, judged by wall-clock time in `zone`? Null window ⇒ never. */
export function inQuietHours(atMillis: number, zone: string, q: QuietHours): boolean {
  if (q === null) return false
  const dt = DateTime.fromMillis(atMillis, { zone })
  return minuteInQuietHours(dt.hour * 60 + dt.minute, q)
}

/**
 * The same instant if it is outside the window; otherwise the window's END on the correct local day.
 *
 * All of the arithmetic is luxon wall-clock in `zone` (set the local hour, then add a whole day if
 * needed) rather than a fixed millisecond offset — a "+9h" would land an hour early or late on the
 * two DST nights of the year, which is exactly when a 07:00 wake-up matters most.
 *
 * Idempotent by construction: the result is the exclusive end minute, which `inQuietHours` reports
 * as outside, so deferring an already-deferred instant returns it unchanged.
 */
export function deferPastQuietHours(atMillis: number, zone: string, q: QuietHours): number {
  if (q === null || !inQuietHours(atMillis, zone, q)) return atMillis
  const dt = DateTime.fromMillis(atMillis, { zone })
  const hour = Math.floor(q.endMinute / 60)
  let target = dt.set({ hour, minute: q.endMinute % 60, second: 0, millisecond: 0 })
  // 23:30 inside 22:00–07:00: today's 07:00 is already behind us, so the end we want is tomorrow's.
  if (target <= dt) target = target.plus({ days: 1 })
  return target.toMillis()
}
