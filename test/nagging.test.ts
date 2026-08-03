import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

// Partial mock: outbox.flushOutbox calls sendText, and everything else in this module (signature
// verification, the inbound parser) has to stay real or importing the app graph falls over.
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
import { db, ensureSchema } from '../src/db/client.js'
import { jobs, reminders } from '../src/db/schema.js'
import { deferPastQuietHours, parseQuietHours } from '../src/lib/quietHours.js'
import { getDevice, linkWhatsapp, markInbound, type Device } from '../src/services/devices.js'
import { dueJobs } from '../src/services/jobs.js'
import { runNudge } from '../src/services/nagging.js'
import { nudgeHistory } from '../src/services/outbox.js'
import { createReminder, getReminder } from '../src/services/reminders.js'
import { updateSettings } from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

/**
 * runNudge had no test at all, which is how a quiet-hours regression would have shipped silently:
 * it is the only place a nudge is actually SENT, and the only place a rung is actually burned.
 *
 * Every case pins the quiet window explicitly rather than relying on QUIET_HOURS_DEFAULT, because
 * the suite runs at whatever the wall clock happens to be and 22:00–07:00 is true for a third of
 * the day.
 */

const FAR_FUTURE = Date.now() + 365 * 24 * 3_600_000
const WA_NUMBER = '447700900123'

beforeEach(() => {
  ensureSchema()
  sends.length = 0
})

/** A device reachable over WhatsApp with an open 24h window, so a nudge actually goes out. */
function reachableDevice(deviceId: string): Device {
  makeDevice(deviceId)
  linkWhatsapp(deviceId, WA_NUMBER)
  markInbound(deviceId)
  return getDevice(deviceId)!
}

/** A quiet window that certainly contains `at`, expressed in the device zone (UTC under vitest). */
function windowAround(at: number): string {
  const dt = DateTime.fromMillis(at, { zone: 'UTC' })
  const hhmm = (d: DateTime): string => d.toFormat('HH:mm')
  return `${hhmm(dt.minus({ minutes: 90 }))}-${hhmm(dt.plus({ hours: 3 }))}`
}

const nudgeJobs = (reminderId: string) =>
  dueJobs(FAR_FUTURE).filter((j) => j.kind === 'nudge' && j.reminderId === reminderId)

/** Put a reminder's next rung exactly where a test needs it, without going through the ladder. */
function setRung(reminderId: string, nextNagAtMillis: number, nagCount?: number): void {
  db.update(reminders)
    .set(nagCount === undefined ? { nextNagAtMillis } : { nextNagAtMillis, nagCount })
    .where(eq(reminders.reminderId, reminderId))
    .run()
}

describe('runNudge outside quiet hours', () => {
  it('sends the nudge and burns a rung', async () => {
    const device = reachableDevice('dev_ng1')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const r = await createReminder(device, { title: 'take the bins out', dueAtMillis: Date.now() - 1_000 })

    await runNudge(r.reminderId)

    expect(sends).toHaveLength(1)
    expect(sends[0]!.to).toBe(WA_NUMBER)
    expect(getReminder(r.reminderId)!.nagCount).toBe(1)
  })
})

describe('runNudge inside quiet hours', () => {
  it('sends nothing, burns no rung, and re-queues itself at the window end', async () => {
    // THE headline case. Deferring BEFORE the atomic claim is what makes it cost no rung — burning
    // one at 3am would inflate the "chased N×" counter the whole persona cites as evidence.
    const device = reachableDevice('dev_ng2')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const r = await createReminder(device, { title: 'call the dentist', dueAtMillis: Date.now() - 1_000 })

    const window = windowAround(Date.now())
    updateSettings(device.deviceId, { quietHours: window })
    // Clear the queue so "exactly one job, at the window end" is unambiguous.
    db.delete(jobs).run()
    const expected = deferPastQuietHours(Date.now(), 'UTC', parseQuietHours(window))

    await runNudge(r.reminderId)

    expect(sends).toHaveLength(0)
    const after = getReminder(r.reminderId)!
    expect(after.nagCount).toBe(0)
    expect(after.nextNagAtMillis).toBe(expected)
    const queued = nudgeJobs(r.reminderId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.runAtMillis).toBe(expected)
  })

  it('exempts a reminder that opted into escalation — it sends at 3am on purpose', async () => {
    // escalateWithAlarm is documented as "this WILL wake them". A server-wide default silently
    // overriding a per-item opt-in has it exactly backwards.
    const device = reachableDevice('dev_ng3')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const r = await createReminder(device, {
      title: 'take the antibiotics',
      dueAtMillis: Date.now() - 1_000,
      escalateWithAlarm: true,
    })

    updateSettings(device.deviceId, { quietHours: windowAround(Date.now()) })
    await runNudge(r.reminderId)

    expect(sends).toHaveLength(1)
    expect(getReminder(r.reminderId)!.nagCount).toBe(1)
  })

  it('still lets the staleness gate win — a six-hour-old rung is retired, not deferred', async () => {
    const device = reachableDevice('dev_ng4')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const r = await createReminder(device, { title: 'the recycling', dueAtMillis: Date.now() - 1_000 })

    updateSettings(device.deviceId, { quietHours: windowAround(Date.now()) })
    setRung(r.reminderId, Date.now() - 7 * 3_600_000)
    db.delete(jobs).run()

    await runNudge(r.reminderId)

    expect(sends).toHaveLength(0)
    // Retired for the digest to pick up, rather than moved to the window end.
    expect(getReminder(r.reminderId)!.nextNagAtMillis).toBeNull()
    expect(nudgeJobs(r.reminderId)).toHaveLength(0)
  })

  it('does not defer rung 0 at the due time the owner chose themselves', async () => {
    // A reminder due 23:30 nudges at 23:30 — the same rule nextNagAt applies when scheduling it.
    const device = reachableDevice('dev_ng5')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const due = Date.now() - 1_000
    const r = await createReminder(device, { title: 'lock the back door', dueAtMillis: due })

    updateSettings(device.deviceId, { quietHours: windowAround(Date.now()) })
    setRung(r.reminderId, due, 0)

    await runNudge(r.reminderId)

    expect(sends).toHaveLength(1)
    expect(getReminder(r.reminderId)!.nagCount).toBe(1)
  })
})

describe('runNudge across a quiet window that swallows several rungs', () => {
  // Only Date is faked: the ladder is a sequence of INSTANTS, and every await in this path resolves
  // on a microtask (sendText is mocked), so faking timers as well would buy nothing and could stall
  // the outbox flush.
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
  afterEach(() => vi.useRealTimers())

  const utc = (iso: string): number => DateTime.fromISO(iso, { zone: 'UTC' }).toMillis()

  it('chases once at the window end, not three times in thirty seconds', async () => {
    // THE failure this whole fix is about. A persistent reminder due 23:00 has rungs at 23:30,
    // 01:00 and 05:00 — all three inside 22:00–07:00, all three deferred to the same 07:00. Every
    // rung has its own dedupe key, so nothing downstream catches it: the owner is chased three
    // times in the time it takes the scheduler to tick twice, having had no chance to reply to the
    // first, and rungs 2 and 3 are burned for nothing.
    vi.setSystemTime(utc('2026-08-03T22:55:00'))
    const device = reachableDevice('dev_ng7')
    updateSettings(device.deviceId, { quietHours: '22:00-07:00' })
    const due = utc('2026-08-03T23:00:00')
    const r = await createReminder(device, { title: 'take the pills', dueAtMillis: due, nagPolicy: 'persistent' })
    // Rung 0 is the owner's own due time, so it fires inside the window by design.
    expect(getReminder(r.reminderId)!.nextNagAtMillis).toBe(due)

    vi.setSystemTime(due)
    await runNudge(r.reminderId)
    expect(sends).toHaveLength(1)
    const windowEnd = getReminder(r.reminderId)!.nextNagAtMillis!
    expect(windowEnd).toBe(utc('2026-08-04T07:00:00'))
    sends.length = 0

    // Now run the scheduler as it actually runs: every 15s, fire whatever is due.
    for (const tick of [0, 15_000, 30_000, 45_000, 60_000].map((d) => windowEnd + d)) {
      vi.setSystemTime(tick)
      const rung = getReminder(r.reminderId)!.nextNagAtMillis
      if (rung !== null && rung <= tick) await runNudge(r.reminderId)
    }

    expect(sends).toHaveLength(1)
    expect(getReminder(r.reminderId)!.nagCount).toBe(2)
    // And the rung after it is a real gap away, not on the same instant.
    expect(getReminder(r.reminderId)!.nextNagAtMillis).toBe(utc('2026-08-04T07:30:00'))
  })
})

describe('runNudge concurrency', () => {
  it('two concurrent calls yield exactly ONE send', async () => {
    // The guarded UPDATE is the double-send guard; the "rung has moved" gate is what stops the
    // loser from simply firing the NEXT rung a millisecond later instead.
    const device = reachableDevice('dev_ng6')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const r = await createReminder(device, {
      title: 'move the car',
      dueAtMillis: Date.now() - 1_000,
      nagPolicy: 'persistent',
    })

    await Promise.all([runNudge(r.reminderId), runNudge(r.reminderId)])

    expect(sends).toHaveLength(1)
    expect(getReminder(r.reminderId)!.nagCount).toBe(1)
    // One outbox row too. The dedupe key is per rung, so a loser that simply walked on to the NEXT
    // rung would slip past the unique index and show up here — which is exactly what happened
    // before the "rung has moved" gate existed.
    expect(nudgeHistory(r.reminderId)).toHaveLength(1)
  })
})
