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

const listEvents = vi.hoisted(() => vi.fn())
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(): void {}
      },
    },
    calendar: () => ({ events: { list: listEvents } }),
    tasks: () => ({ tasks: { insert: vi.fn() } }),
  },
}))

import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { googleAccounts, outbox } from '../src/db/schema.js'
import { getDevice, linkWhatsapp, markInbound, setTimezone, type Device } from '../src/services/devices.js'
import { enqueueOutbound, flushOutbox, pendingFor, shouldKnock } from '../src/services/outbox.js'
import { updateSettings } from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

// config.google is null in tests (setup-env.ts sets no GOOGLE_OAUTH_*), and oauthClient() throws on
// that before googleapis is reached. `config` is a plain object; `as const` is compile-time only.
Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

/**
 * The delivery half of the hard rule.
 *
 * `runNudge` stops a nudge before it is ever queued, but it is not the only producer: the brief, the
 * weekly review and the digest never go near it. This gate is what makes the rule true of all of
 * them at once, and it is the one place in outbox.ts that RETIRES a row rather than holding it.
 */

const ZONE = 'Europe/London'
const at = (localHHMM: string): number => Date.parse(`2026-09-10T${localHHMM}:00+01:00`)

function meeting(over: Record<string, unknown> = {}) {
  return {
    id: 'evt_sync',
    summary: 'Sync with Sam',
    status: 'confirmed',
    start: { dateTime: '2026-09-10T14:00:00+01:00' },
    end: { dateTime: '2026-09-10T15:00:00+01:00' },
    attendees: [{ email: 'me@example.com' }, { email: 'sam@example.com' }],
    organizer: { self: true },
    ...over,
  }
}

let seq = 0
function readyDevice(): { device: Device; wa: string } {
  const deviceId = `dev_oc${++seq}`
  const wa = `4477009${String(80000 + seq).padStart(5, '0')}`
  makeDevice(deviceId, null)
  setTimezone(deviceId, ZONE)
  linkWhatsapp(deviceId, wa)
  markInbound(deviceId)
  db.insert(googleAccounts).values({ deviceId, refreshToken: 'rt', updatedAt: Date.now() }).run()
  return { device: getDevice(deviceId)!, wa }
}

const statesFor = (wa: string): string[] =>
  db.select().from(outbox).where(eq(outbox.waUserId, wa)).all().map((r) => r.state)

beforeEach(() => {
  ensureSchema()
  vi.restoreAllMocks()
  sendMock.mockReset()
  sendMock.mockResolvedValue({ ok: true })
  templateMock.mockReset()
  templateMock.mockResolvedValue({ ok: true })
  listEvents.mockReset()
  listEvents.mockResolvedValue({ data: { items: [meeting()] } })
  vi.useFakeTimers()
  vi.setSystemTime(at('14:30'))
})

afterEach(() => vi.useRealTimers())

describe('the commitment gate at delivery', () => {
  it('drops a proactive message rather than saving it up', async () => {
    // DROPPED, not held. Walking out of an hour-long meeting into a burst of everything Otto held
    // back is the same interruption arriving late, and the owner asked for neither.
    const { device, wa } = readyDevice()
    enqueueOutbound({ waUserId: wa, deviceId: device.deviceId, kind: 'brief', body: 'your morning' })

    const delivered = await flushOutbox(wa, device.deviceId, { proactiveFor: device })

    expect(delivered).toEqual([])
    expect(sendMock).not.toHaveBeenCalled()
    // SUPERSEDED, not a new state: it already means "retired without ever being read", gc already
    // sweeps it, budget.ts does not count it, and nudgeHistory excludes it.
    expect(statesFor(wa)).toEqual(['SUPERSEDED'])
  })

  it('drops every kind, with no exempt list to argue about', async () => {
    const { device, wa } = readyDevice()
    for (const kind of ['nudge', 'brief', 'weekly', 'digest', 'system_warning', 'wake_check'] as const) {
      enqueueOutbound({ waUserId: wa, deviceId: device.deviceId, kind, body: `a ${kind}`, dedupeKey: `k:${kind}` })
    }

    await flushOutbox(wa, device.deviceId, { proactiveFor: device })

    expect(sendMock).not.toHaveBeenCalled()
    expect(statesFor(wa).every((s) => s === 'SUPERSEDED')).toBe(true)
  })

  it('still answers the owner when THEY are the ones who messaged', async () => {
    // The inbound flush passes no `proactiveFor`, and that is the whole distinction: this rule is
    // about Otto speaking first. Someone texting from a meeting has picked their phone up, and
    // destroying their queue as the price of answering them is not what was asked for.
    const { device, wa } = readyDevice()
    enqueueOutbound({ waUserId: wa, deviceId: device.deviceId, kind: 'brief', body: 'your morning' })

    const delivered = await flushOutbox(wa, device.deviceId)

    expect(delivered).toEqual(['your morning'])
    expect(statesFor(wa)).toEqual(['SENT'])
  })

  it('leaves a row the quiet-hours gate is already HOLDING alone', async () => {
    // Branch order, pinned. Both gates run on the same row, and holding must win: a brief queued at
    // 23:00 was never going out in this pass anyway, so retiring it here would destroy a message
    // that quiet hours only meant to postpone until seven.
    const { device, wa } = readyDevice()
    updateSettings(device.deviceId, { quietHours: '22:00-07:00' })
    vi.setSystemTime(at('23:00'))
    listEvents.mockResolvedValue({
      data: {
        items: [
          meeting({
            start: { dateTime: '2026-09-10T22:30:00+01:00' },
            end: { dateTime: '2026-09-10T23:30:00+01:00' },
          }),
        ],
      },
    })
    enqueueOutbound({ waUserId: wa, deviceId: device.deviceId, kind: 'brief', body: 'your evening' })

    await flushOutbox(wa, device.deviceId, { proactiveFor: device })

    expect(sendMock).not.toHaveBeenCalled()
    expect(statesFor(wa)).toEqual(['PENDING'])
    expect(pendingFor(wa)).toHaveLength(1)
  })

  it('sends normally the moment the meeting is over', async () => {
    const { device, wa } = readyDevice()
    vi.setSystemTime(at('15:00'))
    enqueueOutbound({ waUserId: wa, deviceId: device.deviceId, kind: 'brief', body: 'your morning' })

    const delivered = await flushOutbox(wa, device.deviceId, { proactiveFor: device })

    expect(delivered).toEqual(['your morning'])
  })
})

describe('shouldKnock', () => {
  it('will not knock on the lock screen during a meeting', async () => {
    // A template knock is a push notification, so it is a message by any honest reading of the rule,
    // and the queue behind it will still be there when the meeting ends.
    const { device } = readyDevice()
    const rows = [
      { id: 1, state: 'PENDING', kind: 'system_warning', expiresAtMillis: null },
    ] as unknown as Parameters<typeof shouldKnock>[0]['rows']
    const base = {
      rows,
      device: { ...device, lastInboundAt: null, lastTemplateAt: null },
      template: { name: 'otto_catch_up', lang: 'en' },
      now: at('14:30'),
      quietHours: null,
    }

    expect(shouldKnock(base)).toBe(true)
    expect(shouldKnock({ ...base, inCommitment: true })).toBe(false)
  })
})
