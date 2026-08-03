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
