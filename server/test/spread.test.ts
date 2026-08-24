import { describe, expect, it } from 'vitest'
import { MORNING_SPREAD_MS, SPREAD_BUCKETS, spreadOffsetMs } from '../src/lib/spread.js'

/**
 * No clock anywhere in this file, and that is the point rather than an accident: `spreadOffsetMs`
 * takes no time at all. Every other scheduling test in this suite has to defend against the hour of
 * day (see the note at the top of nagging.test.ts); this one is immune by construction, which is
 * exactly the property that makes the spread safe to recompute.
 */
describe('spreadOffsetMs', () => {
  const BUCKET_MS = MORNING_SPREAD_MS / SPREAD_BUCKETS

  it('is deterministic — the same key always gives the same offset', () => {
    const a = spreadOffsetMs('rem_abc123')
    for (let i = 0; i < 20; i++) expect(spreadOffsetMs('rem_abc123')).toBe(a)
  })

  it('is STRICTLY positive, so a released rung never lands back on the release edge', () => {
    // The whole reason buckets are 1..N. A zero offset would put the rung back on the quiet-window
    // end, the day-start hour and the brief instant — the three-way collision the spread exists for.
    for (let i = 0; i < 500; i++) expect(spreadOffsetMs(`rem_${i}`)).toBeGreaterThan(0)
  })

  it('never exceeds the span', () => {
    for (let i = 0; i < 500; i++) expect(spreadOffsetMs(`rem_${i}`)).toBeLessThanOrEqual(MORNING_SPREAD_MS)
  })

  it('lands on a whole bucket, and therefore on a whole minute', () => {
    for (let i = 0; i < 200; i++) {
      const offset = spreadOffsetMs(`rem_${i}`)
      expect(offset % BUCKET_MS).toBe(0)
      expect(offset % 60_000).toBe(0)
    }
  })

  it('actually uses its buckets — a hash that collapsed would defeat the whole feature', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) seen.add(spreadOffsetMs(`rem_${i}`))
    expect(seen.size).toBeGreaterThanOrEqual(10)
    expect(seen.size).toBeLessThanOrEqual(SPREAD_BUCKETS)
  })

  it('separates two ids that differ by one character', () => {
    // Nothing guarantees this for an arbitrary pair, but these two are pinned: a future "cheaper"
    // hash that keyed on length or first byte would fail here rather than silently in production.
    expect(spreadOffsetMs('rem_aaaaaaa1')).not.toBe(spreadOffsetMs('rem_aaaaaaa2'))
  })

  it('honours an explicit span and bucket count', () => {
    const offset = spreadOffsetMs('rem_x', 60 * 60 * 1000, 4)
    expect(offset % (15 * 60 * 1000)).toBe(0)
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThanOrEqual(60 * 60 * 1000)
  })
})
