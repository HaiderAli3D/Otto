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
