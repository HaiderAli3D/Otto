import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { buildTranscriptionBody, readTranscriptionText, transcribe } from '../src/services/stt.js'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('speech-to-text is built but OFF', () => {
  it('has no STT provider configured — the precondition for everything below', () => {
    // test/setup-env.ts sets no STT_API_KEY, mirroring the owner's deployment exactly.
    expect(config.stt).toBeNull()
  })

  it('returns unconfigured WITHOUT making a network call', async () => {
    // The degradation guarantee. With no key, voice behaves precisely as it did before this module
    // existed: no download is even attempted upstream, and nothing here reaches the wire.
    const res = await transcribe(Buffer.from('audio bytes'), 'audio/ogg; codecs=opus')

    expect(res).toEqual({ ok: false, reason: 'unconfigured', detail: 'no STT provider configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checks the key before the bytes, so an empty clip still reads as unconfigured', async () => {
    expect(await transcribe(Buffer.alloc(0), 'audio/ogg')).toMatchObject({ reason: 'unconfigured' })
  })
})

describe('buildTranscriptionBody', () => {
  it('sends the documented fields', async () => {
    const form = buildTranscriptionBody(Buffer.from('abc'), 'audio/ogg; codecs=opus', 'whisper-large-v3-turbo')

    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('response_format')).toBe('json')
    // Transcription, not creative writing.
    expect(form.get('temperature')).toBe('0')
  })

  it('names the file by CONTAINER, because Whisper endpoints read the extension not the mime', async () => {
    const ogg = buildTranscriptionBody(Buffer.from('abc'), 'audio/ogg; codecs=opus', 'm')
    const oggFile = ogg.get('file')
    expect(oggFile).toBeInstanceOf(File)
    expect((oggFile as File).name).toBe('audio.ogg')
    expect((oggFile as File).type).toBe('audio/ogg')
    expect(await (oggFile as File).text()).toBe('abc')

    expect((buildTranscriptionBody(Buffer.from('a'), 'audio/mpeg', 'm').get('file') as File).name).toBe('audio.mp3')
    expect((buildTranscriptionBody(Buffer.from('a'), 'audio/mp4', 'm').get('file') as File).name).toBe('audio.m4a')
    // An unknown container falls back to ogg — WhatsApp's own format, and the likeliest truth.
    expect((buildTranscriptionBody(Buffer.from('a'), 'audio/unknown', 'm').get('file') as File).name).toBe('audio.ogg')
  })
})

/**
 * The network body of `transcribe`, which the rest of the suite never reaches: with no key the
 * module returns `unconfigured` before the first line of this, and ingest.test.ts mocks `transcribe`
 * wholesale. So the retry classification, the bound on the call, the per-attempt FormData rebuild
 * and the JSON parse were asserted nowhere — on the one module a single environment variable
 * switches on later with no further review.
 */
describe('transcribe against a provider', () => {
  const STT = { apiKey: 'k-test', baseUrl: 'https://stt.invalid/openai/v1', model: 'whisper-large-v3-turbo' }
  const CLIP = Buffer.from('ogg bytes')

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
  const bad = (status: number, body = `status ${status}`) => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  })

  beforeEach(() => {
    vi.spyOn(config, 'stt', 'get').mockReturnValue(STT)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts a bounded multipart request to the configured endpoint and returns the transcript', async () => {
    fetchMock.mockResolvedValue(ok({ text: '  move the dentist to Thursday  ' }))

    expect(await transcribe(CLIP, 'audio/ogg; codecs=opus')).toEqual({ ok: true, text: 'move the dentist to Thursday' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://stt.invalid/openai/v1/audio/transcriptions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k-test')
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('model')).toBe('whisper-large-v3-turbo')
    // This call sits in front of an agent turn the owner is waiting on; an unbounded fetch would
    // hang on undici's ~5 minute default.
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })

  it('reads a 200 with nothing usable in it as empty, not as a blank user turn', async () => {
    fetchMock.mockResolvedValue(ok({ text: '   ' }))
    expect(await transcribe(CLIP, 'audio/ogg')).toEqual({
      ok: false,
      reason: 'empty',
      detail: 'provider returned no transcript',
    })
    // One attempt: a 200 is an answer, even a useless one.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads a 200 whose body is not JSON as empty rather than throwing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
      text: async () => '<html>',
    })
    expect(await transcribe(CLIP, 'audio/ogg')).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('does NOT retry a 4xx — the provider is telling us something that will not change', async () => {
    fetchMock.mockResolvedValue(bad(400, 'unsupported file format'))

    expect(await transcribe(CLIP, 'audio/ogg')).toEqual({
      ok: false,
      reason: 'provider',
      detail: '400: unsupported file format',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx exactly once and succeeds on the second attempt', async () => {
    fetchMock.mockResolvedValueOnce(bad(503)).mockResolvedValueOnce(ok({ text: 'bins out tonight' }))

    expect(await transcribe(CLIP, 'audio/ogg')).toEqual({ ok: true, text: 'bins out tonight' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a 429 too, then gives up with the last detail', async () => {
    fetchMock.mockResolvedValue(bad(429, 'rate limited'))

    expect(await transcribe(CLIP, 'audio/ogg')).toEqual({ ok: false, reason: 'provider', detail: '429: rate limited' })
    // ONE retry, never three: this is latency the owner feels directly.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a thrown request and reports the throw, never propagating it', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'))

    expect(await transcribe(CLIP, 'audio/ogg')).toEqual({
      ok: false,
      reason: 'provider',
      detail: 'The operation was aborted due to timeout',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rebuilds the multipart body per attempt — a streamed FormData cannot be sent twice', async () => {
    fetchMock.mockResolvedValueOnce(bad(500)).mockResolvedValueOnce(ok({ text: 'second time lucky' }))

    await transcribe(CLIP, 'audio/mpeg')

    const [first, second] = fetchMock.mock.calls.map((c) => (c as [string, RequestInit])[1].body)
    expect(first).toBeInstanceOf(FormData)
    expect(second).toBeInstanceOf(FormData)
    expect(first).not.toBe(second)
    // Both are complete, not a drained husk: the retry carries the same audio as the first attempt.
    expect(await ((second as FormData).get('file') as File).text()).toBe(CLIP.toString())
  })
})

describe('readTranscriptionText', () => {
  it('returns the trimmed transcript', () => {
    expect(readTranscriptionText({ text: '  remind me to call mum at six  ' })).toBe('remind me to call mum at six')
  })

  it('returns null for anything that is not a usable transcript', () => {
    // A 200 with nothing in it must be ONE case at the call site, not an empty string that flows
    // onward and reaches the agent as a blank user turn.
    expect(readTranscriptionText({ text: '   ' })).toBeNull()
    expect(readTranscriptionText({ text: '' })).toBeNull()
    expect(readTranscriptionText({})).toBeNull()
    expect(readTranscriptionText({ text: 42 })).toBeNull()
    expect(readTranscriptionText(null)).toBeNull()
    expect(readTranscriptionText(undefined)).toBeNull()
  })
})
