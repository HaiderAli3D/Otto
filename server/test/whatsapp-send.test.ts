import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { META_ERROR_REENGAGEMENT, sendTemplate, sendText, type SendResult } from '../src/services/whatsapp.js'

type FakeResponse = { ok: boolean; status: number; text: () => Promise<string> }
const response = (status: number, body?: string): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body ?? `status ${status}`,
})

/** The shape Meta returns when a free-form send lands outside the 24h customer-service window. */
const reengagementBody = JSON.stringify({
  error: { message: 'Re-engagement message', type: 'OAuthException', code: META_ERROR_REENGAGEMENT },
})

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<FakeResponse>>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * The owner HAS registered `otto_catch_up`, but test/setup-env.ts deliberately leaves
 * META_TEMPLATE_NAME unset so every other test sees the "no template" world. Patch it locally
 * rather than globally — a template configured for the whole suite would quietly change what the
 * outbox sweep does in every unrelated file.
 */
function withTemplate(): void {
  const meta = config.meta!
  vi.spyOn(config, 'meta', 'get').mockReturnValue({ ...meta, template: { name: 'otto_catch_up', lang: 'en' } })
}

const bodyOf = (call: unknown[] | undefined): Record<string, unknown> =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>

/**
 * Drive the fake clock until sendText settles. runAllTimersAsync alone can resolve before the
 * first retry sleep is even scheduled, so advance in small steps until the promise finishes.
 */
async function run(promise: Promise<SendResult>): Promise<SendResult> {
  let settled = false
  void promise.finally(() => {
    settled = true
  })
  while (!settled) {
    await vi.advanceTimersByTimeAsync(100)
  }
  return promise
}

describe('sendText retry', () => {
  it('retries a 500 and succeeds on the second attempt', async () => {
    fetchMock.mockResolvedValueOnce(response(500)).mockResolvedValueOnce(response(200))
    const res = await run(sendText('447700900000', 'hi'))
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a permanent 400', async () => {
    fetchMock.mockResolvedValue(response(400))
    const res = await run(sendText('447700900000', 'hi'))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.permanent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 (rate limit)', async () => {
    fetchMock.mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response(200))
    const res = await run(sendText('447700900000', 'hi'))
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after three transient failures', async () => {
    fetchMock.mockResolvedValue(response(503))
    const res = await run(sendText('447700900000', 'hi'))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.permanent).toBe(false) // transient exhaustion — the outbox keeps the row PENDING
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('treats a thrown fetch (network) as transient', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(response(200))
    const res = await run(sendText('447700900000', 'hi'))
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('sendText out-of-window detection', () => {
  it('flags Meta error 131047 as outOfWindow and does not retry', async () => {
    fetchMock.mockResolvedValue(response(400, reengagementBody))
    const res = await run(sendText('447700900000', 'nudge'))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.outOfWindow).toBe(true)
    expect(res.metaCode).toBe(META_ERROR_REENGAGEMENT)
    expect(res.permanent).toBe(true)
    // A shut window must not burn retries against a door that cannot open.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not flag an unrelated 400 as outOfWindow', async () => {
    fetchMock.mockResolvedValue(response(400, JSON.stringify({ error: { code: 100, message: 'bad param' } })))
    const res = await run(sendText('447700900000', 'hi'))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.outOfWindow).toBe(false)
    expect(res.metaCode).toBe(100)
  })

  it('tolerates a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(response(400, '<html>gateway</html>'))
    const res = await run(sendText('447700900000', 'hi'))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.metaCode).toBeUndefined()
    expect(res.outOfWindow).toBe(false)
  })
})

/**
 * ORDER MATTERS in this describe. The self-disabling latch is module-level state that survives for
 * the life of the process (which is the whole point of it), so the two latch tests are last and the
 * second one depends on the first having tripped it.
 */
describe('sendTemplate — knocking on a shut window', () => {
  it('refuses when no template is registered, without spending a Graph call', async () => {
    const res = await run(sendTemplate('447700900000', ['2 things']))
    expect(res).toMatchObject({ ok: false, permanent: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the documented template body', async () => {
    withTemplate()
    fetchMock.mockResolvedValue(response(200))

    const res = await run(sendTemplate('447700900000', ['2 things']))

    expect(res.ok).toBe(true)
    const body = bodyOf(fetchMock.mock.calls[0])
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '447700900000',
      type: 'template',
      template: {
        name: 'otto_catch_up',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: '2 things' }] }],
      },
    })
  })

  it('omits components entirely for a template with no variables', async () => {
    withTemplate()
    fetchMock.mockResolvedValue(response(200))
    await run(sendTemplate('447700900000', []))
    expect((bodyOf(fetchMock.mock.calls[0]).template as { components: unknown[] }).components).toEqual([])
  })

  it('retries a 500 like every other Graph call', async () => {
    withTemplate()
    fetchMock.mockResolvedValueOnce(response(500)).mockResolvedValueOnce(response(200))

    const res = await run(sendTemplate('447700900000', ['something']))

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 132001 (template does not exist) — and latches off', async () => {
    withTemplate()
    fetchMock.mockResolvedValue(
      response(400, JSON.stringify({ error: { code: 132001, message: 'Template name does not exist' } })),
    )

    const res = await run(sendTemplate('447700900000', ['something']))

    expect(res).toMatchObject({ ok: false, permanent: true, metaCode: 132001 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('short-circuits every later call once latched — a mis-registered template is forever', async () => {
    // Depends on the test above having tripped the latch. Without it, a sweep every five minutes
    // would spend a Graph call to be told the same permanent thing, unwatched, forever.
    withTemplate()
    fetchMock.mockResolvedValue(response(200))

    const res = await run(sendTemplate('447700900000', ['something']))

    expect(res).toMatchObject({ ok: false, permanent: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
