import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => [] as Array<{ token: string; data: Record<string, string> }>)
const sendOk = vi.hoisted(() => ({ value: true }))
vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async (token: string, data: Record<string, string>) => {
    sent.push({ token, data })
    return sendOk.value ? { ok: true as const } : { ok: false as const, dead: false, body: 'nope' }
  }),
}))

import { db, ensureSchema } from '../src/db/client.js'
import { devices } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { computeSig } from '../src/fcm/signer.js'
import { getDevice, type Device } from '../src/services/devices.js'
import { pushOutboxRow, pushReachable, withdrawNudge } from '../src/services/push.js'
import { makeDevice } from './helpers.js'

/** The app drops anything whose sig does not match, so an unsigned push is invisible from here. */
const signedCorrectly = (data: Record<string, string>, secret: string): boolean =>
  data.sig === computeSig(data, secret)

/** Every assertion below expects exactly one send; failing loudly beats a confusing index error. */
function only<T>(items: T[]): T {
  if (items.length !== 1) throw new Error(`expected exactly one item, got ${items.length}`)
  return items[0]!
}

/**
 * The second transport for the outbox. Everything here is about the property that makes it worth
 * having: a shut WhatsApp window used to be a wall, and a push has no window.
 */

beforeEach(() => {
  ensureSchema()
  sent.length = 0
  sendOk.value = true
})

const NOW = 1_800_000_000_000

/** A device the server believes it can reach: a token, a secret, and a recent heartbeat. */
function reachable(deviceId: string): Device {
  makeDevice(deviceId, 'tok_abc')
  db.update(devices).set({ lastHeartbeatAt: NOW - 60_000 }).where(eq(devices.deviceId, deviceId)).run()
  return getDevice(deviceId)!
}

const row = (over: Partial<{ id: number; kind: string; body: string; reminderId: string | null }> = {}) => ({
  id: 1,
  kind: 'nudge',
  body: 'Email Teal',
  reminderId: 'rem_1',
  ...over,
})

describe('pushReachable', () => {
  it('is true for a paired device with a token and a recent heartbeat', () => {
    expect(pushReachable(reachable('dev_p1'), NOW)).toBe(true)
  })

  it('is false without a token — there is nothing to send to', () => {
    const d = reachable('dev_p2')
    db.update(devices).set({ fcmToken: null }).where(eq(devices.deviceId, d.deviceId)).run()
    expect(pushReachable(getDevice(d.deviceId)!, NOW)).toBe(false)
  })

  it('is false when the phone has not been heard from in days', () => {
    // Guards against spending the day's message budget on pushes nobody receives — an app
    // force-stopped, uninstalled, or with a token that rotated while the phone was off.
    const d = reachable('dev_p3')
    db.update(devices).set({ lastHeartbeatAt: NOW - 30 * 24 * 3_600_000 }).where(eq(devices.deviceId, d.deviceId)).run()
    expect(pushReachable(getDevice(d.deviceId)!, NOW)).toBe(false)
  })

  it('is false for a device that has never checked in at all', () => {
    makeDevice('dev_p4', 'tok_x')
    expect(pushReachable(getDevice('dev_p4')!, NOW)).toBe(false)
  })
})

describe('pushOutboxRow', () => {
  it('sends a correctly signed NUDGE the app would accept', async () => {
    const device = reachable('dev_p5')
    expect(await pushOutboxRow(device, row(), NOW)).toBe(true)

    const data = only(sent).data
    expect(data.type).toBe('NUDGE')
    expect(data.v).toBe('1')
    // The signature is what the app checks before it will act on anything; an unsigned or
    // wrongly-signed push is silently dropped on the device and would be invisible from here.
    expect(signedCorrectly(data, device.hmacSecret)).toBe(true)
  })

  it('uses the REMINDER id, so a chase ladder replaces its own notification', async () => {
    // The single most important property of the payload. Without it, rung six leaves six
    // notifications for the owner to clear one at a time, which is unusable.
    const device = reachable('dev_p6')
    await pushOutboxRow(device, row({ id: 1, reminderId: 'rem_abc' }), NOW)
    await pushOutboxRow(device, row({ id: 2, reminderId: 'rem_abc' }), NOW)
    expect(sent.map((s) => s.data.nudgeId)).toEqual(['rem_abc', 'rem_abc'])
  })

  it('gives a row with no reminder an id of its own, so unrelated messages never collapse', async () => {
    const device = reachable('dev_p7')
    await pushOutboxRow(device, row({ id: 1, kind: 'brief', reminderId: null }), NOW)
    await pushOutboxRow(device, row({ id: 2, kind: 'brief', reminderId: null }), NOW)
    const ids = sent.map((s) => s.data.nudgeId)
    expect(new Set(ids).size).toBe(2)
  })

  it('puts Done and Snooze on a reminder chase and on nothing else', async () => {
    // The buttons map onto completeReminder and snoozeReminder, so offering them on a brief would
    // promise an action with nothing behind it.
    const device = reachable('dev_p8')
    await pushOutboxRow(device, row({ kind: 'nudge', reminderId: 'rem_1' }), NOW)
    expect(only(sent).data.actions).toBe('DONE,SNOOZE')

    sent.length = 0
    await pushOutboxRow(device, row({ kind: 'brief', reminderId: null }), NOW)
    expect(only(sent).data.actions).toBe('')
  })

  it('scales loudness to the kind — a scheduled summary must not buzz', async () => {
    const device = reachable('dev_p9')
    for (const [kind, level] of [
      ['brief', 'SILENT'],
      ['weekly', 'SILENT'],
      ['nudge', 'NORMAL'],
      ['missed_alarm', 'URGENT'],
      ['system_warning', 'URGENT'],
    ] as const) {
      sent.length = 0
      await pushOutboxRow(device, row({ kind, reminderId: null }), NOW)
      expect(only(sent).data.level, kind).toBe(level)
    }
  })

  it('truncates before signing, because an oversize payload fails SILENTLY', async () => {
    // fcm/sender.ts deliberately does not treat INVALID_ARGUMENT as a dead token, so a payload over
    // FCM's 4KB cap returns an error nobody acts on: the server records a successful chase and the
    // owner is never told anything.
    const device = reachable('dev_p10')
    await pushOutboxRow(device, row({ body: 'x'.repeat(10_000) }), NOW)
    const data = only(sent).data
    expect(data.title.length).toBeLessThanOrEqual(80)
    expect(data.body.length).toBeLessThanOrEqual(500)
    expect(signedCorrectly(data, device.hmacSecret)).toBe(true)
  })

  it('reports failure rather than throwing, so the caller can requeue', async () => {
    const device = reachable('dev_p11')
    sendOk.value = false
    expect(await pushOutboxRow(device, row(), NOW)).toBe(false)
  })

  it('sends nothing at all to an unreachable device', async () => {
    makeDevice('dev_p12', 'tok_x')
    expect(await pushOutboxRow(getDevice('dev_p12')!, row(), NOW)).toBe(false)
    expect(sent).toHaveLength(0)
  })
})

describe('withdrawNudge', () => {
  it('sends a signed CANCEL_NUDGE naming the reminder', async () => {
    const device = reachable('dev_p13')
    await withdrawNudge(device, 'rem_gone')
    const data = only(sent).data
    expect(data.type).toBe('CANCEL_NUDGE')
    expect(data.nudgeId).toBe('rem_gone')
    expect(signedCorrectly(data, device.hmacSecret)).toBe(true)
  })

  it('never throws, whatever the transport does', async () => {
    const device = reachable('dev_p14')
    sendOk.value = false
    await expect(withdrawNudge(device, 'rem_gone')).resolves.toBeUndefined()
  })
})

