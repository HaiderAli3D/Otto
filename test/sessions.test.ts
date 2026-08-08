import { describe, expect, it } from 'vitest'
import { trimToValidStart, type Item } from '../src/lib/history.js'

const userText = (t: string): Item => ({ role: 'user', content: t })
const assistantText = (t: string): Item => ({
  role: 'assistant',
  content: [{ type: 'output_text', text: t, annotations: [] }],
})
const toolCall = (callId: string): Item => ({
  type: 'function_call',
  call_id: callId,
  name: 'list_alarms',
  arguments: '{}',
})
const toolOutput = (callId: string): Item => ({
  type: 'function_call_output',
  call_id: callId,
  output: '{}',
})
const reasoning = (id: string): Item => ({ type: 'reasoning', id, summary: [] })
const userImage = (caption?: string): Item => ({
  role: 'user',
  content: caption
    ? [
        { type: 'input_image', detail: 'auto', image_url: 'data:image/jpeg;base64,QUJD' },
        { type: 'input_text', text: caption },
      ]
    : [{ type: 'input_image', detail: 'auto', image_url: 'data:image/jpeg;base64,QUJD' }],
})

describe('trimToValidStart', () => {
  it('keeps a well-formed conversation that already starts with a user text turn', () => {
    const h = [userText('hi'), assistantText('hello')]
    expect(trimToValidStart(h)).toEqual(h)
  })

  it('drops a leading orphan tool output (its call was trimmed away)', () => {
    // Simulate a raw-count trim that sliced off the function_call, orphaning its output. Sending
    // that output with no matching call in the input is a 400.
    const h = [toolOutput('call_1'), assistantText('done'), userText('next'), assistantText('ok')]
    expect(trimToValidStart(h)).toEqual([userText('next'), assistantText('ok')])
  })

  it('drops a leading assistant turn', () => {
    const h = [assistantText('stray'), userText('hey'), assistantText('hi')]
    expect(trimToValidStart(h)).toEqual([userText('hey'), assistantText('hi')])
  })

  it('cascades: dropping a leading call also drops the output that followed it', () => {
    // THE rule that changed shape in the move to the Responses API. Tool results used to be blocks
    // inside one user message, so a coarse trim orphaned them together. They are separate top-level
    // items now, so a surviving call_id pair has to be dropped as a unit — otherwise the request
    // 400s, which is non-transient, which walks the session into the trim-at-2 / wipe-at-4 ladder.
    //
    // No special case implements this: making a bare function_call an invalid start is enough, and
    // the front-advancing scan does the rest.
    const h = [toolCall('call_1'), toolOutput('call_1'), userText('next'), assistantText('ok')]
    expect(trimToValidStart(h)).toEqual([userText('next'), assistantText('ok')])
  })

  it('drops a leading reasoning item', () => {
    // Belt and braces: stripReasoning means these should never be persisted, so this catches a row
    // written before that landed, or by a future change that forgets it.
    const h = [reasoning('rs_1'), userText('hey'), assistantText('hi')]
    expect(trimToValidStart(h)).toEqual([userText('hey'), assistantText('hi')])
  })

  it('returns [] when no plain user turn survives the window', () => {
    expect(trimToValidStart([toolCall('call_1'), toolOutput('call_1')])).toEqual([])
  })

  it('trims to the last `max` items before normalizing', () => {
    const h = [userText('old'), assistantText('a'), userText('new'), assistantText('b')]
    expect(trimToValidStart(h, 2)).toEqual([userText('new'), assistantText('b')])
  })
})

describe('trimToValidStart with array content', () => {
  // The rule kept from before: a conversation opens on a USER turn, and content does NOT have to be
  // a string — the old `typeof content === 'string'` test silently discarded photo turns.
  it('accepts an array-content user turn as a valid start', () => {
    const h = [userImage('what is this'), assistantText('a bolt')]
    expect(trimToValidStart(h)).toEqual(h)
  })

  it('accepts an image-only user turn with no caption part', () => {
    const h = [userImage(), assistantText('a bolt')]
    expect(trimToValidStart(h)).toEqual(h)
  })

  it('still rejects a bare tool output as an opening', () => {
    const h = [toolOutput('call_1'), userText('next')]
    expect(trimToValidStart(h)).toEqual([userText('next')])
  })

  it('rejects an empty array — the API rejects empty content', () => {
    const empty: Item = { role: 'user', content: [] }
    expect(trimToValidStart([empty, userText('next')])).toEqual([userText('next')])
  })
})
