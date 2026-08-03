import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { MAX_NAGS, nextNagAt, nudgeText } from '../src/lib/nagLadder.js'
import { parseQuietHours } from '../src/lib/quietHours.js'

const ZONE = 'Europe/London'
const at = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis()
const local = (ms: number): string => DateTime.fromMillis(ms, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')

const NIGHT = parseQuietHours('22:00-07:00')

describe('nextNagAt', () => {
  const due = at('2026-08-03T18:00:00')
  const now = at('2026-08-03T09:00:00')

  it('never nags when the policy is off', () => {
    expect(nextNagAt({ policy: 'off', nagCount: 0, dueAtMillis: due, zone: ZONE, nowMillis: now })).toBeNull()
  })

  it('never nags an undated reminder — it only surfaces in lists and digests', () => {
    expect(nextNagAt({ policy: 'persistent', nagCount: 0, dueAtMillis: null, zone: ZONE, nowMillis: now })).toBeNull()
  })

  it('fires the first rung at the due time', () => {
    expect(nextNagAt({ policy: 'gentle', nagCount: 0, dueAtMillis: due, zone: ZONE, nowMillis: now })).toBe(due)
  })

  it('fires immediately when the due time has already passed', () => {
    const late = at('2026-08-03T20:00:00')
    expect(nextNagAt({ policy: 'gentle', nagCount: 0, dueAtMillis: due, zone: ZONE, nowMillis: late })).toBe(late)
  })

  it('walks the gentle ladder: due -> +2h -> next morning -> stop', () => {
    const r1 = nextNagAt({ policy: 'gentle', nagCount: 1, dueAtMillis: due, zone: ZONE, nowMillis: now })
    const r2 = nextNagAt({ policy: 'gentle', nagCount: 2, dueAtMillis: due, zone: ZONE, nowMillis: due })
    expect(local(r1!)).toBe('2026-08-03 20:00')
    expect(local(r2!)).toBe('2026-08-04 09:00')
    expect(nextNagAt({ policy: 'gentle', nagCount: 3, dueAtMillis: due, zone: ZONE, nowMillis: now })).toBeNull()
  })

  it('walks the persistent ladder: due -> +30m -> +2h -> +6h -> daily', () => {
    const mk = (n: number): string =>
      local(nextNagAt({ policy: 'persistent', nagCount: n, dueAtMillis: due, zone: ZONE, nowMillis: due })!)
    expect(mk(1)).toBe('2026-08-03 18:30')
    expect(mk(2)).toBe('2026-08-03 20:00')
    expect(mk(3)).toBe('2026-08-04 00:00')
    expect(mk(4)).toBe('2026-08-04 09:00') // daily morning from here
  })

  it('stops pestering after MAX_NAGS even on persistent', () => {
    expect(
      nextNagAt({ policy: 'persistent', nagCount: MAX_NAGS, dueAtMillis: due, zone: ZONE, nowMillis: now }),
    ).toBeNull()
  })
})

describe('nextNagAt across a DST boundary', () => {
  // UK clocks go back 02:00 -> 01:00 on 2026-10-25. A morning rung computed by adding hours to a
  // UTC instant would land at 08:00 or 10:00 local; it must be 09:00 wall-clock.
  it('lands on 09:00 wall-clock the morning after the autumn change', () => {
    const due = at('2026-10-24T18:00:00')
    const next = nextNagAt({ policy: 'gentle', nagCount: 2, dueAtMillis: due, zone: ZONE, nowMillis: due })
    expect(local(next!)).toBe('2026-10-25 09:00')
  })

  it('lands on 09:00 wall-clock the morning after the spring change', () => {
    // Clocks go forward 01:00 -> 02:00 on 2026-03-29.
    const due = at('2026-03-28T18:00:00')
    const next = nextNagAt({ policy: 'gentle', nagCount: 2, dueAtMillis: due, zone: ZONE, nowMillis: due })
    expect(local(next!)).toBe('2026-03-29 09:00')
  })
})

describe('nextNagAt with quiet hours', () => {
  const due = at('2026-08-03T18:00:00')
  const now = at('2026-08-03T09:00:00')

  it('reproduces every existing expectation when quiet is undefined or null', () => {
    // The guard on the whole change: an omitted window must be byte-identical to the ladder as it
    // was before quiet hours existed, because four external schedulers reach it through here.
    const cases: Array<{ policy: 'gentle' | 'persistent'; nagCount: number; nowMillis: number }> = [
      { policy: 'gentle', nagCount: 0, nowMillis: now },
      { policy: 'gentle', nagCount: 0, nowMillis: at('2026-08-03T20:00:00') },
      { policy: 'gentle', nagCount: 1, nowMillis: now },
      { policy: 'gentle', nagCount: 2, nowMillis: due },
      { policy: 'gentle', nagCount: 3, nowMillis: now },
      { policy: 'persistent', nagCount: 1, nowMillis: due },
      { policy: 'persistent', nagCount: 2, nowMillis: due },
      { policy: 'persistent', nagCount: 3, nowMillis: due },
      { policy: 'persistent', nagCount: 4, nowMillis: due },
      { policy: 'persistent', nagCount: MAX_NAGS, nowMillis: now },
    ]
    for (const c of cases) {
      const bare = nextNagAt({ ...c, dueAtMillis: due, zone: ZONE })
      expect(nextNagAt({ ...c, dueAtMillis: due, zone: ZONE, quiet: undefined })).toBe(bare)
      expect(nextNagAt({ ...c, dueAtMillis: due, zone: ZONE, quiet: null })).toBe(bare)
    }
    // And the values themselves are still the ones the ladder tests above pin.
    expect(nextNagAt({ policy: 'gentle', nagCount: 0, dueAtMillis: due, zone: ZONE, nowMillis: now, quiet: null })).toBe(due)
  })

  it('leaves rung 0 exactly where the owner put it, even inside the window', () => {
    // A reminder due 23:30 nudges at 23:30. That instant IS the instruction; a global default that
    // silently moved it would make the whole feature read as broken rather than considerate.
    const lateDue = at('2026-08-03T23:30:00')
    const result = nextNagAt({
      policy: 'persistent',
      nagCount: 0,
      dueAtMillis: lateDue,
      zone: ZONE,
      nowMillis: now,
      quiet: NIGHT,
    })
    expect(local(result!)).toBe('2026-08-03 23:30')
  })

  it('defers rung 0 for an already-overdue reminder — that instant is ours, not theirs', () => {
    const lateDue = at('2026-08-03T21:00:00')
    const nowInWindow = at('2026-08-03T23:45:00')
    const result = nextNagAt({
      policy: 'persistent',
      nagCount: 0,
      dueAtMillis: lateDue,
      zone: ZONE,
      nowMillis: nowInWindow,
      quiet: NIGHT,
    })
    expect(local(result!)).toBe('2026-08-04 07:00')
  })

  it('moves the persistent 01:00 rung of a 23:00 reminder to 07:00', () => {
    // The exact scenario the feature exists for: due 23:00, +30m at 23:30, +2h at 01:00.
    const lateDue = at('2026-08-03T23:00:00')
    const r1 = nextNagAt({ policy: 'persistent', nagCount: 1, dueAtMillis: lateDue, zone: ZONE, nowMillis: lateDue, quiet: NIGHT })
    const r2 = nextNagAt({ policy: 'persistent', nagCount: 2, dueAtMillis: lateDue, zone: ZONE, nowMillis: lateDue, quiet: NIGHT })
    expect(local(r1!)).toBe('2026-08-04 07:00')
    expect(local(r2!)).toBe('2026-08-04 07:00')
  })

  it('leaves a rung that already falls outside the window untouched', () => {
    // Deferral is the identity outside the window, so the ordinary daytime ladder is unaffected.
    for (const nagCount of [1, 2, 3, 4]) {
      const quiet = nextNagAt({ policy: 'persistent', nagCount, dueAtMillis: due, zone: ZONE, nowMillis: due, quiet: NIGHT })
      const bare = nextNagAt({ policy: 'persistent', nagCount, dueAtMillis: due, zone: ZONE, nowMillis: due })
      if (nagCount === 3) {
        // due 18:00 + 6h = midnight, which IS inside 22:00–07:00 — the one that must move.
        expect(local(bare!)).toBe('2026-08-04 00:00')
        expect(local(quiet!)).toBe('2026-08-04 07:00')
      } else {
        expect(quiet).toBe(bare)
      }
    }
  })
})

describe('nudgeText', () => {
  it('escalates in wording rather than repeating itself', () => {
    const a = nudgeText('Take the bins out', 0)
    const b = nudgeText('Take the bins out', 1)
    const c = nudgeText('Take the bins out', 2)
    const d = nudgeText('Take the bins out', 5, 'due Mon, 3 Aug 2026, 18:00')
    expect(new Set([a, b, c, d]).size).toBe(4)
    expect(d).toContain('due Mon, 3 Aug 2026, 18:00')
  })
})
