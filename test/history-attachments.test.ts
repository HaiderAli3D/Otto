import { eq } from 'drizzle-orm'
import type OpenAI from 'openai'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSchema } from '../src/db/client.js'
import { sessions } from '../src/db/schema.js'
import { MAX_SESSION_BYTES, stripAttachments, trimToValidStart, type Item } from '../src/lib/history.js'
import { saveSession } from '../src/services/sessions.js'

beforeEach(() => ensureSchema())

/** Stands in for the ~250KB a real WhatsApp photo arrives as. 5KB is enough to find in the row. */
const FAKE_BASE64 = 'QUJDREVG'.repeat(640)

/**
 * Only some items in the Responses union carry a role or content, so the tests reach for them
 * through these rather than sprinkling casts across every assertion.
 */
const contentOf = (item: Item): unknown => (item as { content?: unknown }).content
const roleOf = (item: Item): unknown => (item as { role?: unknown }).role

const image = (data = FAKE_BASE64): OpenAI.Responses.ResponseInputImage => ({
  type: 'input_image',
  detail: 'auto',
  image_url: `data:image/jpeg;base64,${data}`,
})

const photoTurn = (caption?: string): Item => ({
  role: 'user',
  content: caption ? [image(), { type: 'input_text', text: caption }] : [image()],
})

describe('stripAttachments', () => {
  it('replaces a captioned photo with the bracketed stand-in', () => {
    const out = stripAttachments([photoTurn('is this the right bolt?')])
    expect(contentOf(out[0]!)).toBe('[photo the owner sent: "is this the right bolt?"]')
  })

  it('uses the bare stand-in when there is no caption', () => {
    expect(contentOf(stripAttachments([photoTurn()])[0]!)).toBe('[photo the owner sent]')
  })

  it('collapses to a plain string, not a one-element array', () => {
    // The smallest persisted form, and it keeps stripped turns on the string fast path in
    // trimToValidStart's leading-shape check.
    expect(typeof contentOf(stripAttachments([photoTurn('hi')])[0]!)).toBe('string')
  })

  it('leaves text, function calls and their outputs untouched', () => {
    // Tool traffic is TOP-LEVEL items now, not blocks nested inside a message — which is also why
    // an image can no longer hide inside a tool result.
    const history: Item[] = [
      { role: 'user', content: 'plain text' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'a text block', annotations: [] }] },
      { type: 'function_call', call_id: 'call_1', name: 'list_alarms', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{}' },
    ]
    expect(stripAttachments(history)).toEqual(history)
  })

  it('returns a copy — neither the input array nor its parts are mutated', () => {
    const history: Item[] = [photoTurn('look'), { role: 'assistant', content: 'nice' }]
    const before = structuredClone(history)

    const out = stripAttachments(history)

    expect(history).toEqual(before)
    expect(out).not.toBe(history)
    expect(out[0]).not.toBe(history[0])
    // The original parts are still the real image, untouched.
    expect((contentOf(history[0]!) as unknown[])[0]).toMatchObject({ type: 'input_image' })
  })

  it('strips every photo in a multi-photo turn', () => {
    const turn: Item = {
      role: 'user',
      content: [image(), image(), { type: 'input_text', text: 'these two' }],
    }
    expect(contentOf(stripAttachments([turn])[0]!)).toBe('[photo the owner sent: "these two"]')
  })
})

describe('saveSession round trip', () => {
  it('never persists the image part or its base64', () => {
    const waUserId = 'wa_photo'
    saveSession(waUserId, 'dev_photo', [photoTurn('what is this'), { role: 'assistant', content: 'a bolt' }])

    const row = db.select().from(sessions).where(eq(sessions.waUserId, waUserId)).get()
    expect(row).toBeTruthy()
    expect(row!.messages).not.toContain('"type":"input_image"')
    expect(row!.messages).not.toContain(FAKE_BASE64)
    expect(row!.messages).toContain('[photo the owner sent: \\"what is this\\"]')
    // And the stripped turn is still a legal conversation opening, so the next API call works.
    expect(JSON.parse(row!.messages)).toHaveLength(2)
  })

  it('never persists reasoning items or their encrypted payload', () => {
    // Encrypted reasoning is bound to the response AND the model that produced it, with a limited
    // decryptable life. Persisted, it goes stale between turns that are hours apart and 400s on
    // input that is otherwise fine — which is classified non-transient and walks the session
    // straight into the trim-at-2 / wipe-at-4 repair ladder. Changing OPENAI_MODEL would invalidate
    // every row at once.
    const waUserId = 'wa_reasoning'
    const history: Item[] = [
      { role: 'user', content: 'cancel my 7am' },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENCRYPTEDBLOB' },
      { role: 'assistant', content: 'Done.' },
    ]
    saveSession(waUserId, 'dev_reasoning', history)

    const row = db.select().from(sessions).where(eq(sessions.waUserId, waUserId)).get()
    expect(row!.messages).not.toContain('"type":"reasoning"')
    expect(row!.messages).not.toContain('ENCRYPTEDBLOB')
    expect(JSON.parse(row!.messages)).toHaveLength(2)
  })

  it('keeps a photo turn as the conversation start instead of silently discarding it', () => {
    // The bug this replaced: `typeof content === 'string'` meant an image turn could never open a
    // conversation, so a photo-first thread was thrown away with no error anywhere.
    const history: Item[] = [photoTurn('this one'), { role: 'assistant', content: 'ok' }]
    expect(trimToValidStart(history)).toHaveLength(2)
  })
})

describe('the session byte cap', () => {
  const big = (n: number): string => 'x'.repeat(n)

  it('drops from the front until under the cap, and the survivor still starts validly', () => {
    const history: Item[] = [
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
    expect(roleOf(out[0]!)).toBe('user')
    expect(contentOf(out[0]!)).toContain('last')
    expect(JSON.stringify(out)).not.toContain('first ')
  })

  it('leaves a normal-sized conversation completely alone', () => {
    const history: Item[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(trimToValidStart(history)).toEqual(history)
  })

  it('keeps one oversized item rather than wiping the whole conversation', () => {
    // A single item over the cap can never be brought under it by deleting its neighbours, so a
    // `while (length > 0)` loop empties the array and saveSession then persists '[]' — the entire
    // thread gone, marked only by a log line. An over-cap column is a cost problem; a vanished
    // transcript is a correctness one.
    const history: Item[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: `huge ${big(MAX_SESSION_BYTES * 2)}` },
    ]
    const out = trimToValidStart(history)

    expect(out).toHaveLength(1)
    expect(contentOf(out[0]!)).toContain('huge')
  })

  it('does not wipe a session whose oversized item is the only one', () => {
    const history: Item[] = [{ role: 'user', content: big(MAX_SESSION_BYTES * 2) }]
    expect(trimToValidStart(history)).toHaveLength(1)
  })

  it('measures real UTF-8 bytes, not UTF-16 code units', () => {
    // String.length counts UTF-16 units, so a 4-byte emoji measures as 2 and a transcript can sit at
    // ~2x the cap on disk while appearing to pass it. Build a history that is under the cap by
    // .length but over it in real bytes, and assert the cap actually bites.
    const emoji = '🔥'.repeat(MAX_SESSION_BYTES / 3)
    expect(JSON.stringify([{ role: 'user', content: emoji }]).length).toBeLessThan(MAX_SESSION_BYTES)
    expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(MAX_SESSION_BYTES)

    const history: Item[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: emoji },
    ]
    // Dropped down to the single oversized turn, which a .length-based cap would not have done.
    expect(trimToValidStart(history)).toHaveLength(1)
  })
})
