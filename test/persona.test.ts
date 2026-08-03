import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { DIGEST_SYSTEM } from '../src/agent/compose.js'
import { NUDGE_SYSTEM, writeNudge } from '../src/agent/nudge.js'
import { PERSONA, WRITING } from '../src/agent/persona.js'
import { REVIEW_SYSTEM } from '../src/agent/review.js'
import { systemPrompt } from '../src/agent/prompt.js'
import { config } from '../src/config.js'
import { ensureSchema } from '../src/db/client.js'
import { nudgeText } from '../src/lib/nagLadder.js'
import { enqueueOutbound, nudgeHistory, supersedePending } from '../src/services/outbox.js'
import { createReminder } from '../src/services/reminders.js'
import { makeDevice } from './helpers.js'

beforeEach(() => ensureSchema())

const inHours = (h: number): number => Date.now() + h * 3_600_000

describe('one Otto on every surface', () => {
  // The bug this guards: prompt.ts and compose.ts each used to carry their own copy of the voice
  // rules, and they had already drifted. Three surfaces, one persona, asserted.
  it('the conversational prompt carries the persona', () => {
    const device = makeDevice('dev_pe1')
    const core = systemPrompt(device)[0]!
    expect(core.type).toBe('text')
    expect(core.text).toContain(PERSONA)
    expect(core.text).toContain(WRITING)
  })

  it('the digest composer carries the same persona', () => {
    expect(DIGEST_SYSTEM).toContain(PERSONA)
    expect(DIGEST_SYSTEM).toContain(WRITING)
  })

  it('the nudge writer carries the same persona', () => {
    expect(NUDGE_SYSTEM).toContain(PERSONA)
    expect(NUDGE_SYSTEM).toContain(WRITING)
  })

  it('the weekly review carries the same persona, and overrides WRITING only for itself', () => {
    // The review is the one surface allowed more than three sentences. It says so in its own
    // "# This message" block rather than by editing WRITING — which would loosen every surface and
    // invalidate every cached prefix.
    expect(REVIEW_SYSTEM).toContain(PERSONA)
    expect(REVIEW_SYSTEM).toContain(WRITING)
    expect(REVIEW_SYSTEM).toContain('for THIS')
    expect(WRITING).toContain('one to three sentences')
  })

  it('keeps the record out of the cached prefix', () => {
    // The counters move almost every turn. In front of the breakpoint they would re-bill the whole
    // prefix each request — the same mistake that once cost ~$90/month.
    const device = makeDevice('dev_pe2')
    const blocks = systemPrompt(device)
    const cached = blocks.findIndex((b) => b.cache_control)
    const tail = blocks[blocks.length - 1]!
    expect(cached).toBeLessThan(blocks.length - 1)
    expect(tail.cache_control).toBeUndefined()
    expect(tail.text).toContain('The record (last 14 days)')
  })

  it('reports quiet hours in the volatile tail, never in the cached block', () => {
    // The window itself moves rarely, but "are we inside it right now" flips every few hours. In
    // front of the breakpoint that one line would re-bill the whole prefix on every request.
    const device = makeDevice('dev_pe8')
    const blocks = systemPrompt(device)
    const tail = blocks[blocks.length - 1]!
    expect(tail.text).toContain('Quiet hours: 22:00–07:00 local.')
    for (const block of blocks.slice(0, -1)) expect(block.text).not.toContain('Quiet hours: 22:00')
  })
})

describe('nudge writer falls back', () => {
  it('has no API key configured in tests — the precondition for everything below', () => {
    expect(config.anthropic).toBeNull()
  })

  it('returns the templated string byte-for-byte when the model is unavailable', async () => {
    // This is the 3am guarantee. Nudges fire from the scheduler on a machine that may have no
    // working Anthropic credentials, and a nudge that fails to send is worse than a templated one.
    const device = makeDevice('dev_pe3')
    const r = await createReminder(device, { title: 'Take the bins out', dueAtMillis: inHours(1) })

    for (const nagCount of [0, 1, 2, 3, 7]) {
      const withCount = { ...r, nagCount }
      expect(await writeNudge(withCount, device.timezone)).toBe(nudgeText(r.title, nagCount))
    }
  })

  it('passes the overdue description through to the fallback', async () => {
    const device = makeDevice('dev_pe4')
    const r = await createReminder(device, { title: 'Call the dentist', dueAtMillis: inHours(-4) })
    const overdue = 'due yesterday at 09:00'

    const body = await writeNudge({ ...r, nagCount: 3 }, device.timezone, overdue)
    expect(body).toBe(nudgeText(r.title, 3, overdue))
    expect(body).toContain(overdue)
  })
})

describe('nudge history', () => {
  it('returns sent and pending nudges oldest first, and nothing else', async () => {
    const device = makeDevice('dev_pe5')
    const r = await createReminder(device, { title: 'the bins', dueAtMillis: inHours(1) })
    const common = { waUserId: '44700900000', deviceId: device.deviceId, reminderId: r.reminderId }

    enqueueOutbound({ ...common, kind: 'nudge', body: 'first', dedupeKey: 'n:1' })
    enqueueOutbound({ ...common, kind: 'nudge', body: 'second', dedupeKey: 'n:2' })
    enqueueOutbound({ ...common, kind: 'digest', body: 'a digest', dedupeKey: 'd:1' })

    expect(nudgeHistory(r.reminderId)).toEqual(['first', 'second'])
  })

  it('excludes superseded nudges — nobody ever read those', async () => {
    const device = makeDevice('dev_pe6')
    const r = await createReminder(device, { title: 'the recycling', dueAtMillis: inHours(1) })

    enqueueOutbound({
      waUserId: '44700900000',
      deviceId: device.deviceId,
      reminderId: r.reminderId,
      kind: 'nudge',
      body: 'never seen',
      dedupeKey: 'n:gone',
    })
    supersedePending(r.reminderId)

    expect(nudgeHistory(r.reminderId)).toEqual([])
  })

  it('keeps only the most recent few', async () => {
    const device = makeDevice('dev_pe7')
    const r = await createReminder(device, { title: 'the shed', dueAtMillis: inHours(1) })
    for (let i = 0; i < 9; i++) {
      enqueueOutbound({
        waUserId: '44700900000',
        deviceId: device.deviceId,
        reminderId: r.reminderId,
        kind: 'nudge',
        body: `nudge ${i}`,
        dedupeKey: `n:${i}`,
      })
    }

    const history = nudgeHistory(r.reminderId, 4)
    expect(history).toEqual(['nudge 5', 'nudge 6', 'nudge 7', 'nudge 8'])
  })
})
