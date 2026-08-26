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
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { jobs } from '../src/db/schema.js'
import { advanceRecurrence, armAlarm, cancelAlarm, getAlarm, listArmed, recordEvent } from '../src/services/alarms.js'
import { getDevice, setTimezone } from '../src/services/devices.js'
import { makeDevice } from './helpers.js'

const ZONE = 'Europe/London'
const recurringJobs = (alarmId: string) =>
  db.select().from(jobs).where(and(eq(jobs.kind, 'recurring'), eq(jobs.alarmId, alarmId))).all()

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

describe('the series anchor survives what the phone reports', () => {
  beforeEach(() => {
    ensureSchema()
    sent.length = 0
  })

  /**
   * The defect this column exists for. `recordEvent` adopts the phone's own trigger on ARMED so a
   * later SYNC lists the alarm at its real time, and after a snooze that is the snoozed instant.
   * `advanceRecurrence` used to read the same column as the series anchor, so every occurrence
   * re-anchored on the last snooze and a daily 06:30 walked to 07:33 inside a week.
   */
  it('does not drift when the owner snoozes every morning for a week', async () => {
    const device = makeDevice('dev_drift')
    setTimezone(device.deviceId, ZONE)
    const start = DateTime.fromISO('2026-09-01T06:30', { zone: ZONE }).toMillis()

    let alarmId = 'alm_drift'
    await armAlarm(getDevice(device.deviceId)!, {
      alarmId,
      triggerAtMillis: start,
      label: 'Wake up',
      recurrence: 'FREQ=DAILY',
    })

    const rung: string[] = []
    for (let day = 0; day < 7; day++) {
      const alarm = getAlarm(alarmId)!
      rung.push(DateTime.fromMillis(alarm.triggerAtMillis, { zone: ZONE }).toFormat('HH:mm'))
      // Nine minutes of snooze, reported exactly as the app reports it.
      const snoozed = alarm.triggerAtMillis + 9 * 60_000
      recordEvent(device.deviceId, alarmId, 'ARMED', snoozed, '1.1.0', snoozed)
      const res = await advanceRecurrence(alarmId)
      expect(res.advanced).toBe(true)
      alarmId = res.nextAlarmId!
    }

    expect(rung).toEqual(['06:30', '06:30', '06:30', '06:30', '06:30', '06:30', '06:30'])
  })

  it('still lets the phone move THIS occurrence, which is what the adoption is for', async () => {
    // The fix must not turn the adoption off — a SYNC has to list the alarm where it really is.
    const device = makeDevice('dev_adopt')
    setTimezone(device.deviceId, ZONE)
    const start = DateTime.fromISO('2026-09-01T06:30', { zone: ZONE }).toMillis()
    await armAlarm(getDevice(device.deviceId)!, {
      alarmId: 'alm_adopt',
      triggerAtMillis: start,
      label: 'Wake up',
      recurrence: 'FREQ=DAILY',
    })

    const snoozed = start + 9 * 60_000
    recordEvent(device.deviceId, 'alm_adopt', 'ARMED', snoozed, '1.1.0', snoozed)

    expect(getAlarm('alm_adopt')?.triggerAtMillis).toBe(snoozed)
    expect(getAlarm('alm_adopt')?.seriesAnchorMillis).toBe(start)
  })

  it('re-queues the advance backstop off the adopted trigger', async () => {
    // The backstop was queued at the ORIGINAL trigger plus ten minutes, so a longer snooze let the
    // series advance while the occurrence was still pending: the phone rings at 06:45 and the
    // server has already moved on to tomorrow.
    const device = makeDevice('dev_backstop')
    setTimezone(device.deviceId, ZONE)
    const start = DateTime.fromISO('2026-09-01T06:30', { zone: ZONE }).toMillis()
    await armAlarm(getDevice(device.deviceId)!, {
      alarmId: 'alm_backstop',
      triggerAtMillis: start,
      label: 'Wake up',
      recurrence: 'FREQ=DAILY',
    })

    const snoozed = start + 15 * 60_000
    recordEvent(device.deviceId, 'alm_backstop', 'ARMED', snoozed, '1.1.0', snoozed)

    const backstops = recurringJobs('alm_backstop')
    expect(backstops).toHaveLength(1)
    expect(backstops[0]!.runAtMillis).toBeGreaterThan(snoozed)
  })

  it('returns to the configured wall clock the day after a spring-forward gap', async () => {
    // 01:30 does not exist in Europe/London on 2027-03-28. luxon resolves it forward to 02:30, and
    // that corrected instant used to become the next anchor — so the one-hour correction outlived
    // the gap and the series was permanently an hour late.
    const device = makeDevice('dev_dst')
    setTimezone(device.deviceId, ZONE)
    const start = DateTime.fromISO('2027-03-27T01:30', { zone: ZONE }).toMillis()
    await armAlarm(getDevice(device.deviceId)!, {
      alarmId: 'alm_dst',
      triggerAtMillis: start,
      label: 'Nightly',
      recurrence: 'FREQ=DAILY',
    })

    // The clock has to move between advances: `advanceRecurrence` asks for the next occurrence after
    // `Date.now()`, so without this both calls answer with the same day and the test proves nothing.
    vi.useFakeTimers()
    vi.setSystemTime(DateTime.fromISO('2027-03-27T02:00', { zone: ZONE }).toJSDate())

    const first = await advanceRecurrence('alm_dst')
    const gapDay = getAlarm(first.nextAlarmId!)!
    // The gap day itself is corrected forward — there is no 01:30 to arm.
    expect(DateTime.fromMillis(gapDay.triggerAtMillis, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2027-03-28 02:30',
    )
    // But the ANCHOR did not move with it — that is the whole fix.
    expect(gapDay.seriesAnchorMillis).toBe(start)

    vi.setSystemTime(DateTime.fromISO('2027-03-28T03:00', { zone: ZONE }).toJSDate())
    const second = await advanceRecurrence(first.nextAlarmId!)
    const dayAfter = getAlarm(second.nextAlarmId!)!
    expect(DateTime.fromMillis(dayAfter.triggerAtMillis, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2027-03-29 01:30',
    )
    // And the clock is now carried by the anchor again, so the series is stable from here.
    expect(dayAfter.seriesAnchorMillis).toBe(dayAfter.triggerAtMillis)
    vi.useRealTimers()
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
