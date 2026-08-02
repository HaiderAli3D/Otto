import { beforeEach, describe, expect, it } from 'vitest'

import { db, ensureSchema } from '../src/db/client.js'
import { alarmEvents, reminders } from '../src/db/schema.js'
import { ownerRecord, reminderEvidence, renderRecord } from '../src/services/signals.js'

beforeEach(() => ensureSchema())

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000 // fixed instant; every case is relative to this
const ZONE = 'Europe/London'

/**
 * The worker's in-memory DB is shared by every test in this file, and alarm_events carries a unique
 * index on (alarm_id, event, at_millis). Scoping the id to the device keeps cases from colliding
 * while leaving the distinct-alarm count per device correct.
 */
function event(deviceId: string, alarmId: string, kind: string, atMillis: number): void {
  db.insert(alarmEvents)
    .values({ alarmId: `${deviceId}:${alarmId}`, deviceId, event: kind, atMillis, appVersion: '1.0.0', receivedAt: atMillis })
    .run()
}

function reminder(
  deviceId: string,
  over: Partial<typeof reminders.$inferInsert> & { reminderId: string; title: string },
): void {
  db.insert(reminders)
    .values({
      deviceId,
      waUserId: null,
      detail: null,
      state: 'OPEN',
      dueAtMillis: null,
      recurrence: null,
      nagPolicy: 'gentle',
      nextNagAtMillis: null,
      nagCount: 0,
      lastNaggedAtMillis: null,
      deferCount: 0,
      escalateWithAlarm: false,
      alarmId: null,
      completedAtMillis: null,
      completedCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    })
    .run()
}

describe('owner record — alarms', () => {
  it('counts rings, distinct snoozed alarms, total snoozes and misses', () => {
    const d = 'dev_s1'
    event(d, 'alm_a', 'RANG', NOW - DAY)
    event(d, 'alm_b', 'RANG', NOW - 2 * DAY)
    // alm_a hit snooze three times, alm_b once → 2 alarms snoozed, 4 snoozes total.
    event(d, 'alm_a', 'SNOOZED', NOW - DAY + 1)
    event(d, 'alm_a', 'SNOOZED', NOW - DAY + 2)
    event(d, 'alm_a', 'SNOOZED', NOW - DAY + 3)
    event(d, 'alm_b', 'SNOOZED', NOW - 2 * DAY + 1)
    event(d, 'alm_c', 'MISSED', NOW - 3 * DAY)

    const r = ownerRecord(d, NOW)
    expect(r.alarmsRang).toBe(2)
    expect(r.alarmsSnoozed).toBe(2)
    expect(r.snoozeTotal).toBe(4)
    expect(r.alarmsMissed).toBe(1)
  })

  it('forgets anything older than the 14-day window', () => {
    const d = 'dev_s2'
    event(d, 'alm_old', 'RANG', NOW - 15 * DAY)
    event(d, 'alm_old', 'SNOOZED', NOW - 15 * DAY)
    event(d, 'alm_new', 'RANG', NOW - 13 * DAY)

    const r = ownerRecord(d, NOW)
    expect(r.alarmsRang).toBe(1)
    expect(r.snoozeTotal).toBe(0)
  })

  it('does not count another device\'s events', () => {
    event('dev_s3', 'alm_x', 'RANG', NOW - DAY)
    event('dev_s3_other', 'alm_y', 'RANG', NOW - DAY)
    expect(ownerRecord('dev_s3', NOW).alarmsRang).toBe(1)
  })
})

describe('owner record — reminders', () => {
  it('counts a recurring completion even though the row is back to OPEN', () => {
    const d = 'dev_s4'
    // This is the shape completeReminder() leaves behind for a recurring reminder: OPEN again,
    // with completedAtMillis set. Counting off state alone would miss every recurring finish.
    reminder(d, {
      reminderId: 'rem_recur',
      title: 'water the plants',
      state: 'OPEN',
      completedAtMillis: NOW - DAY,
      completedCount: 3,
    })
    expect(ownerRecord(d, NOW).remindersFinished).toBe(1)
  })

  it('separates finished, dropped and still-open', () => {
    const d = 'dev_s5'
    reminder(d, { reminderId: 'rem_a', title: 'done thing', state: 'DONE', completedAtMillis: NOW - DAY })
    reminder(d, { reminderId: 'rem_b', title: 'dropped thing', state: 'CANCELLED', updatedAt: NOW - DAY })
    reminder(d, { reminderId: 'rem_c', title: 'open thing' })
    reminder(d, { reminderId: 'rem_d', title: 'another open thing' })

    const r = ownerRecord(d, NOW)
    expect(r.remindersFinished).toBe(1)
    expect(r.remindersDropped).toBe(1)
    expect(r.remindersOpen).toBe(2)
  })

  it('reports the oldest open item with its counters', () => {
    const d = 'dev_s6'
    reminder(d, { reminderId: 'rem_new', title: 'recent', createdAt: NOW - DAY })
    reminder(d, {
      reminderId: 'rem_old',
      title: 'call the dentist',
      createdAt: NOW - 9 * DAY,
      nagCount: 4,
      deferCount: 3,
    })

    const oldest = ownerRecord(d, NOW).longestOpen
    expect(oldest).toEqual({ title: 'call the dentist', days: 9, chased: 4, moved: 3 })
  })
})

describe('renderRecord', () => {
  it('says there is nothing on file rather than rendering zeroes', () => {
    // A fresh install otherwise reads as "0 finished, 0 open", which a coach primed to keep score
    // can turn into an accusation about a history that does not exist.
    const text = renderRecord('dev_s7_fresh', NOW)
    expect(text).toContain('nothing on file')
    expect(text).toContain('do not imply you do')
  })

  it('renders the numbers it does have', () => {
    const d = 'dev_s8'
    event(d, 'alm_a', 'RANG', NOW - DAY)
    event(d, 'alm_a', 'SNOOZED', NOW - DAY)
    event(d, 'alm_a', 'SNOOZED', NOW - DAY + 1)
    reminder(d, { reminderId: 'rem_s8', title: 'the bins', createdAt: NOW - 4 * DAY, nagCount: 4, deferCount: 2 })

    const text = renderRecord(d, NOW)
    expect(text).toContain('1 rang')
    expect(text).toContain('2 snoozes in total')
    expect(text).toContain('0 finished, 0 dropped, 1 still open')
    expect(text).toContain('"the bins" — 4 days old, chased 4×, moved 2×')
  })

  it('omits the oldest-item line while everything is under a day old', () => {
    const d = 'dev_s9'
    reminder(d, { reminderId: 'rem_s9', title: 'today thing', createdAt: NOW - 3600_000 })
    expect(renderRecord(d, NOW)).not.toContain('Oldest open item')
  })
})

describe('reminderEvidence', () => {
  it('marks an overdue item and shows both counters', () => {
    const text = reminderEvidence({ dueAtMillis: NOW - 3600_000, nagCount: 4, deferCount: 3 }, ZONE, NOW)
    expect(text).toContain('OVERDUE')
    expect(text).toContain('chased 4×')
    expect(text).toContain('moved 3×')
  })

  it('stays quiet about counters that are zero', () => {
    const text = reminderEvidence({ dueAtMillis: NOW + 3600_000, nagCount: 0, deferCount: 0 }, ZONE, NOW)
    expect(text).not.toContain('chased')
    expect(text).not.toContain('moved')
    expect(text).not.toContain('OVERDUE')
  })

  it('handles an undated reminder', () => {
    expect(reminderEvidence({ dueAtMillis: null, nagCount: 1, deferCount: 0 }, ZONE, NOW)).toBe('no date, chased 1×')
  })
})
