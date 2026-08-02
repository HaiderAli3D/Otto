import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above the file body, so the mock fn must be created inside vi.hoisted.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn(async (): Promise<unknown> => ({ ok: true })) }))
vi.mock('../src/services/whatsapp.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, sendText: sendMock }
})

import { eq } from 'drizzle-orm'
import { db, ensureSchema } from '../src/db/client.js'
import { outbox } from '../src/db/schema.js'
import { markInbound } from '../src/services/devices.js'
import {
  MAX_OUTBOX_ATTEMPTS,
  enqueueOutbound,
  flushOutbox,
  pendingFor,
  supersedePending,
  windowOpen,
} from '../src/services/outbox.js'
import { makeDevice } from './helpers.js'

beforeEach(() => {
  ensureSchema()
  sendMock.mockReset()
  sendMock.mockResolvedValue({ ok: true })
})

const DAY = 24 * 60 * 60 * 1000

describe('24h window', () => {
  it('is shut when the owner has never messaged', () => {
    const device = makeDevice('dev_w1')
    expect(windowOpen({ ...device, lastInboundAt: null })).toBe(false)
  })

  it('is open just after an inbound', () => {
    const device = makeDevice('dev_w2')
    expect(windowOpen({ ...device, lastInboundAt: Date.now() })).toBe(true)
  })

  it('is shut once the message is a day old', () => {
    const device = makeDevice('dev_w3')
    expect(windowOpen({ ...device, lastInboundAt: Date.now() - DAY })).toBe(false)
  })

  it('closes early by a safety margin rather than racing Meta to the edge', () => {
    const device = makeDevice('dev_w4')
    // 10 minutes before the hard 24h edge: still inside for Meta, but we refuse to risk a 131047.
    expect(windowOpen({ ...device, lastInboundAt: Date.now() - (DAY - 10 * 60_000) })).toBe(false)
  })
})

describe('outbox', () => {
  it('queues a message and delivers it on flush', async () => {
    const device = makeDevice('dev_o1')
    markInbound(device.deviceId)
    enqueueOutbound({ waUserId: '4477', deviceId: device.deviceId, kind: 'nudge', body: 'bins' })
    expect(pendingFor('4477')).toHaveLength(1)

    const delivered = await flushOutbox('4477', device.deviceId)
    expect(delivered).toEqual(['bins'])
    expect(pendingFor('4477')).toHaveLength(0)
  })

  it('refuses a duplicate while one with the same dedupe key is still pending', () => {
    const device = makeDevice('dev_o2')
    const args = { waUserId: '4478', deviceId: device.deviceId, kind: 'nudge' as const, dedupeKey: 'nag:rem_1:0' }
    enqueueOutbound({ ...args, body: 'first' })
    enqueueOutbound({ ...args, body: 'second' })
    // The partial unique index is the primary double-nudge guard.
    expect(pendingFor('4478')).toHaveLength(1)
  })

  it('leaves the row PENDING when Meta says the window is shut', async () => {
    const device = makeDevice('dev_o3')
    sendMock.mockResolvedValue({ ok: false, permanent: true, status: 400, metaCode: 131047, outOfWindow: true, body: '' })
    enqueueOutbound({ waUserId: '4479', deviceId: device.deviceId, kind: 'nudge', body: 'bins' })

    const delivered = await flushOutbox('4479', device.deviceId)
    expect(delivered).toEqual([])
    // Still queued for real next contact — not dropped, not marked failed.
    expect(pendingFor('4479')).toHaveLength(1)
  })

  it('marks a genuinely bad message FAILED rather than retrying forever', async () => {
    const device = makeDevice('dev_o4')
    sendMock.mockResolvedValue({ ok: false, permanent: true, status: 400, metaCode: 100, outOfWindow: false, body: 'bad' })
    enqueueOutbound({ waUserId: '4480', deviceId: device.deviceId, kind: 'nudge', body: 'x' })
    await flushOutbox('4480', device.deviceId)
    expect(pendingFor('4480')).toHaveLength(0)
  })

  it('retires an expired message without sending it', async () => {
    const device = makeDevice('dev_o5')
    enqueueOutbound({ waUserId: '4481', deviceId: device.deviceId, kind: 'nudge', body: 'stale', ttlMs: -1 })
    const delivered = await flushOutbox('4481', device.deviceId)
    expect(delivered).toEqual([])
    expect(sendMock).not.toHaveBeenCalled()
    expect(pendingFor('4481')).toHaveLength(0)
  })

  it('retires a row that has exhausted its attempts instead of blocking the queue behind it', async () => {
    const device = makeDevice('dev_o7')
    markInbound(device.deviceId)
    // Transient forever: the transport is down, or this one message is somehow unsendable.
    sendMock.mockResolvedValue({ ok: false, permanent: false, status: 0, outOfWindow: false, body: 'retries exhausted' })
    const common = { waUserId: '4483', deviceId: device.deviceId, kind: 'nudge' as const }
    enqueueOutbound({ ...common, body: 'stuck', dedupeKey: 'n:stuck' })
    enqueueOutbound({ ...common, body: 'behind it', dedupeKey: 'n:behind' })

    // Each flush burns one attempt on the head row and stops — the row behind it is never tried.
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS - 1; i++) await flushOutbox('4483', device.deviceId)
    expect(pendingFor('4483').map((r) => r.body)).toEqual(['stuck', 'behind it'])

    // The attempt that reaches the cap gives up on the head row rather than blocking on it forever.
    await flushOutbox('4483', device.deviceId)
    expect(pendingFor('4483').map((r) => r.body)).toEqual(['behind it'])
    const retired = db.select().from(outbox).where(eq(outbox.body, 'stuck')).get()
    // FAILED, not deleted: the audit trail is the point of keeping outbox rows around.
    expect(retired?.state).toBe('FAILED')
    expect(retired?.attempts).toBe(MAX_OUTBOX_ATTEMPTS)

    // …and the message that was stuck behind it goes out as soon as sending works again.
    sendMock.mockResolvedValue({ ok: true })
    expect(await flushOutbox('4483', device.deviceId)).toEqual(['behind it'])
  })

  it('supersedes queued nudges when the reminder is completed', () => {
    const device = makeDevice('dev_o6')
    enqueueOutbound({
      waUserId: '4482',
      deviceId: device.deviceId,
      kind: 'nudge',
      body: 'bins',
      reminderId: 'rem_x',
    })
    supersedePending('rem_x')
    expect(pendingFor('4482')).toHaveLength(0)
  })
})
