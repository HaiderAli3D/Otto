import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTINE, dayStartHour, dayStartMinute, describeRoutine, formatWindow, parseRoutine } from '../src/lib/routine.js'

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
