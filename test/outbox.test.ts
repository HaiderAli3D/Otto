import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above the file body, so the mock fns must be created inside vi.hoisted.
const { sendMock, templateMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  templateMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
}))
vi.mock('../src/services/whatsapp.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, sendText: sendMock, sendTemplate: templateMock }
})

import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { outbox } from '../src/db/schema.js'
import { getDevice, linkWhatsapp, markInbound, markTemplateSent, type Device } from '../src/services/devices.js'
import {
  MAX_OUTBOX_ATTEMPTS,
  TEMPLATE_COOLDOWN_MS,
  enqueueOutbound,
  flushOutbox,
  pendingFor,
  shouldKnock,
  supersedePending,
  sweepOutbox,
  windowOpen,
  type OutboxRow,
} from '../src/services/outbox.js'
import { appendAssistantTurns, loadSession, saveSession } from '../src/services/sessions.js'
import { updateSettings } from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

beforeEach(() => {
  ensureSchema()
  // Restore FIRST: a `config.meta` spy left standing by a test that failed before its trailing
  // restoreAllMocks would hand every later test a registered template it never asked for.
  vi.restoreAllMocks()
  sendMock.mockReset()
  sendMock.mockResolvedValue({ ok: true })
  templateMock.mockReset()
  templateMock.mockResolvedValue({ ok: true })
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

/**
 * PURE policy: the template is passed in rather than read from config, and the quiet window is
 * handed over explicitly, so every rule is assertable without an environment or a DB row.
 */
describe('shouldKnock', () => {
  const TEMPLATE = { name: 'otto_catch_up', lang: 'en' }
  const NOW = Date.UTC(2026, 6, 1, 12, 0, 0)

  const device = (over: Partial<Device> = {}): Device =>
    ({
      deviceId: 'dev_k',
      timezone: 'Europe/London',
      lastInboundAt: null,
      lastTemplateAt: null,
      ...over,
    }) as Device

  const row = (over: Partial<OutboxRow> = {}): OutboxRow =>
    ({
      id: 1,
      kind: 'system_warning',
      state: 'PENDING',
      expiresAtMillis: NOW + DAY,
      ...over,
    }) as OutboxRow

  const base = { rows: [row()], device: device(), template: TEMPLATE, now: NOW, quietHours: null }

  it('knocks when every rule holds', () => {
    expect(shouldKnock(base)).toBe(true)
  })

  it('never knocks without a registered template', () => {
    expect(shouldKnock({ ...base, template: null })).toBe(false)
  })

  it('never knocks while the window is still open — the real queue goes out as itself', () => {
    expect(shouldKnock({ ...base, device: device({ lastInboundAt: NOW - 60_000 }) })).toBe(false)
  })

  it('never knocks for a nudge — chasing gently is the opposite of a push notification', () => {
    expect(shouldKnock({ ...base, rows: [row({ kind: 'nudge' })] })).toBe(false)
  })

  it('never knocks for a digest either', () => {
    expect(shouldKnock({ ...base, rows: [row({ kind: 'digest' })] })).toBe(false)
  })

  it('knocks for a missed alarm', () => {
    expect(shouldKnock({ ...base, rows: [row({ kind: 'missed_alarm' })] })).toBe(true)
  })

  it('ignores rows that are not PENDING', () => {
    expect(shouldKnock({ ...base, rows: [row({ state: 'SENT' })] })).toBe(false)
  })

  it('ignores an already-expired row — there is nothing left to deliver', () => {
    expect(shouldKnock({ ...base, rows: [row({ expiresAtMillis: NOW - 1 })] })).toBe(false)
  })

  it('picks the one knock-worthy row out of a queue of nudges', () => {
    expect(shouldKnock({ ...base, rows: [row({ id: 1, kind: 'nudge' }), row({ id: 2, kind: 'missed_alarm' })] })).toBe(true)
  })

  it('respects the 6h cooldown', () => {
    const recent = device({ lastTemplateAt: NOW - (TEMPLATE_COOLDOWN_MS - 60_000) })
    expect(shouldKnock({ ...base, device: recent })).toBe(false)

    const old = device({ lastTemplateAt: NOW - (TEMPLATE_COOLDOWN_MS + 60_000) })
    expect(shouldKnock({ ...base, device: old })).toBe(true)
  })

  it('stays quiet during quiet hours — a template lights up a lock screen', () => {
    // 23:00 local, inside 22:00–07:00. Nothing in KNOCK_KINDS improves for being read at 3am.
    const night = Date.UTC(2026, 0, 15, 23, 0, 0)
    const quiet = { startMinute: 22 * 60, endMinute: 7 * 60 }
    expect(shouldKnock({ ...base, now: night, quietHours: quiet })).toBe(false)
    expect(shouldKnock({ ...base, now: night, quietHours: null })).toBe(true)
  })
})

describe('sweepOutbox', () => {
  /** A device with a linked number, fetched back so lastInboundAt/lastTemplateAt are current. */
  const linked = (deviceId: string, waNumber: string): Device => {
    const device = makeDevice(deviceId, null)
    linkWhatsapp(device.deviceId, waNumber)
    return getDevice(device.deviceId)!
  }

  it('flushes the queue when the window is open', async () => {
    const device = linked('dev_s1', '447700900101')
    markInbound(device.deviceId)
    enqueueOutbound({ waUserId: '447700900101', deviceId: device.deviceId, kind: 'nudge', body: 'the bins' })

    await sweepOutbox(Date.now())

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(pendingFor('447700900101')).toHaveLength(0)
  })

  it('records what it delivered as Otto own turns — this coupling is not optional', async () => {
    // Without it the model has no idea what it said between turns, and the owner's "done" answers a
    // message the transcript does not contain. The inbound path does exactly this; so must the sweep.
    const device = linked('dev_s2', '447700900102')
    markInbound(device.deviceId)
    saveSession('447700900102', device.deviceId, [{ role: 'user', content: 'morning' }])
    enqueueOutbound({ waUserId: '447700900102', deviceId: device.deviceId, kind: 'nudge', body: 'still the bins' })

    await sweepOutbox(Date.now())

    expect(loadSession('447700900102')).toEqual([
      { role: 'user', content: 'morning' },
      { role: 'assistant', content: 'still the bins' },
    ])
  })

  it('does NOT flush while the window is shut', async () => {
    const device = linked('dev_s3', '447700900103')
    enqueueOutbound({ waUserId: '447700900103', deviceId: device.deviceId, kind: 'nudge', body: 'queued' })

    await sweepOutbox(Date.now())

    expect(sendMock).not.toHaveBeenCalled()
    expect(templateMock).not.toHaveBeenCalled() // no template registered in the test env
    expect(pendingFor('447700900103')).toHaveLength(1)
  })

  it('retires a TTL-expired PENDING row with NO contact at all', async () => {
    // Before the sweep this only happened inside flushOutbox — i.e. only when the owner made
    // contact — so a queue built up while they were away kept stale rows alive precisely when they
    // were most stale.
    const device = linked('dev_s4', '447700900104')
    enqueueOutbound({ waUserId: '447700900104', deviceId: device.deviceId, kind: 'nudge', body: 'stale', ttlMs: -1 })

    await sweepOutbox(Date.now())

    expect(sendMock).not.toHaveBeenCalled()
    expect(templateMock).not.toHaveBeenCalled()
    expect(pendingFor('447700900104')).toHaveLength(0)
    expect(db.select().from(outbox).where(eq(outbox.body, 'stale')).get()?.state).toBe('EXPIRED')
  })

  it('knocks with a template when the window is shut and something important is waiting', async () => {
    const device = linked('dev_s5', '447700900105')
    enqueueOutbound({
      waUserId: '447700900105',
      deviceId: device.deviceId,
      kind: 'system_warning',
      body: "⚠️ I couldn't confirm your alarm reached your phone.",
    })

    // The owner HAS registered otto_catch_up; setup-env deliberately leaves it unset so the rest of
    // the suite sees the "no template" world. Quiet hours are switched off explicitly rather than
    // left to the 22:00–07:00 default, or this test would fail for anyone running it at night.
    const meta = config.meta!
    vi.spyOn(config, 'meta', 'get').mockReturnValue({ ...meta, template: { name: 'otto_catch_up', lang: 'en' } })
    updateSettings(device.deviceId, { quietHours: 'off' })

    await sweepOutbox(Date.now())

    expect(templateMock).toHaveBeenCalledTimes(1)
    expect(templateMock.mock.calls[0]).toEqual(['447700900105', ['something']])
    // Stamped, so the 6h cooldown starts now rather than on the next sweep five minutes later.
    expect(getDevice(device.deviceId)?.lastTemplateAt).not.toBeNull()
    // …and the queue is untouched: a template knocks, it does not deliver.
    expect(pendingFor('447700900105')).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('leaves the queue PENDING after a knock — a template does not reopen the window', async () => {
    const device = linked('dev_s6', '447700900106')
    enqueueOutbound({ waUserId: '447700900106', deviceId: device.deviceId, kind: 'missed_alarm', body: 'you slept through it' })
    markTemplateSent(device.deviceId, Date.now())

    await sweepOutbox(Date.now())

    // Cooldown blocks the knock, and nothing free-form may go out either. The row waits.
    expect(sendMock).not.toHaveBeenCalled()
    expect(pendingFor('447700900106')).toHaveLength(1)
  })

  it('skips devices with no WhatsApp number at all', async () => {
    makeDevice('dev_s7', null)
    enqueueOutbound({ waUserId: '447700900199', deviceId: 'dev_s7', kind: 'nudge', body: 'orphan' })

    await sweepOutbox(Date.now())

    expect(sendMock).not.toHaveBeenCalled()
    expect(pendingFor('447700900199')).toHaveLength(1)
  })

  it('sends a queued message ONCE when the sweep and the webhook flush overlap', async () => {
    // The scheduler tick and the Fastify webhook are independent promise chains, and `await
    // sendText` yields between reading a PENDING row and retiring it. Without a claim both chains
    // read the SAME row: the owner gets the nudge twice and the transcript gets two identical
    // assistant turns. Turning the sweep on made this a standing five-minute exposure rather than
    // a nudge-time coincidence, which is why the claim lives in flushOutbox itself.
    const device = linked('dev_s8', '447700900107')
    markInbound(device.deviceId)
    saveSession('447700900107', device.deviceId, [{ role: 'user', content: 'morning' }])
    enqueueOutbound({ waUserId: '447700900107', deviceId: device.deviceId, kind: 'nudge', body: 'ONE NUDGE' })

    // Hold the first send open so the second chain starts while the first is still mid-flight —
    // the exact interleaving the claim exists to lose.
    let release = (): void => {}
    const inFlight = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    sendMock.mockImplementation(async () => {
      await inFlight
      return { ok: true }
    })

    const sweep = sweepOutbox(Date.now())
    const webhook = flushOutbox('447700900107', device.deviceId)
    release()
    const [, alsoDelivered] = await Promise.all([sweep, webhook])

    expect(sendMock).toHaveBeenCalledTimes(1)
    // Exactly one chain may claim the delivery. The loser reporting it too is what writes the
    // duplicate assistant turn — this is verbatim what routes/whatsapp.ts does with the bodies its
    // flush returns, and appendAssistantTurns has no dedupe of its own.
    expect(alsoDelivered).toEqual([])
    appendAssistantTurns('447700900107', device.deviceId, alsoDelivered)
    expect(loadSession('447700900107').filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(pendingFor('447700900107')).toHaveLength(0)
  })

  it('takes back a claim orphaned by a crash instead of losing the message forever', async () => {
    // The flip side of claiming: a row parked in SENDING is invisible to `pendingFor`, so a process
    // that died mid-send would strand it in a state no sweep, no flush and no gc pass ever looks at.
    const device = linked('dev_s9', '447700900108')
    markInbound(device.deviceId)
    enqueueOutbound({ waUserId: '447700900108', deviceId: device.deviceId, kind: 'nudge', body: 'orphaned' })
    // Exactly what a crash leaves behind: claimed, stamped, never resolved.
    db.update(outbox)
      .set({ state: 'SENDING', sentAtMillis: Date.now() - 10 * 60_000 })
      .where(eq(outbox.waUserId, '447700900108'))
      .run()
    expect(pendingFor('447700900108')).toHaveLength(0)

    expect(await flushOutbox('447700900108', device.deviceId)).toEqual(['orphaned'])
  })

  it('starts the knock cooldown on the ATTEMPT, not on the outcome', async () => {
    // sendTemplate calls an abort/timeout and a 5xx transient, and a template Meta ACTUALLY
    // DELIVERED but whose response we lost is indistinguishable from one that never landed. Stamped
    // only on success, an hour of Meta trouble is twelve lock-screen pushes.
    const device = linked('dev_s10', '447700900109')
    enqueueOutbound({
      waUserId: '447700900109',
      deviceId: device.deviceId,
      kind: 'missed_alarm',
      body: 'you slept through it',
    })
    const meta = config.meta!
    vi.spyOn(config, 'meta', 'get').mockReturnValue({ ...meta, template: { name: 'otto_catch_up', lang: 'en' } })
    updateSettings(device.deviceId, { quietHours: 'off' })
    // graphFetch's "retries exhausted" — the shape sendTemplate returns for a timeout or a 5xx.
    templateMock.mockResolvedValue({ ok: false, permanent: false, status: 0, outOfWindow: false, body: 'retries exhausted' })

    const start = Date.now()
    await sweepOutbox(start)
    await sweepOutbox(start + 60_000)
    await sweepOutbox(start + 120_000)

    expect(templateMock).toHaveBeenCalledTimes(1)
    expect(getDevice(device.deviceId)?.lastTemplateAt).toBe(start)
    // …and the queue is still waiting, so the owner loses nothing by the suppression.
    expect(pendingFor('447700900109')).toHaveLength(1)
    vi.restoreAllMocks()
  })
})
