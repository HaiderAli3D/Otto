import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { nextBriefRunAt, slotForRunAt } from '../src/lib/briefSchedule.js'
import type { DeviceSettings } from '../src/services/settings.js'

/**
 * Pure arithmetic, no database. The settings import is TYPE-ONLY and erases at compile time, so
 * nothing here touches SQLite — which is the point of keeping this module free of the DB.
 */
const settings = (over: Partial<DeviceSettings> = {}): DeviceSettings => ({
  deviceId: 'dev_bs',
  briefEnabled: true,
  briefHour: 7,
  briefMinute: 0,
  eveningBriefEnabled: false,
  eveningBriefHour: 21,
  eveningBriefMinute: 0,
  lastBriefAt: null,
  lastEveningBriefAt: null,
  quietHours: null,
  weeklyReviewAt: null,
  lastWeeklyReviewAt: null,
  autoWakeAlarm: false,
  autoLeaveByAlarm: false,
  defaultTravelMinutes: 30,
  getReadyMinutes: 45,
  updatedAt: 0,
  ...over,
})

const LONDON = 'Europe/London'

/** An instant from a local wall-clock time in a zone. */
const at = (iso: string, zone = LONDON): number => DateTime.fromISO(iso, { zone }).toMillis()

/** The local wall-clock time an instant lands at, as "HH:mm". */
const localTime = (ms: number, zone = LONDON): string => DateTime.fromMillis(ms, { zone }).toFormat('HH:mm')

const localDate = (ms: number, zone = LONDON): string => DateTime.fromMillis(ms, { zone }).toISODate()!

describe('nextBriefRunAt', () => {
  it('keeps 07:00 local across the Europe/London spring-forward, with no hour drift', () => {
    // The bug this exists for: "now + 24h" is an hour wrong twice a year. The clocks go forward at
    // 01:00 on Sunday 29 March 2026, so the gap between Saturday's 07:00 and Sunday's is 23 REAL
    // hours — and it is the wall clock, not the elapsed time, that has to stay put.
    const saturday = at('2026-03-28T07:00:00')
    const next = nextBriefRunAt(settings(), LONDON, saturday)

    expect(localTime(next)).toBe('07:00')
    expect(localDate(next)).toBe('2026-03-29')
    expect(next - saturday).toBe(23 * 3_600_000)
  })

  it('keeps 07:00 local across the autumn fall-back too', () => {
    // The other side of the same coin: 25 October 2026 is 25 real hours long.
    const saturday = at('2026-10-24T07:00:00')
    const next = nextBriefRunAt(settings(), LONDON, saturday)

    expect(localTime(next)).toBe('07:00')
    expect(next - saturday).toBe(25 * 3_600_000)
  })

  it('returns TOMORROW when called exactly on the boundary', () => {
    // Strictly-after is load-bearing: the handler settles the row from `now`, which is a few
    // milliseconds past its own scheduled instant at best and exactly on it at worst. A `>=` here
    // would re-fire the same brief in a tight loop for the rest of the day.
    const boundary = at('2026-08-03T07:00:00')
    const next = nextBriefRunAt(settings(), LONDON, boundary)

    expect(localDate(next)).toBe('2026-08-04')
    expect(localTime(next)).toBe('07:00')
  })

  it('picks the nearer of the two enabled slots, in both directions', () => {
    const both = settings({ eveningBriefEnabled: true })

    // Mid-morning: tonight's 21:00 is nearer than tomorrow's 07:00.
    const midMorning = nextBriefRunAt(both, LONDON, at('2026-08-03T09:00:00'))
    expect(localTime(midMorning)).toBe('21:00')
    expect(localDate(midMorning)).toBe('2026-08-03')

    // Late evening: 21:00 has gone, so tomorrow's 07:00 wins.
    const lateEvening = nextBriefRunAt(both, LONDON, at('2026-08-03T22:30:00'))
    expect(localTime(lateEvening)).toBe('07:00')
    expect(localDate(lateEvening)).toBe('2026-08-04')
  })

  it('ignores a slot that is switched off', () => {
    const eveningOnly = settings({ briefEnabled: false, eveningBriefEnabled: true })
    expect(localTime(nextBriefRunAt(eveningOnly, LONDON, at('2026-08-03T09:00:00')))).toBe('21:00')

    const morningOnly = settings({ eveningBriefEnabled: false })
    // 21:00 is nearer in wall-clock terms, but the evening brief is off — so tomorrow morning it is.
    expect(localTime(nextBriefRunAt(morningOnly, LONDON, at('2026-08-03T09:00:00')))).toBe('07:00')
  })

  it('still returns a valid future instant with BOTH slots disabled', () => {
    // The job row IS the chain. Ending it here would mean re-seeding on every settings change, and
    // any path that forgot is a feature that silently never comes back.
    const now = at('2026-08-03T09:00:00')
    const next = nextBriefRunAt(settings({ briefEnabled: false, eveningBriefEnabled: false }), LONDON, now)

    expect(next).toBeGreaterThan(now)
    expect(Number.isFinite(next)).toBe(true)
    expect(localTime(next)).toBe('07:00')
  })

  it('honours the minute, not just the hour', () => {
    const s = settings({ briefHour: 6, briefMinute: 30 })
    expect(localTime(nextBriefRunAt(s, LONDON, at('2026-08-03T05:00:00')))).toBe('06:30')
  })
})

describe('slotForRunAt', () => {
  const both = settings({ eveningBriefEnabled: true })

  it('reads the slot off the scheduled instant, so the handler needs no payload', () => {
    expect(slotForRunAt(both, LONDON, at('2026-08-03T07:00:00'))).toBe('morning')
    expect(slotForRunAt(both, LONDON, at('2026-08-03T21:00:00'))).toBe('evening')
  })

  it('is null at an instant that is neither boundary', () => {
    // Normal, not an error: the owner moved their brief and the pending row still points at the old
    // time. The handler says nothing today and advances the chain to the new one.
    expect(slotForRunAt(both, LONDON, at('2026-08-03T12:00:00'))).toBeNull()
  })

  it('is null for a disabled slot even at exactly its configured time', () => {
    expect(slotForRunAt(settings(), LONDON, at('2026-08-03T21:00:00'))).toBeNull()
    expect(slotForRunAt(settings({ briefEnabled: false }), LONDON, at('2026-08-03T07:00:00'))).toBeNull()
  })

  it('resolves a clash to morning', () => {
    const clash = settings({ eveningBriefEnabled: true, eveningBriefHour: 7, eveningBriefMinute: 0 })
    expect(slotForRunAt(clash, LONDON, at('2026-08-03T07:00:00'))).toBe('morning')
  })

  it('agrees with nextBriefRunAt — every instant it schedules is a slot it recognises', () => {
    // The pairing that makes the no-payload design safe. If these two ever disagreed, the chain
    // would keep running and the brief would never be sent.
    let now = at('2026-03-27T05:00:00')
    for (let i = 0; i < 10; i++) {
      const next = nextBriefRunAt(both, LONDON, now)
      expect(slotForRunAt(both, LONDON, next)).not.toBeNull()
      now = next
    }
  })

  it('recognises a brief scheduled INTO the spring-forward gap', () => {
    // London jumps 01:00 → 02:00 on 28 March 2027, so a brief set for 01:00 has no instant that day.
    // luxon resolves the nonexistent local time forward and the row is scheduled at 02:00, which is
    // the only instant it could be. Comparing the raw wall clock against 01:00 read hour 2, matched
    // neither boundary, and skipped the brief for the day — one lost brief a year, silently.
    const one = settings({ briefHour: 1, briefMinute: 0 })
    const next = nextBriefRunAt(one, LONDON, at('2027-03-27T05:00:00'))

    expect(localDate(next)).toBe('2027-03-28')
    expect(localTime(next)).toBe('02:00')
    expect(slotForRunAt(one, LONDON, next)).toBe('morning')
  })

  it('agrees with nextBriefRunAt across the DST gap too, for every minute in it', () => {
    // The general form of the claim the loop above only tested at 07:00. Every minute of the missing
    // hour is a settings value the owner can pick, and each one has to survive the round trip.
    for (const minute of [0, 15, 30, 45]) {
      const s = settings({ briefHour: 1, briefMinute: minute })
      let now = at('2027-03-26T05:00:00')
      for (let i = 0; i < 4; i++) {
        const next = nextBriefRunAt(s, LONDON, now)
        expect(slotForRunAt(s, LONDON, next)).toBe('morning')
        now = next
      }
    }
  })

  it('is no stricter about the minute than it was', () => {
    // The DST fix must not quietly tighten the check into "to the millisecond": a stray second on a
    // row would then cost a whole day's brief, which is a worse bug than the one being fixed.
    expect(slotForRunAt(both, LONDON, at('2026-08-03T07:00:30'))).toBe('morning')
    expect(slotForRunAt(both, LONDON, at('2026-08-03T06:59:00'))).toBeNull()
  })
})
