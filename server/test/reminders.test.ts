import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { DateTime } from 'luxon'
import { ensureSchema } from '../src/db/client.js'
import { getAlarm } from '../src/services/alarms.js'
import { dueJobs } from '../src/services/jobs.js'
import {
  cancelReminder,
  completeReminder,
  createReminder,
  getReminder,
  listReminders,
  onReminderAlarmEvent,
  reopenReminder,
  snoozeReminder,
} from '../src/services/reminders.js'
import { getDevice, setTimezone } from '../src/services/devices.js'
import { makeDevice } from './helpers.js'

beforeEach(() => ensureSchema())

const ZONE = 'Europe/London'
const inHours = (h: number): number => Date.now() + h * 3_600_000

describe('reminder lifecycle', () => {
  it('creates an OPEN reminder and schedules its first nudge', async () => {
    const device = makeDevice('dev_r1')
    const due = inHours(2)
    const r = await createReminder(device, { title: 'take the bins out', dueAtMillis: due })

    expect(r.state).toBe('OPEN')
    // A rung exists and lands no later than the due time. Deliberately NOT `toBe(due)`: a dated
    // reminder defaults to `deadline` now, so the first rung is normally a run-up warning — and
    // how many of those survive depends on where `due` falls against the device's quiet window,
    // which moves with the wall clock this file runs on. Pinning the exact instant made this pass
    // or fail by the hour of day.
    expect(r.nextNagAtMillis).not.toBeNull()
    expect(r.nextNagAtMillis!).toBeLessThanOrEqual(due)
    // A nudge job exists for it — this is what the scheduler will pick up.
    const jobs = dueJobs(due + 1000).filter((j) => j.kind === 'nudge' && j.reminderId === r.reminderId)
    expect(jobs.length).toBe(1)
  })

  it('completing stops the chase and clears the ladder', async () => {
    const device = makeDevice('dev_r2')
    const r = await createReminder(device, { title: 'call the dentist', dueAtMillis: inHours(1) })
    const res = await completeReminder(device, r.reminderId)

    expect(res.completed).toBe(true)
    const after = getReminder(r.reminderId)!
    expect(after.state).toBe('DONE')
    expect(after.nextNagAtMillis).toBeNull()
    expect(dueJobs(inHours(48)).filter((j) => j.kind === 'nudge' && j.reminderId === r.reminderId)).toHaveLength(0)
  })

  it('completing twice is a no-op rather than an error', async () => {
    const device = makeDevice('dev_r3')
    const r = await createReminder(device, { title: 'x', dueAtMillis: inHours(1) })
    await completeReminder(device, r.reminderId)
    expect((await completeReminder(device, r.reminderId)).completed).toBe(false)
  })

  it('ring=true arms an alarm that carries NO recurrence, even when the reminder repeats', async () => {
    const device = makeDevice('dev_r4')
    const due = DateTime.now().setZone(ZONE).plus({ hours: 3 }).toMillis()
    const r = await createReminder(device, {
      title: 'take meds',
      dueAtMillis: due,
      recurrence: 'FREQ=DAILY',
      ring: true,
    })
    expect(r.alarmId).toBeTruthy()
    const alarm = getAlarm(r.alarmId!)!
    // The load-bearing assertion: the reminder owns the recurrence, the alarm never does. Without
    // this, a DISMISSED event would call advanceRecurrence and silently roll the series forward.
    expect(alarm.recurrence).toBeNull()
    expect(r.recurrence).toBe('FREQ=DAILY')
  })

  it('completing a recurring occurrence rolls forward and stays OPEN', async () => {
    const device = makeDevice('dev_r5')
    const due = DateTime.now().setZone(ZONE).plus({ hours: 1 }).toMillis()
    const r = await createReminder(device, { title: 'meds', dueAtMillis: due, recurrence: 'FREQ=DAILY' })
    const res = await completeReminder(device, r.reminderId)

    expect(res.completed).toBe(true)
    expect(res.rolledTo).toBeGreaterThan(due)
    const after = getReminder(r.reminderId)!
    expect(after.state).toBe('OPEN')
    expect(after.completedCount).toBe(1)
    expect(after.nagCount).toBe(0) // ladder reset for the new occurrence
  })

  it('holds a recurring series to its own wall clock across a spring-forward gap', async () => {
    // `due_at_millis` is rewritten by every roll, so the occurrence luxon corrects out of the gap
    // used to become the anchor for every occurrence after it and the series stayed an hour late
    // for good. Same defect and same column as `alarms`, one table along.
    const device = makeDevice('dev_r_dst')
    setTimezone(device.deviceId, ZONE)
    const start = DateTime.fromISO('2027-03-27T01:30', { zone: ZONE }).toMillis()
    const r = await createReminder(getDevice(device.deviceId)!, {
      title: 'meds',
      dueAtMillis: start,
      recurrence: 'FREQ=DAILY',
    })
    expect(getReminder(r.reminderId)!.seriesAnchorMillis).toBe(start)

    vi.useFakeTimers()
    vi.setSystemTime(DateTime.fromISO('2027-03-27T02:00', { zone: ZONE }).toJSDate())
    await completeReminder(getDevice(device.deviceId)!, r.reminderId)
    const gapDay = getReminder(r.reminderId)!
    // There is no 01:30 that morning, so the occurrence itself is corrected forward…
    expect(DateTime.fromMillis(gapDay.dueAtMillis!, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2027-03-28 02:30',
    )
    // …but the anchor stays put, which is what stops the correction outliving the gap.
    expect(gapDay.seriesAnchorMillis).toBe(start)

    vi.setSystemTime(DateTime.fromISO('2027-03-28T03:00', { zone: ZONE }).toJSDate())
    await completeReminder(getDevice(device.deviceId)!, r.reminderId)
    const dayAfter = getReminder(r.reminderId)!
    expect(DateTime.fromMillis(dayAfter.dueAtMillis!, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2027-03-29 01:30',
    )
    vi.useRealTimers()
  })

  it('cancelling a recurring reminder ends the whole series', async () => {
    const device = makeDevice('dev_r6')
    const r = await createReminder(device, {
      title: 'meds',
      dueAtMillis: inHours(1),
      recurrence: 'FREQ=DAILY',
    })
    await cancelReminder(device, r.reminderId)
    const after = getReminder(r.reminderId)!
    expect(after.state).toBe('CANCELLED')
    expect(after.recurrence).toBeNull()
    expect(after.nextNagAtMillis).toBeNull()
  })

  it('snoozing moves the next nudge without completing', async () => {
    const device = makeDevice('dev_r7')
    const r = await createReminder(device, { title: 'x', dueAtMillis: inHours(1) })
    const until = inHours(5)
    expect(snoozeReminder(r.reminderId, until)).toBe(true)
    const after = getReminder(r.reminderId)!
    expect(after.state).toBe('OPEN')
    expect(after.nextNagAtMillis).toBe(until)
  })

  it('reopen undoes a completion', async () => {
    const device = makeDevice('dev_r8')
    const r = await createReminder(device, { title: 'x', dueAtMillis: inHours(1) })
    await completeReminder(device, r.reminderId)
    expect(reopenReminder(device, r.reminderId)).toBe(true)
    expect(getReminder(r.reminderId)!.state).toBe('OPEN')
  })

  it('a dismissed reminder alarm starts the follow-up instead of completing it', async () => {
    const device = makeDevice('dev_r9')
    const r = await createReminder(device, {
      title: 'post the parcel',
      dueAtMillis: Date.now() - 60_000, // just went off
      ring: true,
      nagPolicy: 'persistent',
    })
    // Takes the whole device now, not just its zone: the follow-up rung goes through nextNagAt,
    // which needs the device's quiet hours as well as its timezone.
    onReminderAlarmEvent(r.alarmId!, 'DISMISSED', device)

    const after = getReminder(r.reminderId)!
    // Swiping the ring away is NOT doing the task.
    expect(after.state).toBe('OPEN')
    expect(after.nextNagAtMillis).not.toBeNull()
  })

  it('lists open reminders and filters overdue', async () => {
    const device = makeDevice('dev_r10')
    await createReminder(device, { title: 'past', dueAtMillis: Date.now() - 60_000 })
    await createReminder(device, { title: 'future', dueAtMillis: inHours(5) })
    expect(listReminders(device.deviceId, { state: 'open' })).toHaveLength(2)
    const overdue = listReminders(device.deviceId, { state: 'open', overdueOnly: true })
    expect(overdue).toHaveLength(1)
    expect(overdue[0]!.title).toBe('past')
  })

  it('an undated reminder is created AND chased', async () => {
    // It used to be created and then never spoken of again — no rung, no job, nothing but a row in
    // a list nobody opens. Now it has a ladder of its own, anchored on when it was asked for.
    const device = makeDevice('dev_r11')
    const r = await createReminder(device, { title: 'someday: fix the shed' })
    expect(r.state).toBe('OPEN')
    expect(r.dueAtMillis).toBeNull()
    expect(r.nextNagAtMillis).not.toBeNull()
    expect(r.nextNagAtMillis!).toBeGreaterThan(Date.now())
    // And the job that actually makes it happen exists, which is the half the row alone cannot show.
    const jobs = dueJobs(r.nextNagAtMillis! + 1000).filter(
      (j) => j.kind === 'nudge' && j.reminderId === r.reminderId,
    )
    expect(jobs).toHaveLength(1)
  })
})

describe('the defer counter', () => {
  // This is the number Otto cites when he pushes back. If it were wrong he would be bluffing, and
  // a coach the owner can catch out is a coach the owner stops reading.
  it('starts at zero', async () => {
    const device = makeDevice('dev_d1')
    const r = await createReminder(device, { title: 'the gym', dueAtMillis: inHours(2) })
    expect(r.deferCount).toBe(0)
  })

  it('counts every snooze', async () => {
    const device = makeDevice('dev_d2')
    const r = await createReminder(device, { title: 'the gym', dueAtMillis: inHours(2) })

    snoozeReminder(r.reminderId, inHours(3))
    snoozeReminder(r.reminderId, inHours(4))
    snoozeReminder(r.reminderId, inHours(5))

    expect(getReminder(r.reminderId)!.deferCount).toBe(3)
  })

  it('does not count a snooze that was rejected', async () => {
    const device = makeDevice('dev_d3')
    const r = await createReminder(device, { title: 'the gym', dueAtMillis: inHours(2) })
    await completeReminder(device, r.reminderId)

    expect(snoozeReminder(r.reminderId, inHours(3))).toBe(false)
    expect(getReminder(r.reminderId)!.deferCount).toBe(0)
  })

  it('survives completing and reopening — a deferral already happened', async () => {
    const device = makeDevice('dev_d4')
    const r = await createReminder(device, { title: 'the gym', dueAtMillis: inHours(2) })
    snoozeReminder(r.reminderId, inHours(3))
    await completeReminder(device, r.reminderId)
    reopenReminder(device, r.reminderId)

    expect(getReminder(r.reminderId)!.deferCount).toBe(1)
  })
})
