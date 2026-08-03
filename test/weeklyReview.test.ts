import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

const sends = vi.hoisted(() => [] as Array<{ to: string; body: string }>)
vi.mock('../src/services/whatsapp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/whatsapp.js')>()
  return {
    ...actual,
    sendText: vi.fn(async (to: string, body: string) => {
      sends.push({ to, body })
      return { ok: true as const }
    }),
  }
})

import { DateTime } from 'luxon'
import { eq } from 'drizzle-orm'
import { composeWeeklyReview } from '../src/agent/review.js'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { alarmEvents, outbox, reminders } from '../src/db/schema.js'
import { getDevice, linkWhatsapp, markInbound, type Device } from '../src/services/devices.js'
import { seedWeeklyReview } from '../src/services/handlers/weeklyReview.js'
import { dueJobs } from '../src/services/jobs.js'
import { updateSettings } from '../src/services/settings.js'
import { isWorthSaying, weeklyRecord } from '../src/services/signals.js'
import { deliverWeeklyReview, nextWeeklyReviewAt, weeklyReviewSlot } from '../src/services/weeklyReview.js'
import { makeDevice } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000 // fixed instant; every case is relative to this
const WA_NUMBER = '447700900555'

beforeEach(() => {
  ensureSchema()
  sends.length = 0
})

function reachableDevice(deviceId: string): Device {
  makeDevice(deviceId)
  linkWhatsapp(deviceId, WA_NUMBER)
  markInbound(deviceId)
  return getDevice(deviceId)!
}

function event(deviceId: string, alarmId: string, kind: string, atMillis: number): void {
  db.insert(alarmEvents)
    .values({ alarmId: `${deviceId}:${alarmId}`, deviceId, event: kind, atMillis, appVersion: null, receivedAt: atMillis })
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
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW - 30 * DAY,
      ...over,
    })
    .run()
}

const outboxFor = (deviceId: string) => db.select().from(outbox).where(eq(outbox.deviceId, deviceId)).all()

describe('weeklyRecord', () => {
  it('counts only the last seven days, and only this device', () => {
    const d = 'dev_wr1'
    event(d, 'alm_in', 'RANG', NOW - 3 * DAY)
    event(d, 'alm_edge', 'RANG', NOW - 8 * DAY) // outside the window
    event('dev_wr1_other', 'alm_other', 'RANG', NOW - 3 * DAY) // another device
    event(d, 'alm_in', 'SNOOZED', NOW - 3 * DAY + 1)
    event(d, 'alm_in', 'SNOOZED', NOW - 3 * DAY + 2)
    event(d, 'alm_ms', 'MISSED', NOW - 2 * DAY)
    event(d, 'alm_wc', 'WAKE_CHECK_FAILED', NOW - DAY)

    reminder(d, { reminderId: 'rem_wr1_done', title: 'ring the plumber', state: 'DONE', completedAtMillis: NOW - 2 * DAY })
    reminder(d, { reminderId: 'rem_wr1_old', title: 'last month', state: 'DONE', completedAtMillis: NOW - 20 * DAY })
    reminder(d, { reminderId: 'rem_wr1_drop', title: 'dropped', state: 'CANCELLED', updatedAt: NOW - DAY })
    reminder(d, { reminderId: 'rem_wr1_new', title: 'fresh', createdAt: NOW - 4 * DAY })

    const r = weeklyRecord(d, NOW)
    expect(r.alarmsRang).toBe(1)
    expect(r.alarmsSnoozed).toBe(1)
    expect(r.snoozeTotal).toBe(2)
    expect(r.alarmsMissed).toBe(1)
    expect(r.wakeChecksFailed).toBe(1)
    expect(r.finished).toBe(1)
    expect(r.finishedTitles).toEqual(['ring the plumber'])
    expect(r.dropped).toBe(1)
    expect(r.created).toBe(1)
    expect(r.stillOpen).toBe(1)
  })

  it('caps the finished titles at five, newest first', () => {
    const d = 'dev_wr2'
    for (let i = 0; i < 7; i++) {
      reminder(d, { reminderId: `rem_wr2_${i}`, title: `thing ${i}`, state: 'DONE', completedAtMillis: NOW - DAY - i })
    }
    expect(weeklyRecord(d, NOW).finishedTitles).toEqual(['thing 0', 'thing 1', 'thing 2', 'thing 3', 'thing 4'])
  })

  it('EXCLUDES a slipping reminder the moment it is done', () => {
    // This is what structurally enforces "never raise a pattern they have already fixed". Filtering
    // on state='OPEN' means a reminder that was slipping all week and then got finished simply
    // cannot appear — the rule is not delegated to the model.
    const d = 'dev_wr3'
    reminder(d, { reminderId: 'rem_wr3_open', title: 'still slipping', deferCount: 4, nagCount: 5 })
    reminder(d, {
      reminderId: 'rem_wr3_fixed',
      title: 'was slipping, now done',
      state: 'DONE',
      deferCount: 9,
      nagCount: 9,
      completedAtMillis: NOW - DAY,
    })

    const r = weeklyRecord(d, NOW)
    expect(r.slippers.map((s) => s.title)).toEqual(['still slipping'])
  })

  it('takes the worst three, by moves then chases', () => {
    const d = 'dev_wr4'
    reminder(d, { reminderId: 'rem_wr4_a', title: 'a', deferCount: 5, nagCount: 0 })
    reminder(d, { reminderId: 'rem_wr4_b', title: 'b', deferCount: 3, nagCount: 8 })
    reminder(d, { reminderId: 'rem_wr4_c', title: 'c', deferCount: 3, nagCount: 4 })
    reminder(d, { reminderId: 'rem_wr4_d', title: 'd', deferCount: 2, nagCount: 0 })
    reminder(d, { reminderId: 'rem_wr4_quiet', title: 'not slipping', deferCount: 1, nagCount: 1 })

    expect(weeklyRecord(d, NOW).slippers.map((s) => s.title)).toEqual(['a', 'b', 'c'])
  })
})

describe('isWorthSaying', () => {
  it('is false for a week in which nothing happened', () => {
    // A review of an empty week is the fastest way to teach the owner to ignore the Sunday message.
    expect(isWorthSaying(weeklyRecord('dev_wr5_empty', NOW))).toBe(false)
  })

  it('is false for a standing list nobody touched, and true once something slips', () => {
    const d = 'dev_wr6'
    reminder(d, { reminderId: 'rem_wr6', title: 'someday', createdAt: NOW - 30 * DAY })
    expect(isWorthSaying(weeklyRecord(d, NOW))).toBe(false)

    db.update(reminders).set({ deferCount: 2 }).where(eq(reminders.reminderId, 'rem_wr6')).run()
    expect(isWorthSaying(weeklyRecord(d, NOW))).toBe(true)
  })
})

describe('composeWeeklyReview', () => {
  it('has no API key configured in tests — the precondition for everything below', () => {
    expect(config.anthropic).toBeNull()
  })

  it('falls back to a deterministic message carrying the real numbers', async () => {
    const d = 'dev_wr7'
    event(d, 'alm_a', 'RANG', NOW - 2 * DAY)
    event(d, 'alm_a', 'SNOOZED', NOW - 2 * DAY + 1)
    event(d, 'alm_b', 'WAKE_CHECK_FAILED', NOW - DAY)
    reminder(d, { reminderId: 'rem_wr7_done', title: 'the tax return', state: 'DONE', completedAtMillis: NOW - DAY })
    reminder(d, { reminderId: 'rem_wr7_slip', title: 'call the dentist', deferCount: 3, nagCount: 4 })

    const body = await composeWeeklyReview(weeklyRecord(d, NOW), 'Europe/London')

    expect(body).toContain('1 finished')
    expect(body).toContain('0 dropped')
    expect(body).toContain('1 still open')
    expect(body).toContain('1 rang')
    expect(body).toContain('1 snoozes')
    expect(body).toContain('1 dismissed then back to sleep')
    expect(body).toContain('call the dentist (moved 3×, chased 4×)')
  })
})

describe('the review slot', () => {
  it('defaults to Sunday 18:00 local', () => {
    const device = reachableDevice('dev_wr8')
    expect(config.weeklyReviewDefault).toBe('SUN:18:00')
    expect(weeklyReviewSlot(device)).toEqual({ weekday: 7, hour: 18, minute: 0 })

    const at = nextWeeklyReviewAt(device, NOW)!
    const dt = DateTime.fromMillis(at, { zone: device.timezone })
    expect(dt.weekday).toBe(7)
    expect(dt.toFormat('HH:mm')).toBe('18:00')
    expect(at).toBeGreaterThan(NOW)
  })
})

describe('seedWeeklyReview', () => {
  // The per-device seam: it runs on every boot AND after every gc pass, so it has to be idempotent
  // or a month of restarts leaves a month of parallel chains.
  const chainsFor = (deviceId: string) =>
    dueJobs(Date.now() + 400 * DAY).filter((j) => j.kind === 'weekly_review' && j.deviceId === deviceId)

  it('seeds one chain and leaves it alone on every later pass', () => {
    const device = reachableDevice('dev_wr13')
    seedWeeklyReview(device, Date.now())
    const first = chainsFor(device.deviceId)
    expect(first).toHaveLength(1)

    seedWeeklyReview(device, Date.now())
    seedWeeklyReview(device, Date.now())
    const after = chainsFor(device.deviceId)
    expect(after).toHaveLength(1)
    // Same row: a chain that has already picked its next run must not be reset by re-seeding.
    expect(after[0]!.id).toBe(first[0]!.id)
  })

  it('clears the chain once the owner switches reviews off', () => {
    const device = reachableDevice('dev_wr14')
    seedWeeklyReview(device, Date.now())
    expect(chainsFor(device.deviceId)).toHaveLength(1)

    updateSettings(device.deviceId, { weeklyReviewAt: 'off' })
    expect(nextWeeklyReviewAt(device, Date.now())).toBeNull()
    seedWeeklyReview(device, Date.now())
    expect(chainsFor(device.deviceId)).toHaveLength(0)
  })
})

describe('deliverWeeklyReview', () => {
  it('says nothing about an empty week', async () => {
    const device = reachableDevice('dev_wr9')
    expect(await deliverWeeklyReview(device, NOW, NOW)).toBe(false)
    expect(outboxFor(device.deviceId)).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })

  it('queues exactly one row, and a second run in the same local week queues none', async () => {
    const device = reachableDevice('dev_wr10')
    const now = Date.now()
    event(device.deviceId, 'alm_a', 'RANG', now - DAY)
    reminder(device.deviceId, {
      reminderId: 'rem_wr10',
      title: 'the bins',
      state: 'DONE',
      completedAtMillis: now - DAY,
    })

    expect(await deliverWeeklyReview(device, now, now)).toBe(true)
    expect(outboxFor(device.deviceId)).toHaveLength(1)
    expect(outboxFor(device.deviceId)[0]!.kind).toBe('weekly')

    // Same local week ⇒ silence, whatever the job queue does.
    expect(await deliverWeeklyReview(device, now + 60_000, now + 60_000)).toBe(false)
    expect(outboxFor(device.deviceId)).toHaveLength(1)
  })

  it('refuses to arrive on Tuesday with Sunday\'s review', async () => {
    const device = reachableDevice('dev_wr11')
    const now = Date.now()
    event(device.deviceId, 'alm_a', 'RANG', now - DAY)

    // Scheduled two days ago: the week has moved on and the review is no longer true.
    expect(await deliverWeeklyReview(device, now - 2 * DAY, now)).toBe(false)
    expect(outboxFor(device.deviceId)).toHaveLength(0)
  })

  it('stays quiet for a device with no WhatsApp number', async () => {
    makeDevice('dev_wr12')
    const device = getDevice('dev_wr12')!
    const now = Date.now()
    event(device.deviceId, 'alm_a', 'RANG', now - DAY)

    expect(await deliverWeeklyReview(device, now, now)).toBe(false)
    expect(outboxFor(device.deviceId)).toHaveLength(0)
  })
})
