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
