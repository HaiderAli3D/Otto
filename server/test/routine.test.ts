import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import {
  DEFAULT_ROUTINE,
  bedEndHour,
  bedEndMinute,
  dayStartHour,
  dayStartMinute,
  describeRoutine,
  formatWindow,
  impliedQuietHours,
  parseRoutine,
  wakingDayEndsAt,
} from '../src/lib/routine.js'

/**
 * The routine is context rather than a gate, so almost nothing here is about suppression. What it IS
 * about is `dayStartHour`, which decides the wall-clock hour of every rung Otto picks for itself.
 */

const OWNER = parseRoutine('02:00-04:00', '10:00-14:00')!

describe('parseRoutine', () => {
  it('reads two windows, midnight-spanning bedtime included', () => {
    const r = parseRoutine('23:30-01:30', '07:00-09:00')!
    expect(formatWindow(r.bed)).toBe('23:30-01:30')
    expect(formatWindow(r.wake)).toBe('07:00-09:00')
  })

  it('is all-or-nothing — half a routine says nothing about when their day starts', () => {
    // Deliberate: `dayStartHour` reads only the wake window, so a bed-window-only routine would
    // silently behave like no routine while looking configured. Callers must be able to tell.
    expect(parseRoutine('02:00-04:00', null)).toBeNull()
    expect(parseRoutine(null, '10:00-14:00')).toBeNull()
    expect(parseRoutine(null, null)).toBeNull()
  })

  it('never throws on the free text an owner typed into a chat message', () => {
    for (const junk of ['', 'off', 'lateish', '25:00-04:00', '02:00', '02:00-02:00', 'none']) {
      expect(parseRoutine(junk, '10:00-14:00')).toBeNull()
      expect(parseRoutine('02:00-04:00', junk)).toBeNull()
    }
  })
})

describe('dayStartHour', () => {
  it('is the END of the wake range, not the start', () => {
    // The point Otto CHOOSES a time for must be when they are certainly up. For someone who wakes
    // between 10:00 and 14:00, a rung at 10:00 is a coin flip on whether it is heard at all.
    expect(dayStartHour(OWNER)).toBe(14)
    expect(dayStartMinute(OWNER)).toBe(0)
  })

  it('keeps the pre-routine ladder byte-identical by defaulting to 09:00', () => {
    // Load-bearing rather than cosmetic: this is the number that makes every nagLadder test that
    // predates routines pass unedited. Changing it silently moves every daily rung ever scheduled.
    expect(dayStartHour(DEFAULT_ROUTINE)).toBe(9)
    expect(dayStartMinute(DEFAULT_ROUTINE)).toBe(0)
  })

  it('carries a non-zero minute through', () => {
    expect(dayStartMinute(parseRoutine('01:00-02:00', '09:00-11:45')!)).toBe(45)
    expect(dayStartHour(parseRoutine('01:00-02:00', '09:00-11:45')!)).toBe(11)
  })
})

describe('describeRoutine', () => {
  it('states the times and says plainly that nothing is blocked', () => {
    // The surrounding quiet-hours prose promises that scheduling is moved automatically. Without
    // this sentence Otto reads a routine as a restriction it need not think about, and stops
    // applying judgement at exactly the hours judgement is the only thing there is.
    const text = describeRoutine(OWNER)
    expect(text).toContain('02:00')
    expect(text).toContain('04:00')
    expect(text).toContain('10:00')
    expect(text).toContain('14:00')
    expect(text).toMatch(/Nothing stops you reaching them at any hour/)
  })
})


/**
 * Every instant below is an explicit ISO string in a named zone. Nothing here reads `Date.now()`,
 * so none of it can pass or fail by the hour the suite happens to run at — the bug class this
 * repository has fixed twice.
 */
const ZONE = 'Europe/London'
const at = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis()
const local = (ms: number): string => DateTime.fromMillis(ms, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')

/** The owner this whole change was built for: up at noon, bed at two. */
const NIGHT_OWL = parseRoutine('01:00-02:00', '11:00-12:00')!

describe('bedEnd', () => {
  it('is the LATEST bedtime, split into hour and minute', () => {
    expect(bedEndHour(NIGHT_OWL)).toBe(2)
    expect(bedEndMinute(NIGHT_OWL)).toBe(0)
    expect(bedEndMinute(parseRoutine('01:00-02:45', '11:00-12:00')!)).toBe(45)
  })
})

describe('wakingDayEndsAt', () => {
  it('runs past midnight — tonight, not the end of the calendar day', () => {
    // The whole reason this exists rather than `endOf('day')`. At noon on the 3rd, "the rest of
    // today" for someone who goes to bed at two ends at 02:00 on the 4th.
    expect(local(wakingDayEndsAt(NIGHT_OWL, ZONE, at('2026-08-03T12:00')))).toBe('2026-08-04 02:00')
  })

  it('is still ahead of them at one in the morning', () => {
    expect(local(wakingDayEndsAt(NIGHT_OWL, ZONE, at('2026-08-04T01:00')))).toBe('2026-08-04 02:00')
  })

  it('rolls to the next one once they are past it', () => {
    expect(local(wakingDayEndsAt(NIGHT_OWL, ZONE, at('2026-08-04T03:00')))).toBe('2026-08-05 02:00')
  })

  it('lands on the stated wall-clock time across a DST change, not an hour either side', () => {
    // Asserted as a local clock string, never as a millisecond delta: the clocks go back on
    // 2026-10-25, so "+14h" and "02:00" are different answers and only one of them is right.
    expect(local(wakingDayEndsAt(NIGHT_OWL, ZONE, at('2026-10-24T23:00')))).toBe('2026-10-25 02:00')
    expect(local(wakingDayEndsAt(NIGHT_OWL, ZONE, at('2026-03-28T23:00')))).toBe('2026-03-29 02:00')
  })
})

describe('impliedQuietHours', () => {
  it('runs from the latest bedtime to the point they are certainly up', () => {
    // END at wake.END, the same edge dayStartHour reads. Someone who says they are up at noon
    // means nothing before noon — an end at 11:00 would satisfy the symmetry and miss the point.
    expect(impliedQuietHours(NIGHT_OWL)).toBe('02:00-12:00')
  })

  it('reproduces the old server-wide default for the old default routine', () => {
    // DEFAULT_ROUTINE is bed 23:00-01:00, wake 07:00-09:00 — so an owner who happened to state
    // exactly that gets 01:00-09:00, close to QUIET_HOURS_DEFAULT and never wilder than it.
    expect(impliedQuietHours(DEFAULT_ROUTINE)).toBe('01:00-09:00')
  })

  it('is storage form, hyphen not en dash, so it parses back', () => {
    // formatQuietHours is prose for the owner and uses an en dash; feeding that to parseQuietHours
    // silently gives null, which would mean "no quiet hours at all" for someone who set some.
    expect(impliedQuietHours(NIGHT_OWL)).not.toContain('–')
  })

  it('is null when the window would be degenerate', () => {
    // bed.end === wake.end is ambiguous between a zero-length window and a 24h one. Better to
    // derive nothing than to write a string the parser will reject at every read site.
    expect(impliedQuietHours(parseRoutine('01:00-02:00', '00:00-02:00')!)).toBeNull()
  })

  it('carries a non-zero minute through both edges', () => {
    expect(impliedQuietHours(parseRoutine('01:00-02:30', '11:00-12:15')!)).toBe('02:30-12:15')
  })
})
