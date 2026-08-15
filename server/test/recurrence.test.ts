import { DateTime } from 'luxon'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextOccurrence, parseRecurrence } from '../src/services/recurrence.js'

// Capture FCM sends (armAlarm pushes during the flow tests below).
const sent = vi.hoisted(() => [] as Array<{ token: string; data: Record<string, string> }>)
vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async (token: string, data: Record<string, string>) => {
    sent.push({ token, data })
    return { ok: true as const }
  }),
}))

import { ensureSchema } from '../src/db/client.js'
import { advanceRecurrence, armAlarm, cancelAlarm, getAlarm, listArmed } from '../src/services/alarms.js'
import { makeDevice } from './helpers.js'

const zone = 'Europe/London'
const at = (iso: string): number => DateTime.fromISO(iso, { zone }).toMillis()

describe('parseRecurrence', () => {
  it('accepts the supported subset', () => {
    expect(parseRecurrence('FREQ=DAILY')).toEqual({ freq: 'DAILY', interval: 1, byday: null })
    expect(parseRecurrence('freq=daily;interval=2')).toEqual({ freq: 'DAILY', interval: 2, byday: null })
    expect(parseRecurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toEqual({ freq: 'WEEKLY', interval: 1, byday: [1, 3, 5] })
    expect(parseRecurrence('FREQ=MONTHLY')).toEqual({ freq: 'MONTHLY', interval: 1, byday: null })
  })

  it('rejects everything else', () => {
    expect(parseRecurrence('')).toBeNull()
    expect(parseRecurrence('FREQ=YEARLY')).toBeNull()
    expect(parseRecurrence('FREQ=DAILY;BYDAY=MO')).toBeNull() // BYDAY is WEEKLY-only
    expect(parseRecurrence('FREQ=WEEKLY;BYDAY=MO;INTERVAL=2')).toBeNull() // BYDAY needs interval 1
    expect(parseRecurrence('FREQ=DAILY;INTERVAL=0')).toBeNull()
    expect(parseRecurrence('FREQ=DAILY;COUNT=3')).toBeNull() // unknown keys rejected, not ignored
    expect(parseRecurrence('BYDAY=MO')).toBeNull() // FREQ required
  })
})

describe('nextOccurrence', () => {
  it('daily advances one day at the same wall-clock time', () => {
    const prev = at('2026-07-01T07:00:00')
    expect(nextOccurrence('FREQ=DAILY', prev, zone, prev + 1)).toBe(at('2026-07-02T07:00:00'))
  })

  it('daily keeps wall-clock time across the DST spring-forward (23h absolute gap)', () => {
    const prev = at('2026-03-28T07:00:00') // day before BST starts (2026-03-29 in Europe/London)
    const next = nextOccurrence('FREQ=DAILY', prev, zone, prev + 1)
    expect(next).toBe(at('2026-03-29T07:00:00'))
    expect(next! - prev).toBe(23 * 3_600_000) // the clocks sprang forward — 7am is 23h later
  })

  it('daily with INTERVAL=2 skips a day', () => {
    const prev = at('2026-07-01T07:00:00')
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=2', prev, zone, prev + 1)).toBe(at('2026-07-03T07:00:00'))
  })

  it('weekly BYDAY picks the next listed weekday', () => {
    const prev = at('2026-07-06T08:00:00') // a Monday
    expect(nextOccurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR', prev, zone, prev + 1)).toBe(at('2026-07-08T08:00:00')) // Wednesday
  })

  it('monthly on the 31st skips months without a 31st', () => {
    const prev = at('2026-01-31T09:00:00')
    expect(nextOccurrence('FREQ=MONTHLY', prev, zone, prev + 1)).toBe(at('2026-03-31T09:00:00')) // February skipped
  })

  it('skips straight past occurrences the phone slept through', () => {
    const prev = at('2026-07-01T07:00:00')
    const now = at('2026-07-04T12:00:00') // three dailies missed
    expect(nextOccurrence('FREQ=DAILY', prev, zone, now)).toBe(at('2026-07-05T07:00:00'))
  })

  it('returns null for an invalid rule', () => {
    expect(nextOccurrence('FREQ=SOMETIMES', at('2026-07-01T07:00:00'), zone, 0)).toBeNull()
  })
})

describe('series advance flow', () => {
  beforeEach(() => {
    ensureSchema()
    sent.length = 0
  })

  it('advancing arms a new occurrence carrying the rule and retires the old row', async () => {
    const device = makeDevice('dev_rec1')
    const first = at('2026-07-01T07:00:00')
    await armAlarm(device, { alarmId: 'alm_rec1', triggerAtMillis: first, label: 'Morning', recurrence: 'FREQ=DAILY' })
    sent.length = 0

    const res = await advanceRecurrence('alm_rec1')
    expect(res.advanced).toBe(true)

    const old = getAlarm('alm_rec1')
    expect(old?.recurrence).toBeNull() // claimed — cannot double-advance
    const next = getAlarm(res.nextAlarmId!)
    expect(next?.recurrence).toBe('FREQ=DAILY')
    expect(next?.label).toBe('Morning')
    expect(next?.state).toBe('ARMED')
    expect(next?.triggerAtMillis).toBeGreaterThan(Date.now())
    // The new occurrence was pushed to the phone as a normal signed ARM.
    expect(sent.some((s) => s.data.type === 'ARM_ALARM' && s.data.alarmId === res.nextAlarmId)).toBe(true)
  })

  it('advances exactly once when event and backstop race', async () => {
    const device = makeDevice('dev_rec2')
    await armAlarm(device, {
      alarmId: 'alm_rec2',
      triggerAtMillis: at('2026-07-01T07:00:00'),
      label: 'X',
      recurrence: 'FREQ=DAILY',
    })
    const first = await advanceRecurrence('alm_rec2')
    const second = await advanceRecurrence('alm_rec2')
    expect(first.advanced).toBe(true)
    expect(second.advanced).toBe(false)
  })

  it('cancelling the pending occurrence ends the series', async () => {
    const device = makeDevice('dev_rec3')
    await armAlarm(device, {
      alarmId: 'alm_rec3',
      triggerAtMillis: Date.now() + 3_600_000,
      label: 'X',
      recurrence: 'FREQ=DAILY',
    })
    await cancelAlarm(device, 'alm_rec3')
    const res = await advanceRecurrence('alm_rec3')
    expect(res.advanced).toBe(false)
    expect(listArmed('dev_rec3')).toHaveLength(0)
  })
})
