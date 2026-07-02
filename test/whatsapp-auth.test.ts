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

  it('surfaces non-text messages with text=null (so the route can reply)', () => {
    const out = parseInboundMessages(wrap([{ id: 'wamid.2', type: 'audio', from: '44770' }]))
    expect(out).toEqual([{ id: 'wamid.2', from: '44770', type: 'audio', text: null }])
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
