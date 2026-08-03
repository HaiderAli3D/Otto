import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above the file body, so every mock fn must be created inside vi.hoisted.
const { runAgentTurnMock, sendMock, fetchMediaMock } = vi.hoisted(() => ({
  runAgentTurnMock: vi.fn(async (): Promise<string> => 'done'),
  sendMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  fetchMediaMock: vi.fn(),
}))

vi.mock('../src/fcm/sender.js', () => ({ sendData: vi.fn(async () => ({ ok: true as const })) }))
vi.mock('../src/agent/runner.js', () => ({ runAgentTurn: runAgentTurnMock }))
// PARTIAL: verifySignature and parseInboundMessages must stay real — the signature check is half of
// what this file exists to cover.
vi.mock('../src/services/whatsapp.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, sendText: sendMock }
})
vi.mock('../src/services/media.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, fetchMedia: fetchMediaMock }
})

import { createHmac } from 'node:crypto'
import { ensureSchema } from '../src/db/client.js'
import { clearInboundWindow, getDevice } from '../src/services/devices.js'
import { createReminder } from '../src/services/reminders.js'
import { makeApp, makeDevice } from './helpers.js'

/**
 * The webhook had ZERO coverage: it is the only door into the whole system, it acks before it does
 * any work, and everything it does afterwards happens on a detached promise chain. Every assertion
 * below therefore waits for the effect rather than for the response.
 */

/** One WhatsApp number for the whole file: deviceForWhatsapp binds the first sender it sees. */
const FROM = '447700900000'

const webhookBody = (message: Record<string, unknown>): string =>
  JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: FROM, ...message }] } }] }] })

const sign = (raw: string): string => 'sha256=' + createHmac('sha256', 'test-app-secret').update(raw).digest('hex')

async function post(app: Awaited<ReturnType<typeof makeApp>>, raw: string, signature = sign(raw)) {
  return await app.inject({
    method: 'POST',
    url: '/whatsapp/webhook',
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  })
}

beforeEach(() => {
  ensureSchema()
  runAgentTurnMock.mockReset()
  runAgentTurnMock.mockResolvedValue('done')
  sendMock.mockReset()
  sendMock.mockResolvedValue({ ok: true })
  fetchMediaMock.mockReset()
})

describe('signature gate', () => {
  it('rejects an unsigned POST with 401 and processes nothing', async () => {
    const app = await makeApp()
    makeDevice('dev_wh')

    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/webhook',
      payload: webhookBody({ id: 'wamid.unsigned', type: 'text', text: { body: 'hi' } }),
      headers: { 'content-type': 'application/json' },
    })

    expect(res.statusCode).toBe(401)
    expect(runAgentTurnMock).not.toHaveBeenCalled()
  })

  it('rejects a forged signature', async () => {
    const app = await makeApp()
    const raw = webhookBody({ id: 'wamid.forged', type: 'text', text: { body: 'hi' } })
    expect((await post(app, raw, 'sha256=' + '0'.repeat(64))).statusCode).toBe(401)
  })

  it('acks a signed POST with 200 immediately, before any of the work', async () => {
    // Meta retries aggressively if the 200 is slow, which would double-deliver every message.
    const app = await makeApp()
    makeDevice('dev_wh')

    const res = await post(app, webhookBody({ id: 'wamid.ack', type: 'text', text: { body: 'hello' } }))

    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalled())
  })
})

describe('unreadable inbound', () => {
  it('stamps the 24h window EVEN WHEN INGEST FAILS', async () => {
    // Everything proactive hangs off this clock. A voice note Otto cannot transcribe still means the
    // owner is there, so the window reopens whether or not we understood a word of it.
    const app = await makeApp()
    const device = makeDevice('dev_wh')
    // The file shares one in-memory DB, so start from a known-shut window rather than from whatever
    // an earlier test left behind.
    clearInboundWindow(device.deviceId)
    expect(getDevice(device.deviceId)?.lastInboundAt).toBeNull()

    await post(
      app,
      webhookBody({
        id: 'wamid.voice1',
        type: 'audio',
        audio: { id: 'media-voice', mime_type: 'audio/ogg; codecs=opus', voice: true },
      }),
    )

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalled())
    expect(getDevice(device.deviceId)?.lastInboundAt).not.toBeNull()
    // STT is off in this deployment, so the reply is the pre-media one, unchanged.
    expect(sendMock.mock.calls[0]?.[1]).toContain('I can only read text messages right now')
    // No download was attempted — the STT check comes first.
    expect(fetchMediaMock).not.toHaveBeenCalled()
    expect(runAgentTurnMock).not.toHaveBeenCalled()
  })

  it('appends the "done" hint when exactly one reminder is open', async () => {
    // The whole point of the code being replaced: answering a nudge with something Otto cannot read
    // must never leave the reminder open and Otto nagging forever.
    const app = await makeApp()
    const device = makeDevice('dev_wh')
    await createReminder(device, { title: 'take the bins out', dueAtMillis: Date.now() + 3_600_000 })

    await post(app, webhookBody({ id: 'wamid.voice2', type: 'audio', audio: { id: 'm', mime_type: 'audio/ogg' } }))

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalled())
    expect(sendMock.mock.calls[0]?.[1]).toBe(
      'I can only read text messages right now — please type your request.' +
        ' If that was about "take the bins out", just send "done".',
    )
  })

  it('names an unsupported type and still carries the hint', async () => {
    const app = await makeApp()
    makeDevice('dev_wh')

    await post(app, webhookBody({ id: 'wamid.vid1', type: 'video', video: { id: 'm', mime_type: 'video/mp4' } }))

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalled())
    const reply = String(sendMock.mock.calls[0]?.[1])
    expect(reply).toContain('a video')
    expect(reply).toContain('just send "done"')
    expect(runAgentTurnMock).not.toHaveBeenCalled()
  })
})

describe('readable inbound reaches the agent', () => {
  it('passes text straight through as a string', async () => {
    const app = await makeApp()
    makeDevice('dev_wh')

    await post(app, webhookBody({ id: 'wamid.txt1', type: 'text', text: { body: 'set an alarm for 7' } }))

    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalled())
    expect(runAgentTurnMock.mock.calls[0]?.[0]).toMatchObject({ waUserId: FROM, content: 'set an alarm for 7' })
    expect(sendMock).toHaveBeenCalledWith(FROM, 'done')
  })

  it('gives runAgentTurn ARRAY content for a photo, image block first', async () => {
    // The point of the feature: a photo now flows through the identical path text does — link,
    // idle-reset, backlog, flush, agent turn — rather than being refused at the door.
    const app = await makeApp()
    makeDevice('dev_wh')
    fetchMediaMock.mockResolvedValue({ ok: true, bytes: Buffer.from('jpegbytes'), mimeType: 'image/jpeg' })

    await post(
      app,
      webhookBody({
        id: 'wamid.img1',
        type: 'image',
        image: { id: 'media-photo', mime_type: 'image/jpeg', caption: 'when is this due?' },
      }),
    )

    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalled())
    const content = runAgentTurnMock.mock.calls[0]?.[0].content as Array<Record<string, unknown>>
    expect(Array.isArray(content)).toBe(true)
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } })
    expect(content[1]).toEqual({ type: 'text', text: 'when is this due?' })
    expect(fetchMediaMock).toHaveBeenCalledWith('media-photo', expect.objectContaining({ maxBytes: expect.any(Number) }))
  })

  it('apologises without an agent turn when the photo cannot be downloaded', async () => {
    const app = await makeApp()
    makeDevice('dev_wh')
    fetchMediaMock.mockResolvedValue({ ok: false, reason: 'not_found', detail: 'gone' })

    await post(app, webhookBody({ id: 'wamid.img2', type: 'image', image: { id: 'media-gone', mime_type: 'image/jpeg' } }))

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalled())
    expect(String(sendMock.mock.calls[0]?.[1])).toContain('that photo')
    expect(runAgentTurnMock).not.toHaveBeenCalled()
  })
})

describe('redelivery', () => {
  it('handles a repeated wamid exactly once', async () => {
    // Meta redelivers at-least-once. Without the claim, one "set an alarm for 7" would run twice.
    const app = await makeApp()
    makeDevice('dev_wh')
    const raw = webhookBody({ id: 'wamid.dupe', type: 'text', text: { body: 'same message' } })

    expect((await post(app, raw)).statusCode).toBe(200)
    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalledTimes(1))

    expect((await post(app, raw)).statusCode).toBe(200)
    // Give the second delivery every chance to be processed before asserting it was not.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1)
  })
})
