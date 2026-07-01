import { describe, expect, it } from 'vitest'
import { localIsoToEpochMillis } from '../src/services/time.js'

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
