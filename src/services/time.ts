import { DateTime, IANAZone } from 'luxon'

/** True for a real IANA zone name (e.g. "Europe/London"); the app reports its zone on register/heartbeat. */
export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone)
}

// A trailing 'Z' or ±HH:MM / ±HHMM offset. luxon's `zone` option is ignored when the string
// already carries an offset, so an offset-bearing string would silently mean a different instant
// than "this wall-clock time in the device zone" — reject it and let the model retry.
const ISO_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

/**
 * Convert a local wall-clock ISO string (no offset, e.g. "2026-07-02T18:00:00") interpreted in
 * the given IANA zone to absolute epoch milliseconds. This is where "6pm tomorrow" becomes a
 * concrete instant — kept server-side and deterministic (DST-correct) so the model never does
 * epoch math and the phone just fires at the absolute time.
 */
export function localIsoToEpochMillis(localIso: string, zone: string): number {
  if (ISO_OFFSET_RE.test(localIso.trim())) {
    throw new Error(
      `"${localIso}" carries a timezone offset; pass a bare local wall-clock time (e.g. 2026-07-02T18:00:00) interpreted in ${zone}.`,
    )
  }
  const dt = DateTime.fromISO(localIso, { zone })
  if (!dt.isValid) {
    throw new Error(`Invalid datetime "${localIso}" in zone "${zone}": ${dt.invalidReason ?? 'unknown'}`)
  }
  return dt.toMillis()
}

/** Human-friendly local time for confirmations, e.g. "Thu, 2 Jul 2026, 18:00". */
export function epochMillisToLocalHuman(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat('EEE, d LLL yyyy, HH:mm')
}

export function nowIsoInZone(zone: string): string {
  return DateTime.now().setZone(zone).toISO() ?? new Date().toISOString()
}

/**
 * The next occurrence of a wall-clock time in `zone`, STRICTLY after `fromMillis`.
 *
 * Wall-clock rather than "+24h": adding a fixed millisecond offset to a UTC instant drifts by an
 * hour twice a year, so a 09:00 rung would land at 08:00 or 10:00 after a DST change. Setting the
 * local hour on a zoned DateTime pins the wall-clock time and lets the offset move instead.
 *
 * `<=` (not `<`) is load-bearing: "next" must never return the instant it was asked about, or a
 * once-a-day job scheduled exactly on its own boundary re-fires immediately.
 */
export function nextLocalTimeAt(fromMillis: number, zone: string, hour: number, minute = 0): number {
  const from = DateTime.fromMillis(fromMillis, { zone })
  let target = from.set({ hour, minute, second: 0, millisecond: 0 })
  if (target <= from) target = target.plus({ days: 1 })
  return target.toMillis()
}

/**
 * Same local calendar day in `zone`.
 *
 * `a === null` is never the same day as anything: callers pass a "last time we did X" marker that
 * starts null, and null has to read as "not yet today" so the first run of the day still happens.
 */
export function sameLocalDay(a: number | null, b: number, zone: string): boolean {
  if (a === null) return false
  return DateTime.fromMillis(a, { zone }).toISODate() === DateTime.fromMillis(b, { zone }).toISODate()
}

/**
 * `2026-08-03` in `zone` — the canonical day key for dedupe keys and once-a-day guards.
 *
 * One helper so every "have I already done this today?" check and every `kind:YYYY-MM-DD` dedupe
 * key agree on where the day boundary is; two call sites disagreeing means a duplicate send.
 */
export function localDateKey(ms: number, zone: string): string {
  // toISODate() is null only for an invalid DateTime (a bogus zone name). Fall back to the UTC date
  // rather than returning null and making every dedupe-key call site handle it.
  return DateTime.fromMillis(ms, { zone }).toISODate() ?? new Date(ms).toISOString().slice(0, 10)
}

/**
 * A bare local wall-clock ISO with NO offset, e.g. `2026-08-03T00:00:00`.
 *
 * The inverse of `localIsoToEpochMillis`, and deliberately offset-free for the same reason that one
 * rejects offsets: Google's Calendar/Tasks windows are sent as a local time plus a separate
 * `timeZone` field, so an offset baked into the string would silently mean a different instant.
 */
export function localIsoAt(ms: number, zone: string, hour: number, minute = 0): string {
  const dt = DateTime.fromMillis(ms, { zone }).set({ hour, minute, second: 0, millisecond: 0 })
  return dt.toFormat("yyyy-MM-dd'T'HH:mm:ss")
}
