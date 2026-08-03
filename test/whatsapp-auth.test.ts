import { describe, expect, it } from 'vitest'
import { normalizeWaNumber, parseInboundMessages } from '../src/services/whatsapp.js'

describe('normalizeWaNumber', () => {
  it('reduces any format to digits', () => {
    expect(normalizeWaNumber('+44 7700 900000')).toBe('447700900000')
    expect(normalizeWaNumber('447700900000')).toBe('447700900000')
  })
})

describe('parseInboundMessages', () => {
  const wrap = (messages: unknown[]) => ({ entry: [{ changes: [{ value: { messages } }] }] })

  it('extracts text messages with their wamid', () => {
    const out = parseInboundMessages(wrap([{ id: 'wamid.1', type: 'text', from: '44770', text: { body: 'hi' } }]))
    expect(out).toEqual([{ id: 'wamid.1', from: '44770', type: 'text', text: 'hi' }])
  })

  it('surfaces non-text messages with text=null (so the route can ingest or reply)', () => {
    // Deliberately updated when media landed: an audio message now CARRIES its handle rather than
    // being discarded, which is the whole feature. text stays null — the transcript is not here.
    const out = parseInboundMessages(
      wrap([
        {
          id: 'wamid.2',
          type: 'audio',
          from: '44770',
          audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', sha256: 'abc', voice: true },
        },
      ]),
    )
    expect(out).toEqual([
      {
        id: 'wamid.2',
        from: '44770',
        type: 'audio',
        text: null,
        media: { mediaId: 'media-1', mimeType: 'audio/ogg; codecs=opus', voice: true, sha256: 'abc' },
      },
    ])
  })

  it('carries an image handle and its caption, and leaves caption off when there is none', () => {
    const [captioned] = parseInboundMessages(
      wrap([
        {
          id: 'wamid.3',
          type: 'image',
          from: '44770',
          image: { id: 'media-2', mime_type: 'image/jpeg', caption: 'is this the right filter?' },
        },
      ]),
    )
    expect(captioned).toEqual({
      id: 'wamid.3',
      from: '44770',
      type: 'image',
      text: null,
      caption: 'is this the right filter?',
      media: { mediaId: 'media-2', mimeType: 'image/jpeg', voice: false },
    })

    // An empty caption must be ABSENT, not '' and not null: a text message's four-key shape is what
    // every existing caller and assertion is written against.
    const [bare] = parseInboundMessages(
      wrap([{ id: 'wamid.4', type: 'image', from: '44770', image: { id: 'media-3', mime_type: 'image/png', caption: '' } }]),
    )
    expect(bare).not.toHaveProperty('caption')
  })

  it('keeps a document filename and degrades a media block with no id to no media at all', () => {
    const [doc] = parseInboundMessages(
      wrap([
        {
          id: 'wamid.5',
          type: 'document',
          from: '44770',
          document: { id: 'media-4', mime_type: 'application/pdf', filename: 'tickets.pdf' },
        },
      ]),
    )
    expect(doc?.media).toEqual({ mediaId: 'media-4', mimeType: 'application/pdf', voice: false, filename: 'tickets.pdf' })

    // No id ⇒ nothing to download. Ingest reports "unsupported" and the owner gets a friendly
    // reply, which beats a two-hop Graph call for `undefined`.
    const [broken] = parseInboundMessages(wrap([{ id: 'wamid.6', type: 'image', from: '44770', image: { mime_type: 'image/jpeg' } }]))
    expect(broken).toEqual({ id: 'wamid.6', from: '44770', type: 'image', text: null })
  })

  it('does not parse quoted-reply context — nothing can resolve a quote', () => {
    const [msg] = parseInboundMessages(
      wrap([{ id: 'wamid.7', type: 'text', from: '44770', text: { body: 'done' }, context: { id: 'wamid.out.1' } }]),
    )
    expect(msg).toEqual({ id: 'wamid.7', from: '44770', type: 'text', text: 'done' })
  })

  it('ignores status/receipt payloads with no messages[]', () => {
    expect(parseInboundMessages({ entry: [{ changes: [{ value: { statuses: [{ id: 's' }] } }] }] })).toEqual([])
    expect(parseInboundMessages({})).toEqual([])
    expect(parseInboundMessages(null)).toEqual([])
  })

  it('skips malformed messages missing id/from/type', () => {
    expect(parseInboundMessages(wrap([{ type: 'text', text: { body: 'no from/id' } }]))).toEqual([])
  })
})
