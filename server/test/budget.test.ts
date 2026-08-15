import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { DateTime } from 'luxon'
import { db, ensureSchema } from '../src/db/client.js'
import { outbox } from '../src/db/schema.js'
import {
  BUDGET_EXEMPT_KINDS,
  budgetAllows,
  budgetResetsAt,
  budgetState,
  describeBudget,
  messagesSentToday,
} from '../src/services/budget.js'
import { getDevice, linkWhatsapp, type Device } from '../src/services/devices.js'
import type { OutboxKind } from '../src/services/outbox.js'
import { updateSettings } from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

/**
 * The budget is a runaway backstop, not a volume policy: the owner asked to be chased hard and the
 * default ceiling is deliberately far above a normal day. What it exists for is the failure the
 * dense ladders newly make possible — a `relentless` reminder firing rungs minutes apart against a
 * phone nobody is holding.
 */

beforeEach(() => ensureSchema())

function device(id: string): Device {
  makeDevice(id)
  linkWhatsapp(id, '447700900123')
  return getDevice(id)!
}

/** A delivered outbox row, stamped at a chosen instant. */
function sent(d: Device, kind: OutboxKind, atMillis: number, state = 'SENT'): void {
  db.insert(outbox)
    .values({
      waUserId: '447700900123',
      deviceId: d.deviceId,
      kind,
      body: `${kind} body`,
      reminderId: null,
      dedupeKey: `${kind}:${atMillis}:${Math.random()}`,
      state,
      expiresAtMillis: null,
      attempts: 0,
      lastError: null,
      createdAt: atMillis,
      sentAtMillis: atMillis,
    })
    .run()
}

describe('messagesSentToday', () => {
  it('counts what went out since local midnight and nothing before it', () => {
    const d = device('dev_b1')
    const now = Date.now()
    const beforeMidnight = DateTime.fromMillis(now, { zone: 'UTC' }).startOf('day').minus({ minutes: 1 }).toMillis()
    sent(d, 'nudge', now)
    sent(d, 'nudge', now)
    sent(d, 'nudge', beforeMidnight)
    expect(messagesSentToday(d.deviceId, 'UTC', now)).toBe(2)
  })

  it('counts a claimed-but-unsent row, so a burst cannot slip through mid-flush', () => {
    const d = device('dev_b2')
    const now = Date.now()
    sent(d, 'nudge', now, 'SENDING')
    expect(messagesSentToday(d.deviceId, 'UTC', now)).toBe(1)
  })

  it('ignores rows that never went anywhere', () => {
    const d = device('dev_b3')
    const now = Date.now()
    sent(d, 'nudge', now, 'PENDING')
    sent(d, 'nudge', now, 'EXPIRED')
    sent(d, 'nudge', now, 'SUPERSEDED')
    expect(messagesSentToday(d.deviceId, 'UTC', now)).toBe(0)
  })

  it('does not count the exempt kinds against the ceiling', () => {
    // Each is either something only Otto knows went wrong, or a bounded ladder that ends by
    // ringing anyway. Counting them would let a bad night of alarms silence the next day.
    const d = device('dev_b4')
    const now = Date.now()
    for (const kind of BUDGET_EXEMPT_KINDS) sent(d, kind, now)
    expect(messagesSentToday(d.deviceId, 'UTC', now)).toBe(0)
  })

  it('counts the brief and the weekly review, which a nudge-only budget would let evade it', () => {
    const d = device('dev_b5')
    const now = Date.now()
    sent(d, 'brief', now)
    sent(d, 'weekly', now)
    sent(d, 'digest', now)
    expect(messagesSentToday(d.deviceId, 'UTC', now)).toBe(3)
  })

  it('counts per device, not per server', () => {
    const a = device('dev_b6a')
    const b = device('dev_b6b')
    const now = Date.now()
    sent(a, 'nudge', now)
    sent(a, 'nudge', now)
    sent(b, 'nudge', now)
    expect(messagesSentToday(a.deviceId, 'UTC', now)).toBe(2)
    expect(messagesSentToday(b.deviceId, 'UTC', now)).toBe(1)
  })
})

describe('budgetAllows', () => {
  it('lets everything through well under the ceiling', () => {
    const d = device('dev_b7')
    expect(budgetAllows(d, 'nudge')).toBe(true)
    expect(budgetState(d).exhausted).toBe(false)
  })

  it('holds a nudge once the day is spent', () => {
    const d = device('dev_b8')
    updateSettings(d.deviceId, { dailyMessageBudget: 3 })
    const now = Date.now()
    for (let i = 0; i < 3; i++) sent(d, 'nudge', now)
    expect(budgetState(d, now).exhausted).toBe(true)
    expect(budgetAllows(d, 'nudge', {}, now)).toBe(false)
  })

  it('never holds an exempt kind, however spent the day is', () => {
    const d = device('dev_b9')
    updateSettings(d.deviceId, { dailyMessageBudget: 1 })
    const now = Date.now()
    sent(d, 'nudge', now)
    for (const kind of BUDGET_EXEMPT_KINDS) expect(budgetAllows(d, kind, {}, now), kind).toBe(true)
  })

  it('lets an escalating reminder past, because a per-item opt-in beats a global default', () => {
    // Same argument `nagQuietHours` makes for escalateWithAlarm. A reminder the owner explicitly
    // marked as one that WILL wake them cannot be the one thing a general ceiling silences.
    const d = device('dev_b10')
    updateSettings(d.deviceId, { dailyMessageBudget: 1 })
    const now = Date.now()
    sent(d, 'nudge', now)
    expect(budgetAllows(d, 'nudge', {}, now)).toBe(false)
    expect(budgetAllows(d, 'nudge', { escalating: true }, now)).toBe(true)
  })

  it('treats 0 as unlimited rather than as silence', () => {
    // The obvious off-by-one disaster: a budget of zero must mean "no ceiling", not "say nothing
    // ever". Otto sets this field from a chat message.
    const d = device('dev_b11')
    updateSettings(d.deviceId, { dailyMessageBudget: 0 })
    const now = Date.now()
    for (let i = 0; i < 200; i++) sent(d, 'nudge', now)
    expect(budgetAllows(d, 'nudge', {}, now)).toBe(true)
    expect(budgetState(d, now).exhausted).toBe(false)
    expect(budgetState(d, now).remaining).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('budgetResetsAt', () => {
  it('is the next local midnight', () => {
    const now = DateTime.fromISO('2026-08-20T22:30:00', { zone: 'Europe/London' }).toMillis()
    const reset = budgetResetsAt('Europe/London', now)
    expect(DateTime.fromMillis(reset, { zone: 'Europe/London' }).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-08-21 00:00')
  })
})

describe('describeBudget', () => {
  it('says nothing at all while the ceiling is nowhere near binding', () => {
    // It costs tokens on every turn, and Otto narrating a budget that is not binding reads as
    // excuse-making.
    const d = device('dev_b12')
    expect(describeBudget(d)).toBeNull()
  })

  it('warns as it gets close, and states plainly when it is spent', () => {
    const d = device('dev_b13')
    updateSettings(d.deviceId, { dailyMessageBudget: 10 })
    const now = Date.now()
    for (let i = 0; i < 8; i++) sent(d, 'nudge', now)
    expect(describeBudget(d, now)).toMatch(/8 of your 10/)

    for (let i = 0; i < 2; i++) sent(d, 'nudge', now)
    const spent = describeBudget(d, now)!
    expect(spent).toMatch(/daily ceiling/)
    // The whole reason this line exists: without it Otto promises a chase it will be silently
    // prevented from making, which is exactly the lie the accountability prompt forbids.
    expect(spent).toMatch(/Do not promise a chase you cannot make/)
    expect(spent).toMatch(/Replying to them is unaffected/)
  })

  it('says nothing when the ceiling is switched off', () => {
    const d = device('dev_b14')
    updateSettings(d.deviceId, { dailyMessageBudget: 0 })
    expect(describeBudget(d)).toBeNull()
  })
})
