import type Anthropic from '@anthropic-ai/sdk'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSchema } from '../src/db/client.js'
import { sessions } from '../src/db/schema.js'
import { MAX_SESSION_BYTES, stripAttachments, trimToValidStart, type Msg } from '../src/lib/history.js'
import { saveSession } from '../src/services/sessions.js'

beforeEach(() => ensureSchema())

/** Stands in for the ~250KB a real WhatsApp photo arrives as. 5KB is enough to find in the row. */
const FAKE_BASE64 = 'QUJDREVG'.repeat(640)

const image = (data = FAKE_BASE64): Anthropic.ImageBlockParam => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data },
})

const photoTurn = (caption?: string): Msg => ({
  role: 'user',
  content: caption ? [image(), { type: 'text', text: caption }] : [image()],
})

describe('stripAttachments', () => {
  it('replaces a captioned photo with the bracketed stand-in', () => {
    const out = stripAttachments([photoTurn('is this the right bolt?')])
    expect(out[0]!.content).toBe('[photo the owner sent: "is this the right bolt?"]')
  })

  it('uses the bare stand-in when there is no caption', () => {
    expect(stripAttachments([photoTurn()])[0]!.content).toBe('[photo the owner sent]')
  })

  it('collapses to a plain string, not a one-element array', () => {
    // The smallest persisted form, and it keeps stripped turns on the string fast path in
    // trimToValidStart's leading-shape check.
    expect(typeof stripAttachments([photoTurn('hi')])[0]!.content).toBe('string')
  })

  it('leaves text, tool_use and tool_result messages untouched', () => {
    const history: Msg[] = [
      { role: 'user', content: 'plain text' },
      { role: 'assistant', content: [{ type: 'text', text: 'a text block' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'list_alarms', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
    ]
    expect(stripAttachments(history)).toEqual(history)
  })

  it('returns a copy — neither the input array nor its blocks are mutated', () => {
    const history: Msg[] = [photoTurn('look'), { role: 'assistant', content: 'nice' }]
    const before = structuredClone(history)

    const out = stripAttachments(history)

    expect(history).toEqual(before)
    expect(out).not.toBe(history)
    expect(out[0]).not.toBe(history[0])
    // The original blocks are still the real image, untouched.
    expect((history[0]!.content as Anthropic.ContentBlockParam[])[0]).toMatchObject({ type: 'image' })
  })

  it('strips every photo in a multi-photo turn', () => {
    const turn: Msg = { role: 'user', content: [image(), image(), { type: 'text', text: 'these two' }] }
    expect(stripAttachments([turn])[0]!.content).toBe('[photo the owner sent: "these two"]')
  })
})

describe('saveSession round trip', () => {
  it('never persists the image block or its base64', () => {
    const waUserId = 'wa_photo'
    saveSession(waUserId, 'dev_photo', [photoTurn('what is this'), { role: 'assistant', content: 'a bolt' }])

    const row = db.select().from(sessions).where(eq(sessions.waUserId, waUserId)).get()
    expect(row).toBeTruthy()
    expect(row!.messages).not.toContain('"type":"image"')
    expect(row!.messages).not.toContain(FAKE_BASE64)
    expect(row!.messages).toContain('[photo the owner sent: \\"what is this\\"]')
    // And the stripped turn is still a legal conversation opening, so the next API call works.
    expect(JSON.parse(row!.messages)).toHaveLength(2)
  })

  it('keeps a photo turn as the conversation start instead of silently discarding it', () => {
    // The bug this replaced: `typeof content === 'string'` meant an image turn could never open a
    // conversation, so a photo-first thread was thrown away with no error anywhere.
    const history: Msg[] = [photoTurn('this one'), { role: 'assistant', content: 'ok' }]
    expect(trimToValidStart(history)).toHaveLength(2)
  })
})

describe('the session byte cap', () => {
  const big = (n: number): string => 'x'.repeat(n)

  it('drops from the front until under the cap, and the survivor still starts validly', () => {
    const history: Msg[] = [
      { role: 'user', content: `first ${big(100_000)}` },
      { role: 'assistant', content: big(100_000) },
      { role: 'user', content: `middle ${big(100_000)}` },
      { role: 'assistant', content: big(100_000) },
      { role: 'user', content: `last ${big(100_000)}` },
    ]
    const out = trimToValidStart(history)

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_SESSION_BYTES)
    expect(out.length).toBeLessThan(history.length)
    // Oldest first: the newest turn survives, the first one is gone.
    expect(out[0]!.role).toBe('user')
    expect(out[0]!.content).toContain('last')
    expect(JSON.stringify(out)).not.toContain('first ')
  })

  it('leaves a normal-sized conversation completely alone', () => {
    const history: Msg[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(trimToValidStart(history)).toEqual(history)
  })

  it('keeps one oversized message rather than wiping the whole conversation', () => {
    // A single message over the cap can never be brought under it by deleting its neighbours, so a
    // `while (length > 0)` loop empties the array and saveSession then persists '[]' — the entire
    // thread gone, marked only by a log line. An over-cap column is a cost problem; a vanished
    // transcript is a correctness one.
    const history: Msg[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: `huge ${big(MAX_SESSION_BYTES * 2)}` },
    ]
    const out = trimToValidStart(history)

    expect(out).toHaveLength(1)
    expect(out[0]!.content).toContain('huge')
  })

  it('does not wipe a session whose oversized message is the only one', () => {
    const history: Msg[] = [{ role: 'user', content: big(MAX_SESSION_BYTES * 2) }]
    expect(trimToValidStart(history)).toHaveLength(1)
  })

  it('measures real UTF-8 bytes, not UTF-16 code units', () => {
    // String.length counts UTF-16 units, so a 4-byte emoji measures as 2 and a transcript can sit at
    // ~2x the cap on disk while appearing to pass it. Build a history that is under the cap by
    // .length but over it in real bytes, and assert the cap actually bites.
    const emoji = '🔥'.repeat(MAX_SESSION_BYTES / 3)
    expect(JSON.stringify([{ role: 'user', content: emoji }]).length).toBeLessThan(MAX_SESSION_BYTES)
    expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(MAX_SESSION_BYTES)

    const history: Msg[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: emoji },
    ]
    // Dropped down to the single oversized turn, which a .length-based cap would not have done.
    expect(trimToValidStart(history)).toHaveLength(1)
  })
})
