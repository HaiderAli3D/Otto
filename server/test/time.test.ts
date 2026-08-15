import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import {
  localDateKey,
  localIsoAt,
  localIsoToEpochMillis,
  nextLocalTimeAt,
  sameLocalDay,
} from '../src/services/time.js'

const ZONE = 'Europe/London'
const at = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis()
const local = (ms: number): string => DateTime.fromMillis(ms, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')

describe('localIsoToEpochMillis', () => {
  it('interprets a local ISO in UTC', () => {
    expect(localIsoToEpochMillis('2026-07-02T18:00:00', 'UTC')).toBe(Date.UTC(2026, 6, 2, 18, 0, 0))
  })

  it('respects a non-UTC zone (Europe/London is UTC+1 in July)', () => {
    // 18:00 BST == 17:00 UTC
    expect(localIsoToEpochMillis('2026-07-02T18:00:00', 'Europe/London')).toBe(Date.UTC(2026, 6, 2, 17, 0, 0))
  })

  it('throws on an invalid datetime', () => {
    expect(() => localIsoToEpochMillis('not-a-date', 'UTC')).toThrow()
  })
})

describe('nextLocalTimeAt', () => {
  it('lands later the same day when the time is still ahead', () => {
    expect(local(nextLocalTimeAt(at('2026-08-03T06:00:00'), ZONE, 9))).toBe('2026-08-03 09:00')
  })

  it('rolls to tomorrow when the time has passed', () => {
    expect(local(nextLocalTimeAt(at('2026-08-03T18:00:00'), ZONE, 9))).toBe('2026-08-04 09:00')
  })

  it('is STRICTLY after — asking at the boundary gives tomorrow, not now', () => {
    // Otherwise a once-a-day job scheduled exactly on its own boundary re-fires immediately.
    const nine = at('2026-08-03T09:00:00')
    expect(local(nextLocalTimeAt(nine, ZONE, 9))).toBe('2026-08-04 09:00')
  })

  it('honours the minute argument and zeroes seconds', () => {
    const ms = nextLocalTimeAt(at('2026-08-03T06:00:00'), ZONE, 7, 45)
    expect(local(ms)).toBe('2026-08-03 07:45')
    expect(DateTime.fromMillis(ms, { zone: ZONE }).second).toBe(0)
    expect(DateTime.fromMillis(ms, { zone: ZONE }).millisecond).toBe(0)
  })

  it('holds the wall-clock hour across a DST change in both directions', () => {
    // A fixed "+24h" would land at 08:00 in October and 10:00 in March. UK clocks go back
    // 02:00 -> 01:00 on 2026-10-25 and forward 01:00 -> 02:00 on 2026-03-29.
    expect(local(nextLocalTimeAt(at('2026-10-24T18:00:00'), ZONE, 9))).toBe('2026-10-25 09:00')
    expect(local(nextLocalTimeAt(at('2026-03-28T18:00:00'), ZONE, 9))).toBe('2026-03-29 09:00')
  })

  it('does not carry a spring-forward correction into the next day', () => {
    // 01:30 does not exist in London on 28 March 2027 — the clocks jump 01:00 -> 02:00 — so luxon
    // resolves it forward to 02:30 and that IS the only instant available that morning.
    const gapDay = local(nextLocalTimeAt(at('2027-03-27T18:00:00'), ZONE, 1, 30))
    expect(gapDay).toBe('2027-03-28 02:30')

    // The day AFTER has no gap in it, so the correction must not follow. Adding a day to the already
    // corrected 02:30 gave 02:30 again — an hour adrift, and for a once-a-day job that reads its own
    // slot back off its scheduled instant, no longer on any boundary at all.
    expect(local(nextLocalTimeAt(at(gapDay.replace(' ', 'T') + ':00'), ZONE, 1, 30))).toBe('2027-03-29 01:30')
  })
})

describe('sameLocalDay', () => {
  it('is true for two instants on the same local day', () => {
    expect(sameLocalDay(at('2026-08-03T00:30:00'), at('2026-08-03T23:30:00'), ZONE)).toBe(true)
  })

  it('is false across the local midnight', () => {
    expect(sameLocalDay(at('2026-08-03T23:30:00'), at('2026-08-04T00:30:00'), ZONE)).toBe(false)
  })

  it('judges the day in the given zone, not UTC', () => {
    // 23:30 New York on the 3rd is already the 4th in London.
    const t = DateTime.fromISO('2026-08-03T23:30:00', { zone: 'America/New_York' }).toMillis()
    expect(sameLocalDay(t, t, 'America/New_York')).toBe(true)
    expect(sameLocalDay(t, at('2026-08-04T12:00:00'), ZONE)).toBe(true)
  })

  it('is never the same day as null — a marker that has never been set means "not yet today"', () => {
    expect(sameLocalDay(null, Date.now(), ZONE)).toBe(false)
  })
})

describe('localDateKey', () => {
  it('is the local calendar date, not the UTC one', () => {
    expect(localDateKey(at('2026-08-03T12:00:00'), ZONE)).toBe('2026-08-03')
    // 00:30 BST on the 4th is still 23:30 UTC on the 3rd — the key follows the owner, not UTC.
    expect(localDateKey(at('2026-08-04T00:30:00'), ZONE)).toBe('2026-08-04')
  })

  it('agrees with sameLocalDay, so a dedupe key and a once-a-day guard cannot disagree', () => {
    const a = at('2026-08-03T00:30:00')
    const b = at('2026-08-03T23:30:00')
    expect(localDateKey(a, ZONE) === localDateKey(b, ZONE)).toBe(sameLocalDay(a, b, ZONE))
  })
})

describe('localIsoAt', () => {
  it('renders a bare local wall-clock ISO with NO offset', () => {
    expect(localIsoAt(at('2026-08-03T15:22:33'), ZONE, 0)).toBe('2026-08-03T00:00:00')
    expect(localIsoAt(at('2026-08-03T15:22:33'), ZONE, 23, 59)).toBe('2026-08-03T23:59:00')
  })

  it('round-trips through localIsoToEpochMillis, which rejects offsets', () => {
    const iso = localIsoAt(at('2026-08-03T15:22:33'), ZONE, 9, 30)
    expect(iso).toBe('2026-08-03T09:30:00')
    expect(local(localIsoToEpochMillis(iso, ZONE))).toBe('2026-08-03 09:30')
  })

  it('stays a wall-clock time in winter, when the offset is different', () => {
    expect(localIsoAt(at('2026-01-15T15:22:33'), ZONE, 0)).toBe('2026-01-15T00:00:00')
  })
})
