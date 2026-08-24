import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

// Partial mock, matching test/nagging.test.ts: signature verification and the inbound parser have
// to stay real or importing the app graph falls over.
const sends = vi.hoisted(() => [] as Array<{ to: string; body: string }>)
const outOfWindow = vi.hoisted(() => ({ value: false }))
vi.mock('../src/services/whatsapp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/whatsapp.js')>()
  return {
    ...actual,
    sendText: vi.fn(async (to: string, body: string) => {
      if (outOfWindow.value) {
        return { ok: false as const, permanent: false, status: 400, metaCode: 131047, outOfWindow: true, body: '' }
      }
      sends.push({ to, body })
      return { ok: true as const }
    }),
  }
})

import { eq } from 'drizzle-orm'
import { db, ensureSchema } from '../src/db/client.js'
import { alarms, reminders } from '../src/db/schema.js'
import { getDevice, linkWhatsapp, markInbound, type Device } from '../src/services/devices.js'
import { runNudge } from '../src/services/nagging.js'
import { createReminder, getReminder } from '../src/services/reminders.js'
import { updateSettings } from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

/**
 * The two guards the denser ladders made necessary. Neither reduces how much Otto says on a normal
 * day; both exist so a badly-chosen reminder cannot turn into something the owner has to uninstall
 * the app to stop.
 */

beforeEach(() => {
  ensureSchema()
  sends.length = 0
  outOfWindow.value = false
})

/**
 * A device reachable over WhatsApp, on a number of its own.
 *
 * The number has to be unique per test. `ensureSchema()` creates tables but does not empty them, and
 * the outbox is keyed on `waUserId` — so a shared number means `enqueueAndTryFlush` also flushes
 * whatever the previous test left PENDING, and every assertion about how many messages went out
 * counts someone else's.
 */
function reachableDevice(deviceId: string): Device {
  const waNumber = `4477009${String(Math.abs(hash(deviceId)) % 100000).padStart(5, '0')}`
  makeDevice(deviceId)
  linkWhatsapp(deviceId, waNumber)
  markInbound(deviceId)
  return getDevice(deviceId)!
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

describe('the daily message budget', () => {
  it('holds the rung and burns NOTHING once the day is spent', async () => {
    // Same invariant as the quiet-hours deferral, and for the same reason: the gate sits before the
    // atomic claim, so a held rung does not inflate the "chased N×" counter the persona cites as
    // evidence over a message nobody was sent.
    const device = reachableDevice('dev_bg1')
    updateSettings(device.deviceId, { quietHours: 'off', dailyMessageBudget: 1 })
    const first = await createReminder(device, { title: 'the bins', dueAtMillis: Date.now() - 1_000 })
    await runNudge(first.reminderId)
    expect(sends).toHaveLength(1)

    const second = await createReminder(device, { title: 'the washing', dueAtMillis: Date.now() - 1_000 })
    const before = getReminder(second.reminderId)!
    await runNudge(second.reminderId)

    expect(sends).toHaveLength(1)
    const after = getReminder(second.reminderId)!
    expect(after.nagCount).toBe(before.nagCount)
    // Pushed to the refill rather than dropped — it is still open and still needs chasing.
    expect(after.nextNagAtMillis).toBeGreaterThan(Date.now())
  })

  it('lets an escalating reminder through a spent budget', async () => {
    const device = reachableDevice('dev_bg2')
    updateSettings(device.deviceId, { quietHours: 'off', dailyMessageBudget: 1 })
    const first = await createReminder(device, { title: 'the bins', dueAtMillis: Date.now() - 1_000 })
    await runNudge(first.reminderId)
    expect(sends).toHaveLength(1)

    const urgent = await createReminder(device, {
      title: 'take the tablets',
      dueAtMillis: Date.now() - 1_000,
      escalateWithAlarm: true,
    })
    await runNudge(urgent.reminderId)
    expect(sends).toHaveLength(2)
  })

  it('does not hold anything at the default ceiling', async () => {
    const device = reachableDevice('dev_bg3')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const r = await createReminder(device, { title: 'the bins', dueAtMillis: Date.now() - 1_000 })
    await runNudge(r.reminderId)
    expect(sends).toHaveLength(1)
    expect(getReminder(r.reminderId)!.nagCount).toBe(1)
  })
})

describe('the escalation ring cooldown', () => {
  const armedFor = (reminderId: string): number =>
    db
      .select()
      .from(alarms)
      .all()
      .filter((a) => a.label === getReminder(reminderId)!.title).length

  it('rings once when the window is shut and the item is badly overdue', async () => {
    const device = reachableDevice('dev_esc1')
    updateSettings(device.deviceId, { quietHours: 'off' })
    outOfWindow.value = true
    const r = await createReminder(device, {
      title: 'take the tablets',
      dueAtMillis: Date.now() - 3 * 3_600_000,
      nagPolicy: 'relentless',
      escalateWithAlarm: true,
    })

    await runNudge(r.reminderId)
    expect(armedFor(r.reminderId)).toBe(1)
    expect(getReminder(r.reminderId)!.lastEscalatedAtMillis).not.toBeNull()
  })

  it('never rings the phone for something that cannot be late', async () => {
    // escalateWithAlarm buys three things — no quiet hours, no daily budget, and a ringing alarm
    // once badly overdue — all justified by "this is time-critical, wake them". None of them survive
    // without a due time: the ring is gated on being an hour past a deadline that does not exist, so
    // an undated escalating reminder would have had every safety valve switched off and the one
    // thing the flag is for permanently unreachable. It is still chased over WhatsApp.
    const device = reachableDevice('dev_esc_undated')
    updateSettings(device.deviceId, { quietHours: 'off' })
    outOfWindow.value = true
    const r = await createReminder(device, {
      title: 'sort the loft out',
      nagPolicy: 'relentless',
      escalateWithAlarm: true,
    })
    db.update(reminders)
      .set({ nextNagAtMillis: Date.now() - 1_000 })
      .where(eq(reminders.reminderId, r.reminderId))
      .run()

    await runNudge(r.reminderId)

    expect(armedFor(r.reminderId)).toBe(0)
    expect(getReminder(r.reminderId)!.lastEscalatedAtMillis).toBeNull()
    // The rung was still spent, so it is being chased — just not rung at.
    expect(getReminder(r.reminderId)!.nagCount).toBe(1)
  })

  it('does NOT ring again on the very next rung', async () => {
    // The failure this exists for. Escalation fires whenever a rung could not be delivered and the
    // item is an hour overdue, and it used to be bounded only by the ladder being short and slow.
    // At relentless's rung spacing every one of them would arm a real alarm: a phone ringing at
    // full volume every few minutes, for hours, with no way to stop it short of uninstalling.
    const device = reachableDevice('dev_esc2')
    updateSettings(device.deviceId, { quietHours: 'off' })
    outOfWindow.value = true
    const r = await createReminder(device, {
      title: 'take the tablets',
      dueAtMillis: Date.now() - 3 * 3_600_000,
      nagPolicy: 'relentless',
      escalateWithAlarm: true,
    })

    await runNudge(r.reminderId)
    const afterFirst = armedFor(r.reminderId)

    // Put the next rung due immediately, the way a five-minute ladder would a few minutes later.
    db.update(reminders)
      .set({ nextNagAtMillis: Date.now() - 1_000 })
      .where(eq(reminders.reminderId, r.reminderId))
      .run()
    await runNudge(r.reminderId)

    expect(armedFor(r.reminderId)).toBe(afterFirst)
  })

  it('rings again once the cooldown has genuinely elapsed', async () => {
    const device = reachableDevice('dev_esc3')
    updateSettings(device.deviceId, { quietHours: 'off' })
    outOfWindow.value = true
    const r = await createReminder(device, {
      title: 'take the tablets',
      dueAtMillis: Date.now() - 3 * 3_600_000,
      nagPolicy: 'relentless',
      escalateWithAlarm: true,
    })

    await runNudge(r.reminderId)
    const afterFirst = armedFor(r.reminderId)

    // Three hours since the last ring, which is past the two-hour cooldown.
    db.update(reminders)
      .set({ nextNagAtMillis: Date.now() - 1_000, lastEscalatedAtMillis: Date.now() - 3 * 3_600_000 })
      .where(eq(reminders.reminderId, r.reminderId))
      .run()
    await runNudge(r.reminderId)

    expect(armedFor(r.reminderId)).toBeGreaterThan(afterFirst)
  })

  it('never rings while the message is actually getting through', async () => {
    const device = reachableDevice('dev_esc4')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const r = await createReminder(device, {
      title: 'take the tablets',
      dueAtMillis: Date.now() - 3 * 3_600_000,
      escalateWithAlarm: true,
    })
    await runNudge(r.reminderId)
    expect(sends).toHaveLength(1)
    expect(getReminder(r.reminderId)!.lastEscalatedAtMillis).toBeNull()
  })
})
