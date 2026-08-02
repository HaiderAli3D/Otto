import { describe, expect, it } from 'vitest'
import { trimToValidStart, type Msg } from '../src/lib/history.js'

const userText = (t: string): Msg => ({ role: 'user', content: t })
const assistantText = (t: string): Msg => ({ role: 'assistant', content: [{ type: 'text', text: t }] })
const assistantToolUse = (id: string): Msg => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'list_alarms', input: {} }],
})
const userToolResult = (id: string): Msg => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: '{}' }],
})
const userImage = (caption?: string): Msg => ({
  role: 'user',
  content: caption
    ? [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'text', text: caption },
      ]
    : [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }],
})

describe('trimToValidStart', () => {
  it('keeps a well-formed conversation that already starts with a user text turn', () => {
    const h = [userText('hi'), assistantText('hello')]
    expect(trimToValidStart(h)).toEqual(h)
  })

  it('drops a leading orphan tool_result (its tool_use was trimmed away)', () => {
    // Simulate a raw-count trim that sliced off the assistant tool_use, orphaning the tool_result.
    const h = [userToolResult('t1'), assistantText('done'), userText('next'), assistantText('ok')]
    expect(trimToValidStart(h)).toEqual([userText('next'), assistantText('ok')])
  })

  it('drops a leading assistant turn', () => {
    const h = [assistantText('stray'), userText('hey'), assistantText('hi')]
    expect(trimToValidStart(h)).toEqual([userText('hey'), assistantText('hi')])
  })

  it('returns [] when no plain user turn survives the window', () => {
    expect(trimToValidStart([assistantToolUse('t1'), userToolResult('t1')])).toEqual([])
  })

  it('trims to the last `max` messages before normalizing', () => {
    const h = [userText('old'), assistantText('a'), userText('new'), assistantText('b')]
    expect(trimToValidStart(h, 2)).toEqual([userText('new'), assistantText('b')])
  })
})

describe('trimToValidStart with array content', () => {
  // The API requires a leading USER turn and rejects a leading tool_result. It does NOT require the
  // content to be a string — the old `typeof content === 'string'` test discarded photo turns.
  it('accepts an array-content user turn as a valid start', () => {
    const h = [userImage('what is this'), assistantText('a bolt')]
    expect(trimToValidStart(h)).toEqual(h)
  })

  it('accepts an image-only user turn with no caption block', () => {
    const h = [userImage(), assistantText('a bolt')]
    expect(trimToValidStart(h)).toEqual(h)
  })

  it('still rejects an array whose only block is a tool_result', () => {
    const h = [userToolResult('t1'), userText('next')]
    expect(trimToValidStart(h)).toEqual([userText('next')])
  })

  it('rejects a MIXED array that merely contains a tool_result', () => {
    // The runner packs every result for one assistant turn into a single user message, so a
    // surviving tool_result means its paired tool_use was trimmed away — orphan, whole message.
    const mixed: Msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'and also' },
        { type: 'tool_result', tool_use_id: 't1', content: '{}' },
      ],
    }
    expect(trimToValidStart([mixed, userText('next')])).toEqual([userText('next')])
  })

  it('rejects an empty array — the API rejects empty content', () => {
    const empty: Msg = { role: 'user', content: [] }
    expect(trimToValidStart([empty, userText('next')])).toEqual([userText('next')])
  })
})
