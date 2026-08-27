import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above the file body, so the mock fns must be created inside vi.hoisted.
const { sendMock, templateMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  templateMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
}))
vi.mock('../src/services/whatsapp.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, sendText: sendMock, sendTemplate: templateMock }
})
// The FCM transport, mocked for the same reason WhatsApp is: these tests are about which transport
// a row takes and what state it ends in, not about Firebase. Left unmocked, every push in this file
// would fail against real credentials that do not exist and the phone tier would look unreachable.
vi.mock('../src/fcm/sender.js', () => ({ sendData: vi.fn(async () => ({ ok: true as const })) }))

import { DateTime } from 'luxon'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { devices, outbox } from '../src/db/schema.js'
import {
  clearInboundWindow,
  getDevice,
  linkWhatsapp,
  markInbound,
  markTemplateSent,
  type Device,
} from '../src/services/devices.js'
import {
  MAX_OUTBOX_ATTEMPTS,
  TEMPLATE_COOLDOWN_MS,
  enqueueAndTryFlush,
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

// One case fakes Date to drive a claim past STALE_CLAIM_MS; a fake clock leaking into the next file
// would be far harder to diagnose than it is to reset here.
afterEach(() => {
  vi.useRealTimers()
})

const DAY = 24 * 60 * 60 * 1000

/** A quiet window that certainly contains `at`, in the device zone (UTC under vitest). */
function windowAround(at: number): string {
  const dt = DateTime.fromMillis(at, { zone: 'UTC' })
  const hhmm = (d: DateTime): string => d.toFormat('HH:mm')
  return `${hhmm(dt.minus({ minutes: 90 }))}-${hhmm(dt.plus({ hours: 3 }))}`
}

/** A window that certainly does NOT contain `at`, and ends comfortably before it. */
function windowBefore(at: number): string {
  const dt = DateTime.fromMillis(at, { zone: 'UTC' })
  const hhmm = (d: DateTime): string => d.toFormat('HH:mm')
  return `${hhmm(dt.minus({ hours: 5 }))}-${hhmm(dt.minus({ hours: 2 }))}`
}

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
    // The window has to be OPEN for WhatsApp to be attempted at all now: a shut one no longer
    // reaches `sendText`, it goes straight to the phone tier. Without this the row comes back
    // PENDING because the push had nowhere to go, and the assertion below would be about the
    // wrong thing entirely.
    markInbound(device.deviceId)
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
describe('a shut window waits for WhatsApp; it never reaches for the phone', () => {
  /**
   * The phone is an ALARM device. It rings when the owner asked to be woken or asked for a ring; it
   * does not carry conversation, chases, briefs or reviews. Everything Otto SAYS arrives in the
   * WhatsApp thread, so there is one surface to look at and one to mute.
   *
   * These tests briefly asserted the opposite. `pushOutboxRow` had been unreachable since it was
   * written, an audit called that a defect, and making it reachable turned every shut-window message
   * into an Android notification — which is not what this product is. The transport comment in
   * `services/outbox.ts` is the decision; this is the pin on it.
   */
  const reachable = (deviceId: string): Device => {
    const device = makeDevice(deviceId, 'tok_push')
    db.update(devices)
      .set({ lastHeartbeatAt: Date.now() - 60_000, appVersion: '1.3.0' })
      .where(eq(devices.deviceId, deviceId))
      .run()
    return getDevice(deviceId)!
  }

  it('leaves the row queued even when the phone is perfectly reachable', async () => {
    const device = reachable('dev_push1')
    // No markInbound: the window has never been open, which is the whole point.
    const sent = await enqueueAndTryFlush({
      waUserId: '4491',
      deviceId: device.deviceId,
      kind: 'brief',
      body: 'three things today',
    })

    expect(sent).toBe(false)
    const rows = db.select().from(outbox).where(eq(outbox.waUserId, '4491')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('PENDING')
    expect(rows[0]!.deliveredVia).toBeNull()
    // WhatsApp was not attempted either — there is no window to attempt it through.
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not strand the row in SENDING while it waits', async () => {
    // The bail has to sit ABOVE the claim. Breaking after it leaves the row SENDING with nobody to
    // release it for two minutes — invisible to `pendingFor`, which is long enough for the sweep
    // that follows to think the queue is empty and skip the knock.
    const device = reachable('dev_push2')
    enqueueOutbound({ waUserId: '4492', deviceId: device.deviceId, kind: 'nudge', body: 'bins' })

    await flushOutbox('4492', device.deviceId, { proactiveFor: device })

    expect(pendingFor('4492')).toHaveLength(1)
  })

  it('sweeps without sending anything to the phone, and leaves the queue for a knock', async () => {
    const device = reachable('dev_push4')
    linkWhatsapp(device.deviceId, '4494')
    enqueueOutbound({ waUserId: '4494', deviceId: device.deviceId, kind: 'brief', body: 'morning' })

    await sweepOutbox(Date.now())

    // Still there, still PENDING, still nothing delivered by any other route.
    expect(pendingFor('4494')).toHaveLength(1)
    expect(db.select().from(outbox).where(eq(outbox.waUserId, '4494')).all()[0]!.deliveredVia).toBeNull()
  })

  it('delivers the moment the owner says anything, which is what reopens the window', async () => {
    const device = reachable('dev_push5')
    linkWhatsapp(device.deviceId, '4495')
    enqueueOutbound({ waUserId: '4495', deviceId: device.deviceId, kind: 'brief', body: 'morning' })
    expect(pendingFor('4495')).toHaveLength(1)

    markInbound(device.deviceId)
    await flushOutbox('4495', device.deviceId)

    expect(pendingFor('4495')).toHaveLength(0)
    expect(db.select().from(outbox).where(eq(outbox.waUserId, '4495')).all()[0]!.deliveredVia).toBe('whatsapp')
  })
})

describe('one bad send must not empty the queue', () => {
  it('leaves every row PENDING on an account-level failure', async () => {
    // `graphFetch` classes every non-429 4xx as permanent with no retry, and this branch used to
    // stamp FAILED — terminal — and then `continue`, walking the whole queue and doing the same to
    // every row behind it. One expired token discarded the day's brief, every queued chase and any
    // arm-ack warning inside a single five-minute tick.
    const device = makeDevice('dev_burn1')
    markInbound(device.deviceId)
    sendMock.mockResolvedValue({ ok: false, permanent: true, status: 401, outOfWindow: false, body: 'bad token' })
    for (const body of ['one', 'two', 'three']) {
      enqueueOutbound({ waUserId: '4495', deviceId: device.deviceId, kind: 'nudge', body })
    }

    await flushOutbox('4495', device.deviceId)

    expect(pendingFor('4495')).toHaveLength(3)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('retires a genuinely bad message but still stops the pass', async () => {
    const device = makeDevice('dev_burn2')
    markInbound(device.deviceId)
    sendMock.mockResolvedValue({ ok: false, permanent: true, status: 400, metaCode: 100, outOfWindow: false, body: 'bad' })
    for (const body of ['one', 'two']) {
      enqueueOutbound({ waUserId: '4496', deviceId: device.deviceId, kind: 'nudge', body })
    }

    await flushOutbox('4496', device.deviceId)

    // The head is retired; the one behind it keeps its place rather than being burned with it.
    expect(pendingFor('4496')).toHaveLength(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})

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

  it('DOES knock for a nudge, now that the knock is the whole fallback', () => {
    // This used to be false, on the argument that a chase is gentle and "knocking on a shut window
    // with a push notification is the opposite of gentle". That reasoning was about a PUSH. A
    // template knock is a WhatsApp message asking the owner to reply, in the same thread as
    // everything else Otto says — and the alternative is now silence, because the phone no longer
    // carries anything Otto says.
    expect(shouldKnock({ ...base, rows: [row({ kind: 'nudge' })] })).toBe(true)
    expect(shouldKnock({ ...base, rows: [row({ kind: 'brief' })] })).toBe(true)
  })

  it('still never knocks to deliver a digest', () => {
    // Circular: a digest summarises things the owner already did not see, and whatever it
    // summarises is in this same queue and will knock on its own account.
    expect(shouldKnock({ ...base, rows: [row({ kind: 'digest' })] })).toBe(false)
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

/** A device with a linked number, fetched back so lastInboundAt/lastTemplateAt are current. */
const linked = (deviceId: string, waNumber: string): Device => {
  const device = makeDevice(deviceId, null)
  linkWhatsapp(device.deviceId, waNumber)
  return getDevice(device.deviceId)!
}

/**
 * Quiet hours are a DELIVERY-time gate, not a per-producer convention.
 *
 * `promptSections.ts` (# Quiet hours) promises the owner that anything Otto schedules inside their
 * window is moved to the end of it, and names exactly four exceptions. Until the four features were
 * merged, the only code enforcing that was the nudge ladder — so the brief, the weekly review and
 * the five-minute sweep, all built beside it, each spoke first inside a window Otto had just
 * confirmed. Every case below pins the window explicitly rather than leaning on the 22:00–07:00
 * default, because the suite runs at whatever the wall clock happens to be.
 */
describe('quiet hours gate proactive delivery', () => {
  it('holds a brief queued inside the window, and delivers it once the window ends', async () => {
    const device = linked('dev_q1', '447700900201')
    markInbound(device.deviceId)
    updateSettings(device.deviceId, { quietHours: windowAround(Date.now()) })

    const sent = await enqueueAndTryFlush({
      waUserId: '447700900201',
      deviceId: device.deviceId,
      kind: 'brief',
      body: 'Dentist 14:00.',
      dedupeKey: 'q:brief',
    })

    // Otto told them "nothing before 8". The row waits rather than making a liar of him.
    expect(sent).toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
    expect(pendingFor('447700900201')).toHaveLength(1)

    // Held, not retired: the very next sweep after the window ends delivers it.
    //
    // Asserted on THIS number rather than on a global call count. `sweepOutbox` visits every device
    // in the database and this file shares one, so the count depends on what every test above
    // happens to have left queued — which is a fixture detail, not the behaviour under test.
    updateSettings(device.deviceId, { quietHours: windowBefore(Date.now()) })
    sendMock.mockClear()
    await sweepOutbox(Date.now())
    expect(sendMock.mock.calls.filter((c) => c[0] === '447700900201')).toHaveLength(1)
    expect(pendingFor('447700900201')).toHaveLength(0)
  })

  it('holds the 02:00 system warning the sweep used to deliver', async () => {
    // `shouldKnock` already refuses to light up a lock screen at 3am for exactly this row. The
    // free-form path had no such check, so the same warning went out at 02:12 whenever the 24h
    // window happened to be open — two code paths for one message, disagreeing about 2am.
    const device = linked('dev_q2', '447700900202')
    markInbound(device.deviceId)
    updateSettings(device.deviceId, { quietHours: windowAround(Date.now()) })
    enqueueOutbound({
      waUserId: '447700900202',
      deviceId: device.deviceId,
      kind: 'system_warning',
      body: "⚠️ I couldn't confirm your alarm reached your phone.",
    })

    await sweepOutbox(Date.now())

    expect(sendMock).not.toHaveBeenCalled()
    expect(pendingFor('447700900202')).toHaveLength(1)
    // Shut the window on the way out. The DB is shared across this file and `sweepOutbox` walks
    // every device, so a leftover row behind an OPEN window makes later sweeps yield here first —
    // which is exactly what the overlap case below is timing. Every other test in this file that
    // parks a PENDING row leaves it behind a shut window for the same reason.
    clearInboundWindow(device.deviceId)
  })

  it('never holds a wake-check or a nudge — those are two of the four exceptions', async () => {
    // A 06:30 "you up?" inside a 22:00–07:00 window is the entire wake-check feature, and the nudge
    // ladder has already applied its own quiet-hours rules (owner-chosen due time, escalating
    // reminder) before a rung ever reaches the outbox. Gating either here would undo both.
    const device = linked('dev_q3', '447700900203')
    markInbound(device.deviceId)
    updateSettings(device.deviceId, { quietHours: windowAround(Date.now()) })

    expect(
      await enqueueAndTryFlush({
        waUserId: '447700900203',
        deviceId: device.deviceId,
        kind: 'wake_check',
        body: 'You up?',
        dedupeKey: 'q:wake',
      }),
    ).toBe(true)
    expect(
      await enqueueAndTryFlush({
        waUserId: '447700900203',
        deviceId: device.deviceId,
        kind: 'nudge',
        body: 'Still need to call the dentist?',
        dedupeKey: 'q:nudge',
      }),
    ).toBe(true)
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('lets an exempt row past a held one instead of queueing behind it', async () => {
    // `continue`, not `break`. A brief held until 07:00 must not take the wake-check queued behind
    // it down as well — that one is the whole reason the owner is being asked anything.
    const device = linked('dev_q4', '447700900204')
    markInbound(device.deviceId)
    updateSettings(device.deviceId, { quietHours: windowAround(Date.now()) })
    const common = { waUserId: '447700900204', deviceId: device.deviceId }
    enqueueOutbound({ ...common, kind: 'brief', body: 'the brief', dedupeKey: 'q2:brief' })
    enqueueOutbound({ ...common, kind: 'wake_check', body: 'You up?', dedupeKey: 'q2:wake' })

    await sweepOutbox(Date.now())

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(pendingFor('447700900204').map((r) => r.kind)).toEqual(['brief'])
    clearInboundWindow(device.deviceId)
  })

  it('never holds the owner\'s own queue back from them when THEY message', async () => {
    // "Replying to them is never held back. Quiet hours are about you speaking first." An inbound
    // at 02:00 is the owner awake and asking; withholding what is queued for them is not what quiet
    // hours mean, and it is the one flush that passes no `proactiveFor`.
    const device = linked('dev_q5', '447700900205')
    markInbound(device.deviceId)
    updateSettings(device.deviceId, { quietHours: windowAround(Date.now()) })
    enqueueOutbound({ waUserId: '447700900205', deviceId: device.deviceId, kind: 'brief', body: 'the brief' })

    expect(await flushOutbox('447700900205', device.deviceId)).toEqual(['the brief'])
  })
})

describe('enqueueAndTryFlush records what it delivered', () => {
  it('writes the delivered message into the transcript, exactly as the sweep does', async () => {
    // The perverse half of this hole was WHICH case lost the record: this path only flushes when
    // the window is OPEN — precisely when the owner is around to reply to the message. So the 07:00
    // brief was invisible at 07:02, and `promptSections.ts` (# Proactive messages) tells the model
    // those turns are there. Otto re-lists what he named ninety seconds earlier.
    const device = linked('dev_q6', '447700900206')
    markInbound(device.deviceId)
    updateSettings(device.deviceId, { quietHours: 'off' })
    saveSession('447700900206', device.deviceId, [{ role: 'user', content: 'morning' }])

    await enqueueAndTryFlush({
      waUserId: '447700900206',
      deviceId: device.deviceId,
      kind: 'brief',
      body: 'Dentist 14:00. Bins still not out — chased 3×.',
      dedupeKey: 'q:brief2',
    })

    expect(loadSession('447700900206')).toEqual([
      { role: 'user', content: 'morning' },
      { role: 'assistant', content: 'Dentist 14:00. Bins still not out — chased 3×.' },
    ])
  })
})

describe('sweepOutbox', () => {

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

    // Filtered to THIS number rather than counted globally: `sweepOutbox` visits every device in the
    // database, this file shares one, and the widened KNOCK_KINDS means other devices' queued
    // nudges and briefs are now knockable too.
    const ours = templateMock.mock.calls.filter((c) => c[0] === '447700900105')
    expect(ours).toHaveLength(1)
    expect(ours[0]).toEqual(['447700900105', ['something']])
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
    //
    // Asserted through the transcript rather than by naming the loser. The commitment gate put an
    // await in the PROACTIVE path before the claim, so the sweep now yields once before it takes
    // the row and the webhook chain gets there first — which of the two wins is timing, and always
    // was. What must never change is that only one of them reports it: the sweep appends its own
    // delivered list internally, this appends the webhook's, and a double-report shows up here as
    // two assistant turns whichever way round the race fell.
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

  it('stamps each claim with its OWN instant, so a slow flush cannot release its own rows', async () => {
    // `sentAtMillis` doubles as the claim stamp and `releaseStaleClaims` hands back anything older
    // than STALE_CLAIM_MS. Stamped with the `now` captured before the loop, a flush that has already
    // been running longer than that — five rows against a Meta throwing 429s is ~32s each — marks
    // every row it claims from then on as stale ON ARRIVAL. The next sweep takes one back mid-send
    // and the owner gets it twice.
    const device = linked('dev_s11', '447700900110')
    markInbound(device.deviceId)
    updateSettings(device.deviceId, { quietHours: 'off' })
    const common = { waUserId: '447700900110', deviceId: device.deviceId, kind: 'nudge' as const }
    enqueueOutbound({ ...common, body: 'first', dedupeKey: 'c:1' })
    enqueueOutbound({ ...common, body: 'second', dedupeKey: 'c:2' })

    const start = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    let call = 0
    let competing: string[] = []
    sendMock.mockImplementation(async () => {
      call += 1
      // The first send takes longer than the whole stale-claim window.
      if (call === 1) vi.setSystemTime(start + 130_000)
      // The five-minute sweep lands while the SECOND row is on the wire. It must find nothing.
      if (call === 2) competing = await flushOutbox('447700900110', device.deviceId)
      return { ok: true }
    })

    const delivered = await flushOutbox('447700900110', device.deviceId)

    expect(delivered).toEqual(['first', 'second'])
    expect(competing).toEqual([])
    // Two sends, not three: 'second' went out exactly once.
    expect(sendMock).toHaveBeenCalledTimes(2)
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
