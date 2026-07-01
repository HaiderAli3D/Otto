import { DateTime } from 'luxon'

/**
 * Convert a local wall-clock ISO string (no offset, e.g. "2026-07-02T18:00:00") interpreted in
 * the given IANA zone to absolute epoch milliseconds. This is where "6pm tomorrow" becomes a
 * concrete instant — kept server-side and deterministic (DST-correct) so the model never does
 * epoch math and the phone just fires at the absolute time.
 */
export function localIsoToEpochMillis(localIso: string, zone: string): number {
  const dt = DateTime.fromISO(localIso, { zone })
  if (!dt.isValid) {
    throw new Error(`Invalid datetime "${localIso}" in zone "${zone}": ${dt.invalidReason ?? 'unknown'}`)
  }
  return dt.toMillis()
}

export function epochMillisToLocalIso(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toISO() ?? new Date(ms).toISOString()
}

/** Human-friendly local time for confirmations, e.g. "Thu, 2 Jul 2026, 18:00". */
export function epochMillisToLocalHuman(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat('EEE, d LLL yyyy, HH:mm')
}

export function nowIsoInZone(zone: string): string {
  return DateTime.now().setZone(zone).toISO() ?? new Date().toISOString()
}
