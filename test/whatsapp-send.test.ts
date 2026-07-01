import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendText } from '../src/services/whatsapp.js'

type FakeResponse = { ok: boolean; status: number; text: () => Promise<string> }
const response = (status: number): FakeResponse => ({ ok: status >= 200 && status < 300, status, text: async () => `status ${status}` })

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
async function run(promise: Promise<boolean>): Promise<boolean> {
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
    const ok = await run(sendText('447700900000', 'hi'))
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a permanent 400', async () => {
    fetchMock.mockResolvedValue(response(400))
    const ok = await run(sendText('447700900000', 'hi'))
    expect(ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 (rate limit)', async () => {
    fetchMock.mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response(200))
    const ok = await run(sendText('447700900000', 'hi'))
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after three transient failures', async () => {
    fetchMock.mockResolvedValue(response(503))
    const ok = await run(sendText('447700900000', 'hi'))
    expect(ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('treats a thrown fetch (network) as transient', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(response(200))
    const ok = await run(sendText('447700900000', 'hi'))
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
