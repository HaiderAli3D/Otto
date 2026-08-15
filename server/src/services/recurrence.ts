import { DateTime } from 'luxon'

/**
 * Recurring alarms, server-side only. The phone deliberately holds just ONE absolute occurrence
 * (spec: the app never decides when to ring); after each occurrence completes the server computes
 * the next wall-clock instant in the device's zone and pushes a fresh ARM_ALARM.
 *
 * Rule format is a small RRULE subset, stored verbatim in alarms.recurrence:
 *   FREQ=DAILY|WEEKLY|MONTHLY  — required
 *   INTERVAL=n                 — optional (1–365), every n days/weeks/months
 *   BYDAY=MO,TU,WE,TH,FR,SA,SU — optional, WEEKLY only, INTERVAL must be 1
 * Examples: "FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO,WE,FR", "FREQ=MONTHLY", "FREQ=DAILY;INTERVAL=2".
 */

export type Recurrence = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  interval: number
  byday: number[] | null // luxon weekday numbers, 1=Monday … 7=Sunday
}

const BYDAY_CODES: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 }

export function parseRecurrence(rule: string): Recurrence | null {
  let freq: Recurrence['freq'] | null = null
  let interval = 1
  let byday: number[] | null = null

  for (const part of rule.trim().toUpperCase().split(';').filter(Boolean)) {
    const [key, value] = part.split('=')
    if (!value) return null
    if (key === 'FREQ') {
      if (value !== 'DAILY' && value !== 'WEEKLY' && value !== 'MONTHLY') return null
      freq = value
    } else if (key === 'INTERVAL') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1 || n > 365) return null
      interval = n
    } else if (key === 'BYDAY') {
      const days = value.split(',').map((code) => BYDAY_CODES[code])
      if (days.length === 0 || days.some((d) => d === undefined)) return null
      byday = [...new Set(days as number[])].sort((a, b) => a - b)
    } else {
      return null // unknown key: reject rather than half-honor a rule we don't implement
    }
  }

  if (!freq) return null
  if (byday && freq !== 'WEEKLY') return null
  if (byday && interval !== 1) return null
  return { freq, interval, byday }
}

/**
 * The next occurrence strictly after BOTH the previous trigger and `nowMillis`, at the same
 * wall-clock time in `zone` (DST-correct: luxon calendar arithmetic keeps the local time).
 * `nowMillis` matters when the phone was unreachable across occurrences — the series skips
 * straight to the future instead of arming a past time. Returns null for an invalid rule or
 * when no occurrence exists within the search bound (~3 years of daily steps).
 */
export function nextOccurrence(rule: string, prevTriggerMillis: number, zone: string, nowMillis: number): number | null {
  const rec = parseRecurrence(rule)
  if (!rec) return null
  const anchor = DateTime.fromMillis(prevTriggerMillis, { zone })
  if (!anchor.isValid) return null

  if (rec.freq === 'WEEKLY' && rec.byday) {
    for (let i = 1; i <= 800; i++) {
      const candidate: DateTime = anchor.plus({ days: i })
      if (rec.byday.includes(candidate.weekday) && candidate.toMillis() > nowMillis) return candidate.toMillis()
    }
    return null
  }

  if (rec.freq === 'MONTHLY') {
    // plus({months}) clamps (Jan 31 + 1mo = Feb 28); skipping clamped months keeps a day-31
    // series on real 31sts instead of silently drifting to the 28th forever.
    for (let i = 1; i <= 60; i++) {
      const candidate: DateTime = anchor.plus({ months: i * rec.interval })
      if (candidate.day !== anchor.day) continue
      if (candidate.toMillis() > nowMillis) return candidate.toMillis()
    }
    return null
  }

  for (let i = 1; i <= 1100; i++) {
    const step = rec.freq === 'DAILY' ? { days: i * rec.interval } : { weeks: i * rec.interval }
    const candidate: DateTime = anchor.plus(step)
    if (candidate.toMillis() > nowMillis) return candidate.toMillis()
  }
  return null
}
