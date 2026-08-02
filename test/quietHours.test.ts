import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import {
  deferPastQuietHours,
  formatQuietHours,
  inQuietHours,
  parseQuietHours,
} from '../src/lib/quietHours.js'

const ZONE = 'Europe/London'
const at = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis()
const local = (ms: number): string => DateTime.fromMillis(ms, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')

const NIGHT = parseQuietHours('22:00-07:00')!
const AFTERNOON = parseQuietHours('13:00-14:00')!

describe('parseQuietHours', () => {
  it('parses a normal overnight window', () => {
    expect(parseQuietHours('22:00-07:00')).toEqual({ startMinute: 22 * 60, endMinute: 7 * 60 })
  })

  it('parses a same-day window', () => {
    expect(parseQuietHours('13:00-14:30')).toEqual({ startMinute: 13 * 60, endMinute: 14 * 60 + 30 })
  })

  it('treats "off" as no quiet hours', () => {
    expect(parseQuietHours('off')).toBeNull()
    expect(parseQuietHours('OFF')).toBeNull()
  })

  it('returns null for anything it cannot read, rather than throwing', () => {
    // The owner types this into a chat message; a throw here would take down the caller.
    expect(parseQuietHours('25:00-07:00')).toBeNull()
    expect(parseQuietHours('22:00-07:99')).toBeNull()
    expect(parseQuietHours('')).toBeNull()
    expect(parseQuietHours('   ')).toBeNull()
    expect(parseQuietHours('abc')).toBeNull()
    expect(parseQuietHours('22:00')).toBeNull()
    expect(parseQuietHours('22:00-07:00-09:00')).toBeNull()
    expect(parseQuietHours(null)).toBeNull()
    expect(parseQuietHours(undefined)).toBeNull()
  })

  it('rejects a zero-length window — it is ambiguous with a 24h one', () => {
    expect(parseQuietHours('07:00-07:00')).toBeNull()
  })
})

describe('formatQuietHours', () => {
  it('round-trips a window into prose and says "off" for null', () => {
    expect(formatQuietHours(NIGHT)).toBe('22:00–07:00')
    expect(formatQuietHours(parseQuietHours('09:05-17:30'))).toBe('09:05–17:30')
    expect(formatQuietHours(null)).toBe('off')
  })
})

describe('inQuietHours across midnight', () => {
  // Spanning midnight is the DEFAULT shape of quiet hours, so it gets the exhaustive cases.
  it('is inside before midnight', () => {
    expect(inQuietHours(at('2026-08-03T23:30:00'), ZONE, NIGHT)).toBe(true)
  })

  it('is inside after midnight', () => {
    expect(inQuietHours(at('2026-08-04T03:00:00'), ZONE, NIGHT)).toBe(true)
  })

  it('is outside at the exclusive end', () => {
    expect(inQuietHours(at('2026-08-04T07:00:00'), ZONE, NIGHT)).toBe(false)
  })

  it('is outside a minute before the start', () => {
    expect(inQuietHours(at('2026-08-03T21:59:00'), ZONE, NIGHT)).toBe(false)
  })

  it('is inside exactly at the inclusive start', () => {
    expect(inQuietHours(at('2026-08-03T22:00:00'), ZONE, NIGHT)).toBe(true)
  })
})

describe('inQuietHours for a same-day window', () => {
  it('does not wrap: only 13:00–14:00 is quiet', () => {
    expect(inQuietHours(at('2026-08-03T13:30:00'), ZONE, AFTERNOON)).toBe(true)
    expect(inQuietHours(at('2026-08-03T13:00:00'), ZONE, AFTERNOON)).toBe(true)
    expect(inQuietHours(at('2026-08-03T12:59:00'), ZONE, AFTERNOON)).toBe(false)
    expect(inQuietHours(at('2026-08-03T14:00:00'), ZONE, AFTERNOON)).toBe(false)
    expect(inQuietHours(at('2026-08-03T02:00:00'), ZONE, AFTERNOON)).toBe(false)
  })
})

describe('a null window means no quiet hours at all', () => {
  it('is never inside and never defers', () => {
    const t = at('2026-08-04T03:00:00')
    expect(inQuietHours(t, ZONE, null)).toBe(false)
    expect(deferPastQuietHours(t, ZONE, null)).toBe(t)
  })
})

describe('deferPastQuietHours', () => {
  it('is the identity outside the window', () => {
    const t = at('2026-08-03T18:00:00')
    expect(deferPastQuietHours(t, ZONE, NIGHT)).toBe(t)
  })

  it('moves a late-evening instant to the NEXT day window end', () => {
    const t = at('2026-08-03T23:30:00')
    expect(local(deferPastQuietHours(t, ZONE, NIGHT))).toBe('2026-08-04 07:00')
  })

  it('moves an early-morning instant to the SAME day window end', () => {
    const t = at('2026-08-04T03:00:00')
    expect(local(deferPastQuietHours(t, ZONE, NIGHT))).toBe('2026-08-04 07:00')
  })

  it('defers a same-day window to its own end', () => {
    const t = at('2026-08-03T13:30:00')
    expect(local(deferPastQuietHours(t, ZONE, AFTERNOON))).toBe('2026-08-03 14:00')
  })

  it('is idempotent — deferring its own output is a no-op', () => {
    // Load-bearing: a deferred job that gets re-checked on the next tick must not walk forward a
    // day each time. It holds because the window end is exclusive.
    const once = deferPastQuietHours(at('2026-08-03T23:30:00'), ZONE, NIGHT)
    expect(deferPastQuietHours(once, ZONE, NIGHT)).toBe(once)
    expect(inQuietHours(once, ZONE, NIGHT)).toBe(false)
  })
})

describe('deferPastQuietHours across a DST boundary', () => {
  // A fixed "+9h" offset would land an hour off on exactly these two nights of the year — which is
  // when a 07:00 wake-up matters most. All the arithmetic has to be wall-clock in the zone.
  it('lands on 07:00 wall-clock the morning clocks go BACK', () => {
    // UK clocks go back 02:00 -> 01:00 on 2026-10-25, making that night 25 hours long.
    const t = at('2026-10-24T23:30:00')
    expect(local(deferPastQuietHours(t, ZONE, NIGHT))).toBe('2026-10-25 07:00')
  })

  it('lands on 07:00 wall-clock the morning clocks go FORWARD', () => {
    // UK clocks go forward 01:00 -> 02:00 on 2026-03-29, making that night 23 hours long.
    const t = at('2026-03-28T23:30:00')
    expect(local(deferPastQuietHours(t, ZONE, NIGHT))).toBe('2026-03-29 07:00')
  })

  it('stays idempotent across both boundaries', () => {
    for (const iso of ['2026-10-24T23:30:00', '2026-03-28T23:30:00']) {
      const once = deferPastQuietHours(at(iso), ZONE, NIGHT)
      expect(deferPastQuietHours(once, ZONE, NIGHT)).toBe(once)
    }
  })
})
