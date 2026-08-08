import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { MAX_NAGS, nextNagAt, nudgeText, nudgeTextFor } from '../src/lib/nagLadder.js'
import { parseQuietHours } from '../src/lib/quietHours.js'
import { parseRoutine } from '../src/lib/routine.js'
import { tableFor, type NagPolicy, type TimingKind } from '../src/lib/rungPlan.js'

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

  it('does NOT collapse the rungs it defers onto one instant', () => {
    // Rungs 1–3 are offsets from the DUE time, so a window that contains several of them defers
    // them all to the same window end. runNudge recomputes the next rung at the moment the current
    // one fires, so the collapse shows up as three chases inside two scheduler ticks — which is
    // what the floor measured from `nowMillis` exists to stop.
    const lateDue = at('2026-08-03T23:00:00')
    const windowEnd = at('2026-08-04T07:00:00')

    // Rung 1 fires at the window end; rung 2 is computed right then, and rung 3 when rung 2 fires.
    const r2 = nextNagAt({ policy: 'persistent', nagCount: 2, dueAtMillis: lateDue, zone: ZONE, nowMillis: windowEnd, quiet: NIGHT })
    const r3 = nextNagAt({ policy: 'persistent', nagCount: 3, dueAtMillis: lateDue, zone: ZONE, nowMillis: r2!, quiet: NIGHT })

    expect(local(r2!)).toBe('2026-08-04 07:30')
    expect(local(r3!)).toBe('2026-08-04 08:00')
  })

  it('never floors a rung back INTO the window it just cleared', () => {
    // The floor is applied before the deferral, not after. A rung landing at 21:55 with the window
    // opening at 22:00 is outside it — nudging it half an hour forward for spacing would put it at
    // 22:25, inside. Order of operations, pinned.
    const due = at('2026-08-03T19:55:00')
    const now = at('2026-08-03T21:50:00')
    const next = nextNagAt({ policy: 'persistent', nagCount: 2, dueAtMillis: due, zone: ZONE, nowMillis: now, quiet: NIGHT })
    expect(local(next!)).toBe('2026-08-04 07:00')
  })

  it('never returns a rung in the past for a reminder that was already badly overdue', () => {
    // Same anchoring, no quiet hours needed: a reminder created eleven hours after its due time has
    // `due + 30m` behind it. runNudge would enqueue that, then retire it unsent on the staleness
    // gate — the ladder would go silent after a single nudge.
    const staleDue = at('2026-08-03T09:00:00')
    const now = at('2026-08-03T20:00:00')
    for (const nagCount of [1, 2, 3]) {
      const next = nextNagAt({ policy: 'persistent', nagCount, dueAtMillis: staleDue, zone: ZONE, nowMillis: now })
      expect(next).toBeGreaterThan(now)
    }
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

describe('walking every ladder the way runNudge walks it', () => {
  /**
   * The single most valuable test in this module.
   *
   * `runNudge` re-enters `nextNagAt` at the moment each rung fires, feeding the previous result
   * back as `nowMillis` — so a ladder that looks fine when the clock is held still can still walk
   * backwards, stall, or run forever in production. This drives all twelve (kind × intensity)
   * pairs the way the scheduler actually does and asserts the four properties that make a ladder
   * safe: it terminates, it never goes backwards, it never schedules the past, and it respects its
   * own post-due ceiling.
   */
  const KINDS: TimingKind[] = ['deadline', 'appointment', 'trigger']
  const POLICIES: NagPolicy[] = ['gentle', 'persistent', 'hard', 'relentless']

  for (const kind of KINDS) {
    for (const policy of POLICIES) {
      it(`${kind} × ${policy} terminates and never goes backwards`, () => {
        const due = at('2026-08-20T12:00:00')
        const planned = at('2026-07-20T12:00:00') // a month of run-up, so no lead rung is pruned
        let now = planned
        const fired: number[] = []

        for (let nagCount = 0; nagCount < 100; nagCount++) {
          const next = nextNagAt({ policy, nagCount, dueAtMillis: due, zone: ZONE, nowMillis: now, kind, plannedAtMillis: planned })
          if (next === null) break
          expect(next, `${kind}/${policy} rung ${nagCount} landed in the past`).toBeGreaterThanOrEqual(now)
          if (fired.length > 0) {
            expect(next, `${kind}/${policy} rung ${nagCount} went backwards`).toBeGreaterThanOrEqual(fired.at(-1)!)
          }
          fired.push(next)
          now = next
        }

        expect(fired.length, `${kind}/${policy} never terminated`).toBeLessThan(100)
        expect(fired.length, `${kind}/${policy} says nothing at all`).toBeGreaterThan(0)

        const table = tableFor(kind, policy as Exclude<NagPolicy, 'off'>)
        const postDue = fired.filter((ms) => ms >= due).length
        expect(postDue, `${kind}/${policy} exceeded its own maxChases`).toBeLessThanOrEqual(table.maxChases)
        // A deadline that warned nobody in a month of run-up is the feature not working at all.
        if (kind === 'deadline') expect(fired.filter((ms) => ms < due).length).toBeGreaterThan(0)
        if (kind === 'trigger') expect(fired.filter((ms) => ms < due).length).toBe(0)
      })
    }
  }
})

describe('nextNagAt with lead rungs', () => {
  const due = at('2026-08-20T12:00:00')
  const planned = at('2026-07-20T12:00:00')
  const deadline = { policy: 'persistent' as const, dueAtMillis: due, zone: ZONE, kind: 'deadline' as const, plannedAtMillis: planned }

  it('starts a deadline in its run-up, days before anything is late', () => {
    const first = nextNagAt({ ...deadline, nagCount: 0, nowMillis: planned })!
    expect(first).toBeLessThan(due)
    expect(local(first)).toBe('2026-08-17 12:00') // three days before
  })

  it('lands rung `leadCount` exactly ON the due instant, undeferred even inside quiet hours', () => {
    // The owner's-own-instant exemption keys on the OFFSET being zero, not the INDEX. With five
    // lead rungs the due instant sits at index 5, and checking for index 0 would silently withdraw
    // the exemption from exactly the reminders that warn hardest.
    const lateDue = at('2026-08-20T23:30:00')
    const leadCount = 5 // persistent deadline: 3d, 1d, 4h, 1h, 20m
    const rung = nextNagAt({
      ...deadline,
      dueAtMillis: lateDue,
      nagCount: leadCount,
      nowMillis: lateDue - 20 * 60_000,
      quiet: NIGHT,
    })
    expect(rung).toBe(lateDue)
  })

  it('prunes every warning when the deadline is set minutes before it lands', () => {
    // Rung 0 is then the due instant itself, and it is still the owner's own chosen time.
    const soon = at('2026-08-20T12:00:00')
    const first = nextNagAt({ ...deadline, nagCount: 0, plannedAtMillis: soon - 5 * 60_000, nowMillis: soon - 5 * 60_000 })
    expect(first).toBe(soon)
  })

  it('gives an appointment a warning before and a check after, then stops', () => {
    const appt = { policy: 'persistent' as const, dueAtMillis: due, zone: ZONE, kind: 'appointment' as const, plannedAtMillis: planned }
    let now = planned
    const fired: number[] = []
    for (let n = 0; n < 20; n++) {
      const next = nextNagAt({ ...appt, nagCount: n, nowMillis: now })
      if (next === null) break
      fired.push(next)
      now = next
    }
    expect(fired.filter((ms) => ms < due).length).toBe(3) // 2h, 30m, 10m before
    expect(fired.filter((ms) => ms > due).length).toBe(2) // +10m, +30m
    // And then it is genuinely over — no daily tail dragging an attended appointment through a week.
    expect(fired.at(-1)!).toBeLessThan(due + 60 * 60_000)
  })

  it('puts the daily tail on the owner’s own morning rather than a hardcoded 09:00', () => {
    const routine = parseRoutine('02:00-04:00', '10:00-14:00')!
    const tail = nextNagAt({
      policy: 'persistent',
      nagCount: 4,
      dueAtMillis: at('2026-08-03T18:00:00'),
      zone: ZONE,
      nowMillis: at('2026-08-03T18:00:00'),
      routine,
    })
    expect(local(tail!)).toBe('2026-08-04 14:00')
  })

  it('keeps the daily tail on wall-clock across a DST change for a non-default routine', () => {
    const routine = parseRoutine('02:00-04:00', '10:00-14:00')!
    const due = at('2026-10-24T18:00:00')
    const tail = nextNagAt({ policy: 'persistent', nagCount: 4, dueAtMillis: due, zone: ZONE, nowMillis: due, routine })
    expect(local(tail!)).toBe('2026-10-25 14:00')
  })
})

describe('nudgeTextFor', () => {
  it('never scolds in the run-up — nothing is late yet', () => {
    // A warning three hours before a deadline that reads like a chase teaches the owner to ignore
    // the ones that aren't.
    for (const index of [0, 1, 2, 5]) {
      const text = nudgeTextFor({ title: 'File the tax return', phase: 'lead', index })
      expect(text).not.toMatch(/still|outstanding|drop it/i)
    }
  })

  it('reproduces nudgeText exactly, which is what the fallback path depends on', () => {
    expect(nudgeText('Take the bins out', 0)).toBe(nudgeTextFor({ title: 'Take the bins out', phase: 'due', index: 0 }))
    for (const n of [1, 2, 3, 7]) {
      expect(nudgeText('Take the bins out', n, 'due Mon')).toBe(
        nudgeTextFor({ title: 'Take the bins out', phase: 'overdue', index: n - 1, overdueDescription: 'due Mon' }),
      )
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
