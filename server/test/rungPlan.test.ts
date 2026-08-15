import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import {
  MAX_EXPLICIT_CHASE,
  MAX_EXPLICIT_LEAD,
  MAX_OFFSET_MINUTES,
  MIN_LEAD_GAP_MS,
  NAG_POLICIES,
  TIMING_KINDS,
  isNagPolicy,
  isTimingKind,
  normaliseOffsets,
  parseNagPlan,
  planRungs,
  serializeNagPlan,
  tableFor,
  tightestGap,
  type NagPolicy,
  type TimingKind,
} from '../src/lib/rungPlan.js'

const ZONE = 'Europe/London'
const at = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis()
const local = (ms: number): string => DateTime.fromMillis(ms, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const INTENSITIES = NAG_POLICIES.filter((p): p is Exclude<NagPolicy, 'off'> => p !== 'off')

describe('the guards', () => {
  it('recognises exactly the kinds and policies it declares', () => {
    for (const k of TIMING_KINDS) expect(isTimingKind(k)).toBe(true)
    for (const p of NAG_POLICIES) expect(isNagPolicy(p)).toBe(true)
    for (const junk of ['deadlines', 'DEADLINE', '', null, 3, undefined]) {
      expect(isTimingKind(junk)).toBe(false)
      expect(isNagPolicy(junk)).toBe(false)
    }
  })
})

describe('the tables themselves', () => {
  it('gives every kind x intensity pair a usable ladder', () => {
    for (const kind of TIMING_KINDS) {
      for (const policy of INTENSITIES) {
        const t = tableFor(kind, policy)
        expect(t.chase.length, `${kind}/${policy} must chase at least once`).toBeGreaterThan(0)
        expect(t.chase[0], `${kind}/${policy} must have a rung at the due instant`).toBe(0)
        expect(t.maxChases, `${kind}/${policy} maxChases must cover its own chase list`).toBeGreaterThanOrEqual(
          t.chase.length,
        )
      }
    }
  })

  it('never gives a trigger a lead rung, at any intensity', () => {
    // "Remind me at 4" means say nothing until 4. A lead rung here would make it start at 3.
    for (const policy of INTENSITIES) expect(tableFor('trigger', policy).lead).toEqual([])
  })

  it('stops rather than going daily for every appointment intensity', () => {
    // An appointment an hour gone is the past; chasing the past daily is what `deadline` is for.
    for (const policy of INTENSITIES) expect(tableFor('appointment', policy).tail).toBe('stop')
  })

  it('gets louder as the intensity rises, within each kind', () => {
    for (const kind of TIMING_KINDS) {
      const totals = INTENSITIES.map((p) => {
        const t = tableFor(kind, p)
        return t.lead.length + t.maxChases
      })
      for (let i = 1; i < totals.length; i++) {
        expect(totals[i], `${kind}: ${INTENSITIES[i]} must not be quieter than ${INTENSITIES[i - 1]}`).toBeGreaterThan(
          totals[i - 1]!,
        )
      }
    }
  })

  it('orders lead offsets furthest-first so they read as a countdown', () => {
    const due = at('2026-08-20T12:00:00')
    for (const kind of TIMING_KINDS) {
      for (const policy of INTENSITIES) {
        const plan = planRungs({ kind, policy, dueAtMillis: due, plannedAtMillis: at('2026-07-01T12:00:00'), zone: ZONE })
        const sorted = [...plan.leadAt].sort((a, b) => a - b)
        expect(plan.leadAt, `${kind}/${policy}`).toEqual(sorted)
      }
    }
  })
})

describe('tightestGap', () => {
  it('reports the closest two rungs any ladder asks for', () => {
    const due = at('2026-08-20T12:00:00')
    const planned = at('2026-07-20T12:00:00')
    // appointment/persistent: lead 2h, 30m, 10m then chase 0, +10m, +30m. The tightest is 10m.
    const plan = planRungs({ kind: 'appointment', policy: 'persistent', dueAtMillis: due, plannedAtMillis: planned, zone: ZONE })
    expect(tightestGap(plan, due)).toBe(10 * MINUTE)
  })

  it('is what stops the spacing floor rewriting a table it was only meant to protect', () => {
    // The bug this exists for: `persistent`'s nominal 30-minute floor is WIDER than the appointment
    // ladder's own 20-minute lead gaps, so the last warning was shunted forward onto the due
    // instant and the owner got "heads up" and "it's now" in the same breath. Any table row whose
    // rungs are tighter than its policy's nominal spacing must report it here.
    const due = at('2026-08-20T12:00:00')
    const planned = at('2026-07-20T12:00:00')
    for (const kind of TIMING_KINDS) {
      for (const policy of INTENSITIES) {
        const plan = planRungs({ kind, policy, dueAtMillis: due, plannedAtMillis: planned, zone: ZONE })
        expect(tightestGap(plan, due), `${kind}/${policy} has coincident rungs`).toBeGreaterThan(0)
      }
    }
  })

  it('is Infinity for a ladder with a single rung, so callers keep their own default', () => {
    const due = at('2026-08-20T12:00:00')
    const plan = planRungs({
      kind: 'trigger',
      policy: 'gentle',
      dueAtMillis: due,
      plannedAtMillis: due,
      zone: ZONE,
      override: { chaseMinutes: [0] },
    })
    expect(tightestGap(plan, due)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('lead pruning', () => {
  const due = at('2026-08-20T12:00:00')

  it('keeps every warning when there is a long run-up', () => {
    const plan = planRungs({
      kind: 'deadline',
      policy: 'hard',
      dueAtMillis: due,
      plannedAtMillis: at('2026-07-01T12:00:00'),
      zone: ZONE,
    })
    expect(plan.leadAt).toHaveLength(tableFor('deadline', 'hard').lead.length)
    expect(plan.droppedAsTooLate).toBe(0)
  })

  it('drops the ones already gone by when the deadline is set late', () => {
    // 40 minutes of run-up: only the -30m and -10m rungs of `hard` can still happen.
    const plan = planRungs({
      kind: 'deadline',
      policy: 'hard',
      dueAtMillis: due,
      plannedAtMillis: due - 40 * MINUTE,
      zone: ZONE,
    })
    expect(plan.leadAt.map(local)).toEqual(['2026-08-20 11:30', '2026-08-20 11:50'])
    expect(plan.droppedAsTooLate).toBe(6)
  })

  it('keeps nothing at all when the deadline is minutes away', () => {
    const plan = planRungs({
      kind: 'deadline',
      policy: 'relentless',
      dueAtMillis: due,
      plannedAtMillis: due - 5 * MINUTE,
      zone: ZONE,
    })
    expect(plan.leadAt).toEqual([])
  })

  it('will not schedule a warning inside MIN_LEAD_GAP_MS of the planning moment', () => {
    // Otherwise the owner reads a "heads up" seconds after asking for the reminder, which reads as
    // a bug rather than a warning.
    const plan = planRungs({
      kind: 'deadline',
      policy: 'relentless',
      dueAtMillis: due,
      plannedAtMillis: due - 20 * MINUTE,
      zone: ZONE,
    })
    for (const rung of plan.leadAt) expect(rung - (due - 20 * MINUTE)).toBeGreaterThanOrEqual(MIN_LEAD_GAP_MS)
  })

  it('prunes against plannedAtMillis, never against a moving clock', () => {
    // The determinism guarantee. `nextNagAt` re-enters this on every rung fire with a fresh clock;
    // if the prune moved with it, the nagCount -> rung mapping would shift under the ladder and
    // rungs would be silently revisited or skipped.
    const planned = at('2026-07-01T12:00:00')
    const first = planRungs({ kind: 'deadline', policy: 'hard', dueAtMillis: due, plannedAtMillis: planned, zone: ZONE })
    const later = planRungs({ kind: 'deadline', policy: 'hard', dueAtMillis: due, plannedAtMillis: planned, zone: ZONE })
    expect(later.leadAt).toEqual(first.leadAt)
  })
})

describe('DST', () => {
  // UK clocks go back 02:00 -> 01:00 on 2026-10-25 and forward 01:00 -> 02:00 on 2026-03-29.
  // A "day before" expressed in milliseconds is 23 or 25 wall-clock hours across those nights, so a
  // heads-up for a 09:00 Monday deadline would land at 08:00 or 10:00 on the Sunday.
  it('lands a day-before warning on the same wall clock across the autumn change', () => {
    const due = at('2026-10-26T09:00:00')
    const plan = planRungs({
      kind: 'deadline',
      policy: 'gentle',
      dueAtMillis: due,
      plannedAtMillis: at('2026-10-01T09:00:00'),
      zone: ZONE,
    })
    expect(local(plan.leadAt[0]!)).toBe('2026-10-25 09:00')
  })

  it('lands a day-before warning on the same wall clock across the spring change', () => {
    const due = at('2026-03-30T09:00:00')
    const plan = planRungs({
      kind: 'deadline',
      policy: 'gentle',
      dueAtMillis: due,
      plannedAtMillis: at('2026-03-01T09:00:00'),
      zone: ZONE,
    })
    expect(local(plan.leadAt[0]!)).toBe('2026-03-29 09:00')
  })

  it('is the DIFFERENCE between a calendar day and 24h of milliseconds that matters', () => {
    // The contrast the Offset union exists for, asserted directly. A day-before warning for a 12:00
    // deadline must read 12:00; the same offset as 24h of milliseconds lands an hour out, because
    // the day it steps back across is 25 hours long. Someone "simplifying" {daysBefore} into a
    // constant would make this the first test to go red.
    for (const [dueIso, calendarDay, millisecondDay] of [
      ['2026-10-25T12:00:00', '2026-10-24 12:00', '2026-10-24 13:00'], // clocks go back
      ['2026-03-29T12:00:00', '2026-03-28 12:00', '2026-03-28 11:00'], // clocks go forward
    ] as const) {
      const due = at(dueIso)
      const plan = planRungs({
        kind: 'deadline',
        policy: 'gentle',
        dueAtMillis: due,
        plannedAtMillis: due - 30 * 24 * HOUR,
        zone: ZONE,
      })
      expect(local(plan.leadAt[0]!)).toBe(calendarDay)
      expect(local(due - 24 * HOUR)).toBe(millisecondDay)
      expect(plan.leadAt[0]).not.toBe(due - 24 * HOUR)
    }
  })

  it('keeps sub-day offsets as elapsed hours, which is what "two hours before" means', () => {
    // No divergence to see when both instants sit on the same side of the changeover, and that is
    // correct — "two hours before 09:00" on that morning is 07:00, because the clocks moved at 02:00.
    const due = at('2026-10-25T09:00:00')
    const plan = planRungs({
      kind: 'deadline',
      policy: 'gentle',
      dueAtMillis: due,
      plannedAtMillis: at('2026-10-01T09:00:00'),
      zone: ZONE,
    })
    const twoHourRung = plan.leadAt.find((ms) => ms === due - 2 * HOUR)
    expect(twoHourRung).toBeDefined()
    expect(local(twoHourRung!)).toBe('2026-10-25 07:00')
  })
})

describe('explicit offsets', () => {
  it('accepts a plain ascending list and orders each direction sensibly', () => {
    const lead = normaliseOffsets('leadMinutes', [10, 1440, 60], 'lead')
    const chase = normaliseOffsets('chaseMinutes', [60, 0, 15], 'chase')
    expect(lead.ok && lead.minutes).toEqual([1440, 60, 10]) // furthest first: a countdown
    expect(chase.ok && chase.minutes).toEqual([0, 15, 60]) // nearest first: an escalation
  })

  it('rejects the whole call, naming the field, rather than half-applying', () => {
    // Same rule setPreferences uses. A partially-applied schedule is worse than none: the owner is
    // told their instruction landed and only some of it did.
    for (const bad of [[-5], [1.5], [Number.NaN], ['ten'], [null]]) {
      const res = normaliseOffsets('leadMinutes', bad, 'lead')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('leadMinutes[0]')
    }
    expect(normaliseOffsets('leadMinutes', 'nope', 'lead').ok).toBe(false)
  })

  it('clamps an absurd offset and says how many it clamped', () => {
    const res = normaliseOffsets('leadMinutes', [MAX_OFFSET_MINUTES + 1, 60], 'lead')
    expect(res.ok && res.minutes).toEqual([MAX_OFFSET_MINUTES, 60])
    expect(res.ok && res.clamped).toBe(1)
  })

  it('dedupes rather than scheduling the same instant twice', () => {
    const res = normaliseOffsets('chaseMinutes', [0, 15, 15, 0], 'chase')
    expect(res.ok && res.minutes).toEqual([0, 15])
  })

  it('caps by keeping the entries NEAREST the due time', () => {
    // A capped ladder that dropped its closest warnings would keep only the ones far enough out to
    // have been forgotten.
    const many = Array.from({ length: MAX_EXPLICIT_LEAD + 5 }, (_, i) => (i + 1) * 60)
    const res = normaliseOffsets('leadMinutes', many, 'lead')
    expect(res.ok && res.minutes).toHaveLength(MAX_EXPLICIT_LEAD)
    expect(res.ok && res.droppedForCount).toBe(5)
    expect(res.ok && Math.min(...res.minutes)).toBe(60)

    const manyChase = Array.from({ length: MAX_EXPLICIT_CHASE + 2 }, (_, i) => i * 30)
    const chase = normaliseOffsets('chaseMinutes', manyChase, 'chase')
    expect(chase.ok && chase.minutes).toHaveLength(MAX_EXPLICIT_CHASE)
    expect(chase.ok && chase.minutes[0]).toBe(0)
  })

  it('overrides the table when planned, and composes one direction with the other', () => {
    const due = at('2026-08-20T12:00:00')
    const planned = at('2026-08-01T12:00:00')
    const leadOnly = planRungs({
      kind: 'deadline',
      policy: 'gentle',
      dueAtMillis: due,
      plannedAtMillis: planned,
      zone: ZONE,
      override: { leadMinutes: [120, 30] },
    })
    expect(leadOnly.leadAt.map(local)).toEqual(['2026-08-20 10:00', '2026-08-20 11:30'])
    // The chase half still comes from the table — supplying one array must not blank the other.
    expect(leadOnly.chase).toEqual(tableFor('deadline', 'gentle').chase)
  })

  it('stops after an explicit chase list unless keepChasingDaily is set', () => {
    const due = at('2026-08-20T12:00:00')
    const base = { kind: 'trigger' as TimingKind, policy: 'gentle' as NagPolicy, dueAtMillis: due, plannedAtMillis: due, zone: ZONE }
    const stops = planRungs({ ...base, override: { chaseMinutes: [0, 30] } })
    expect(stops.tail).toBe('stop')
    expect(stops.maxChases).toBe(2)

    const daily = planRungs({ ...base, override: { chaseMinutes: [0, 30], keepChasingDaily: true } })
    expect(daily.tail).toBe('daily')
    expect(daily.maxChases).toBeGreaterThan(2)
  })

  it('ignores an explicit lead on a trigger, which by definition says nothing beforehand', () => {
    const due = at('2026-08-20T12:00:00')
    const plan = planRungs({
      kind: 'trigger',
      policy: 'gentle',
      dueAtMillis: due,
      plannedAtMillis: at('2026-08-01T12:00:00'),
      zone: ZONE,
      override: { leadMinutes: [120, 30] },
    })
    expect(plan.leadAt).toEqual([])
  })
})

describe('parseNagPlan', () => {
  it('round-trips what serializeNagPlan wrote', () => {
    const spec = { leadMinutes: [1440, 60], chaseMinutes: [0, 30], keepChasingDaily: true }
    expect(parseNagPlan(serializeNagPlan(spec))).toEqual(spec)
  })

  it('degrades to "use the table" on anything unexpected, and never throws', () => {
    // Same 3am-safe contract as parseQuietHours. A row corrupted by a bad write must not take down
    // whichever scheduler tick touched it — a throw here stops that reminder's chain permanently.
    for (const junk of ['', 'null', '{', '[]', '{"leadMinutes":"soon"}', '{"leadMinutes":[-1]}', '{}', null, undefined]) {
      expect(() => parseNagPlan(junk)).not.toThrow()
      expect(parseNagPlan(junk)).toBeNull()
    }
  })
})
