import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above the file body, so the mocks must be created inside vi.hoisted.
const { fetchMediaMock, transcribeMock } = vi.hoisted(() => ({
  fetchMediaMock: vi.fn(),
  transcribeMock: vi.fn(),
}))
vi.mock('../src/services/media.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, fetchMedia: fetchMediaMock }
})
vi.mock('../src/services/stt.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, transcribe: transcribeMock }
})

import { VOICE_AND_PHOTOS } from '../src/agent/promptSections.js'
import { config } from '../src/config.js'
import {
  VOICE_TRANSCRIPT_PREFIX,
  ingestFailureMessage,
  ingestInbound,
  type IngestFailure,
} from '../src/services/ingest.js'
import type { InboundMessage } from '../src/services/whatsapp.js'

const msg = (over: Partial<InboundMessage>): InboundMessage => ({
  id: 'wamid.1',
  from: '447700900000',
  type: 'text',
  text: null,
  ...over,
})

const image = (over: Partial<InboundMessage> = {}): InboundMessage =>
  msg({ type: 'image', media: { mediaId: 'm1', mimeType: 'image/jpeg', voice: false }, ...over })

const voice = (over: Partial<InboundMessage> = {}): InboundMessage =>
  msg({ type: 'audio', media: { mediaId: 'm2', mimeType: 'audio/ogg; codecs=opus', voice: true }, ...over })

beforeEach(() => {
  // Restore FIRST, not just at the end of each test: a `config.stt` spy left standing by a test
  // that failed mid-way silently switches voice ON for every test after it, and the resulting
  // cascade hides which assertion actually broke.
  vi.restoreAllMocks()
  fetchMediaMock.mockReset()
  transcribeMock.mockReset()
})

describe('text passes straight through', () => {
  it('hands back the exact string, untouched', async () => {
    const res = await ingestInbound(msg({ type: 'text', text: '  remind me at 6  ' }))
    expect(res).toEqual({ ok: true, source: 'text', content: '  remind me at 6  ' })
    expect(fetchMediaMock).not.toHaveBeenCalled()
  })

  it('refuses an empty text body rather than sending a blank user turn', async () => {
    expect(await ingestInbound(msg({ type: 'text', text: '   ' }))).toMatchObject({ ok: false, reason: 'malformed' })
  })
})

describe('photos become [image, text] blocks', () => {
  it('puts the image FIRST and the caption last, base64-encoded', async () => {
    fetchMediaMock.mockResolvedValue({ ok: true, bytes: Buffer.from('jpegbytes'), mimeType: 'image/jpeg' })

    const res = await ingestInbound(image({ caption: 'is this the right filter?' }))

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.source).toBe('image')
    // Order is load-bearing for the MODEL, not for the cache: picture, then the instruction about
    // it. The photo is the newest thing in the request either way, so it falls past the end of any
    // cacheable prefix regardless of which part comes first.
    expect(res.content).toEqual([
      {
        type: 'input_image',
        detail: 'auto',
        image_url: `data:image/jpeg;base64,${Buffer.from('jpegbytes').toString('base64')}`,
      },
      { type: 'input_text', text: 'is this the right filter?' },
    ])
  })

  it('substitutes a stand-in when there is no caption', async () => {
    fetchMediaMock.mockResolvedValue({ ok: true, bytes: Buffer.from('x'), mimeType: 'image/png' })

    const res = await ingestInbound(image())

    if (!res.ok) throw new Error('unreachable')
    const parts = res.content as Array<{ type: string; text?: string }>
    // Never an empty text part — "no caption" is itself information.
    expect(parts[1]).toEqual({ type: 'input_text', text: '(photo, no caption)' })
  })

  it('narrows the media type to what the API actually accepts', async () => {
    fetchMediaMock.mockResolvedValue({ ok: true, bytes: Buffer.from('x'), mimeType: 'image/heic' })
    expect(await ingestInbound(image())).toEqual({ ok: false, reason: 'unsupported_mime', noun: 'that photo' })
  })

  it('reports a download failure with a photo noun', async () => {
    fetchMediaMock.mockResolvedValue({ ok: false, reason: 'not_found', detail: 'gone' })
    expect(await ingestInbound(image())).toEqual({ ok: false, reason: 'download_failed', noun: 'that photo' })
  })

  it('maps an over-cap download to too_large, not to a generic failure', async () => {
    fetchMediaMock.mockResolvedValue({ ok: false, reason: 'too_large', detail: 'huge' })
    expect(await ingestInbound(image())).toMatchObject({ reason: 'too_large' })
  })

  it('degrades a media block with no handle to malformed instead of downloading undefined', async () => {
    const { media, ...withoutMedia } = image()
    void media
    expect(await ingestInbound(withoutMedia as InboundMessage)).toMatchObject({ reason: 'malformed' })
    expect(fetchMediaMock).not.toHaveBeenCalled()
  })
})

describe('voice notes become a plain STRING', () => {
  it('keeps the transcript on the string fast path — this pins the design', async () => {
    // Deliberately asserted with typeof: the transcript is the owner's own words and belongs in the
    // conversation as an ordinary user turn. Blocks here would double every downstream shape.
    const configured = { ...config, stt: { apiKey: 'k', baseUrl: 'https://stt.invalid', model: 'whisper' } }
    vi.spyOn(config, 'stt', 'get').mockReturnValue(configured.stt)
    fetchMediaMock.mockResolvedValue({ ok: true, bytes: Buffer.from('ogg'), mimeType: 'audio/ogg' })
    transcribeMock.mockResolvedValue({ ok: true, text: 'remind me to call mum at six' })

    const res = await ingestInbound(voice())

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.source).toBe('voice')
    expect(typeof res.content).toBe('string')
    expect(res.content).toBe(`${VOICE_TRANSCRIPT_PREFIX} remind me to call mum at six`)
    vi.restoreAllMocks()
  })

  it('MARKS the transcript, because a bare one is indistinguishable from a typed message', async () => {
    // `source` cannot do this job: the route hands the agent `content` and nothing else. Without a
    // marker in the content itself the model either never applies the confirm-a-mis-hearing rule or
    // applies it to typed messages too, which collides with the rule against unrequested follow-ups.
    vi.spyOn(config, 'stt', 'get').mockReturnValue({ apiKey: 'k', baseUrl: 'https://stt.invalid', model: 'whisper' })
    fetchMediaMock.mockResolvedValue({ ok: true, bytes: Buffer.from('ogg'), mimeType: 'audio/ogg' })
    transcribeMock.mockResolvedValue({ ok: true, text: 'move the dentist to Thursday' })

    const spoken = await ingestInbound(voice())
    const typed = await ingestInbound(msg({ type: 'text', text: 'move the dentist to Thursday' }))

    if (!spoken.ok || !typed.ok) throw new Error('unreachable')
    expect(spoken.content).not.toEqual(typed.content)
    expect(String(spoken.content).startsWith(VOICE_TRANSCRIPT_PREFIX)).toBe(true)
    // A typed message is exactly what they typed — the marker must never leak onto the fast path.
    expect(typed.content).toBe('move the dentist to Thursday')
    vi.restoreAllMocks()
  })

  it('emits the very marker the prompt tells the model to look for', async () => {
    // Two files, one literal. If either side edits its copy the rule silently stops firing, and
    // nothing else in the system would notice.
    expect(VOICE_AND_PHOTOS).toContain(VOICE_TRANSCRIPT_PREFIX)
  })

  it('reports an empty transcript separately from a provider failure', async () => {
    vi.spyOn(config, 'stt', 'get').mockReturnValue({ apiKey: 'k', baseUrl: 'https://stt.invalid', model: 'whisper' })
    fetchMediaMock.mockResolvedValue({ ok: true, bytes: Buffer.from('ogg'), mimeType: 'audio/ogg' })
    transcribeMock.mockResolvedValue({ ok: false, reason: 'empty', detail: 'nothing' })

    expect(await ingestInbound(voice())).toEqual({ ok: false, reason: 'empty_transcript', noun: 'a voice note' })
    vi.restoreAllMocks()
  })

  it('reports a provider failure as transcribe_failed', async () => {
    vi.spyOn(config, 'stt', 'get').mockReturnValue({ apiKey: 'k', baseUrl: 'https://stt.invalid', model: 'whisper' })
    fetchMediaMock.mockResolvedValue({ ok: true, bytes: Buffer.from('ogg'), mimeType: 'audio/ogg' })
    transcribeMock.mockResolvedValue({ ok: false, reason: 'provider', detail: '500' })

    expect(await ingestInbound(voice())).toMatchObject({ reason: 'transcribe_failed' })
    vi.restoreAllMocks()
  })

  it('reports a download failure before transcription is ever attempted', async () => {
    vi.spyOn(config, 'stt', 'get').mockReturnValue({ apiKey: 'k', baseUrl: 'https://stt.invalid', model: 'whisper' })
    fetchMediaMock.mockResolvedValue({ ok: false, reason: 'network', detail: 'timeout' })

    expect(await ingestInbound(voice())).toMatchObject({ reason: 'download_failed' })
    expect(transcribeMock).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('with STT off, refuses BEFORE downloading anything', async () => {
    // The owner's actual deployment. Spending a two-hop Graph download to arrive at the same
    // apology would be pure latency on a message they are waiting on.
    expect(config.stt).toBeNull()

    expect(await ingestInbound(voice())).toEqual({ ok: false, reason: 'stt_unconfigured', noun: 'a voice note' })
    expect(fetchMediaMock).not.toHaveBeenCalled()
    expect(transcribeMock).not.toHaveBeenCalled()
  })

  it('calls an attached audio FILE what it is', async () => {
    const res = await ingestInbound(
      msg({ type: 'audio', media: { mediaId: 'm3', mimeType: 'audio/mpeg', voice: false } }),
    )
    expect(res).toEqual({ ok: false, reason: 'stt_unconfigured', noun: 'an audio file' })
  })
})

describe('unsupported types get a human noun', () => {
  const cases: Array<[string, string]> = [
    ['video', 'a video'],
    ['document', 'a document'],
    ['sticker', 'a sticker'],
    ['location', 'a location'],
    ['contacts', 'a contact card'],
  ]

  for (const [type, noun] of cases) {
    it(`${type} -> "${noun}"`, async () => {
      expect(await ingestInbound(msg({ type }))).toEqual({ ok: false, reason: 'unsupported_type', noun })
      expect(fetchMediaMock).not.toHaveBeenCalled()
    })
  }

  it('falls back to a neutral noun for a type nobody has seen yet', async () => {
    expect(await ingestInbound(msg({ type: 'reaction' }))).toEqual({
      ok: false,
      reason: 'unsupported_type',
      noun: 'that',
    })
  })
})

describe('ingestFailureMessage', () => {
  const ALL: IngestFailure[] = [
    'stt_unconfigured',
    'unsupported_type',
    'unsupported_mime',
    'download_failed',
    'too_large',
    'transcribe_failed',
    'empty_transcript',
    'malformed',
  ]

  it('returns non-empty copy for EVERY failure', async () => {
    // A silent reply is the one outcome worse than an unhelpful one: the owner would think the
    // message landed. A missing switch arm returns undefined, and this is what catches it.
    for (const reason of ALL) {
      const copy = ingestFailureMessage(reason, 'a voice note')
      expect(typeof copy).toBe('string')
      expect(copy.trim().length).toBeGreaterThan(0)
    }
  })

  it('keeps the pre-media reply byte-identical while STT is off', async () => {
    // The visible half of "voice is built but off": with no provider that sentence is still exactly
    // true, and the owner sees no change at all.
    expect(ingestFailureMessage('stt_unconfigured', 'a voice note')).toBe(
      'I can only read text messages right now — please type your request.',
    )
  })

  it('names the thing it could not read', async () => {
    expect(ingestFailureMessage('unsupported_type', 'a video')).toContain('a video')
    expect(ingestFailureMessage('too_large', 'that photo')).toContain('that photo')
  })
})
