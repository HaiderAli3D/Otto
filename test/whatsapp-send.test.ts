import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { META_ERROR_REENGAGEMENT, sendText, type SendResult } from '../src/services/whatsapp.js'

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

const fetchMock = vi.fn<() => Promise<FakeResponse>>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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
