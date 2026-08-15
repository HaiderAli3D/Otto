import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_MIME_ALLOW,
  IMAGE_MIME_ALLOW,
  MAX_IMAGE_BYTES,
  baseMime,
  fetchMedia,
  type MediaResult,
} from '../src/services/media.js'

/**
 * A stand-in for the parts of Response that graphFetch and fetchMedia actually touch. graphFetch
 * hands the body back UNREAD precisely so a binary caller can pick arrayBuffer over json.
 */
type FakeResponse = {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
  arrayBuffer: () => Promise<ArrayBuffer>
}

const jsonResponse = (status: number, body: unknown): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
})

const bytesResponse = (bytes: Buffer): FakeResponse => ({
  ok: true,
  status: 200,
  text: async () => '',
  json: async () => ({}),
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
})

const errorResponse = (status: number, body = `status ${status}`): FakeResponse => ({
  ok: false,
  status,
  text: async () => body,
  json: async () => ({}),
  arrayBuffer: async () => new ArrayBuffer(0),
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
})

/** Drive the fake clock until the call settles — graphFetch sleeps between retries. */
async function run(promise: Promise<MediaResult>): Promise<MediaResult> {
  let settled = false
  void promise.finally(() => {
    settled = true
  })
  while (!settled) {
    await vi.advanceTimersByTimeAsync(100)
  }
  return promise
}

const bearer = (call: [string, RequestInit] | undefined): unknown =>
  (call?.[1].headers as Record<string, string> | undefined)?.Authorization

const IMAGE_OPTS = { allow: IMAGE_MIME_ALLOW, maxBytes: MAX_IMAGE_BYTES }

describe('baseMime', () => {
  it('drops codec parameters, whitespace and case', () => {
    expect(baseMime('audio/ogg; codecs=opus')).toBe('audio/ogg')
    expect(baseMime('  IMAGE/JPEG ')).toBe('image/jpeg')
    expect(baseMime('image/png')).toBe('image/png')
    expect(baseMime('')).toBe('')
  })

  it('is what makes the audio allowlist usable at all', () => {
    // Every WhatsApp voice note arrives as 'audio/ogg; codecs=opus'. Compared raw, not one of them
    // would ever match the allowlist.
    expect(AUDIO_MIME_ALLOW.includes(baseMime('audio/ogg; codecs=opus') as 'audio/ogg')).toBe(true)
  })
})

describe('fetchMedia two-hop download', () => {
  it('carries the bearer token on BOTH hops and returns raw bytes', async () => {
    // THE bug this whole module is most likely to ship: the lookaside CDN url looks like a public
    // link and 401s without the same Authorization header as hop 1.
    const bytes = Buffer.from('not really a jpeg')
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { url: 'https://lookaside.fbsbx.com/whatsapp/abc', mime_type: 'image/jpeg', file_size: bytes.byteLength }),
      )
      .mockResolvedValueOnce(bytesResponse(bytes))

    const res = await run(fetchMedia('media-1', IMAGE_OPTS))

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.bytes.toString()).toBe('not really a jpeg')
    expect(res.mimeType).toBe('image/jpeg')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [metaCall, downloadCall] = fetchMock.mock.calls
    expect(metaCall?.[0]).toContain('/media-1')
    expect(downloadCall?.[0]).toBe('https://lookaside.fbsbx.com/whatsapp/abc')
    expect(bearer(metaCall)).toBe('Bearer test-wa-access-token')
    expect(bearer(downloadCall)).toBe('Bearer test-wa-access-token')
  })

  it('prefers the metadata mime type over anything the webhook claimed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://cdn/x', mime_type: 'image/png' }))
      .mockResolvedValueOnce(bytesResponse(Buffer.from('png')))

    const res = await run(fetchMedia('media-2', IMAGE_OPTS))
    if (!res.ok) throw new Error('unreachable')
    expect(res.mimeType).toBe('image/png')
  })

  it('reports a hop-1 404 as not_found and never reaches hop 2', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, 'no such media'))

    const res = await run(fetchMedia('media-gone', IMAGE_OPTS))

    expect(res).toMatchObject({ ok: false, reason: 'not_found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an over-cap file_size WITHOUT downloading it', async () => {
    // The entire point of reading file_size: a 40 MB video never touches this process's memory.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { url: 'https://cdn/big', mime_type: 'image/jpeg', file_size: MAX_IMAGE_BYTES + 1 }),
    )

    const res = await run(fetchMedia('media-big', IMAGE_OPTS))

    expect(res).toMatchObject({ ok: false, reason: 'too_large' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects real bytes over the cap when file_size was absent', async () => {
    // file_size is not guaranteed, so the pre-check is an optimisation and THIS is the actual rule.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://cdn/x', mime_type: 'image/jpeg' }))
      .mockResolvedValueOnce(bytesResponse(Buffer.alloc(64)))

    const res = await run(fetchMedia('media-3', { allow: IMAGE_MIME_ALLOW, maxBytes: 32 }))

    expect(res).toMatchObject({ ok: false, reason: 'too_large' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a disallowed mime type before downloading it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { url: 'https://cdn/x', mime_type: 'video/mp4' }))

    const res = await run(fetchMedia('media-4', IMAGE_OPTS))

    expect(res).toMatchObject({ ok: false, reason: 'unsupported_mime', detail: 'video/mp4' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats metadata with no download url as not_found', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { mime_type: 'image/jpeg' }))
    expect(await run(fetchMedia('media-5', IMAGE_OPTS))).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('treats an empty download as not_found rather than handing back zero bytes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://cdn/x', mime_type: 'image/jpeg' }))
      .mockResolvedValueOnce(bytesResponse(Buffer.alloc(0)))
    expect(await run(fetchMedia('media-6', IMAGE_OPTS))).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('retries a 500 on hop 1 and succeeds on the second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://cdn/x', mime_type: 'image/gif' }))
      .mockResolvedValueOnce(bytesResponse(Buffer.from('gif')))

    const res = await run(fetchMedia('media-7', IMAGE_OPTS))

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a 400 — three attempts arrive at the same answer, slower', async () => {
    fetchMock.mockResolvedValue(errorResponse(400, 'bad media id'))

    const res = await run(fetchMedia('media-8', IMAGE_OPTS))

    expect(res).toMatchObject({ ok: false, reason: 'not_found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports exhausted retries as network, not as a missing file', async () => {
    // The distinction matters to the caller's apology: "send it again" vs "I couldn't reach it".
    fetchMock.mockResolvedValue(errorResponse(503))

    const res = await run(fetchMedia('media-9', IMAGE_OPTS))

    expect(res).toMatchObject({ ok: false, reason: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports non-JSON metadata as network rather than throwing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html>',
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    })

    expect(await run(fetchMedia('media-10', IMAGE_OPTS))).toMatchObject({ ok: false, reason: 'network' })
  })
})
