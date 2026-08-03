import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { BRIEF_SYSTEM } from '../src/agent/brief.js'
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

  it('the brief composer carries the same persona', () => {
    expect(BRIEF_SYSTEM).toContain(PERSONA)
    expect(BRIEF_SYSTEM).toContain(WRITING)
  })

  it('makes the brief overriding WRITING explicit rather than leaving it to be inferred', () => {
    // The brief is the one surface allowed a line per item, which contradicts WRITING's one-to-three
    // sentences. Both blocks are in the same system prompt, so the override has to be stated — an
    // unstated conflict is resolved by whichever the model weighs more that day.
    expect(BRIEF_SYSTEM).toContain('# Writing')
    expect(BRIEF_SYSTEM).toContain('HERE ONLY')
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

describe('the quiet-hours section describes what the code actually does', () => {
  // Both of these are pinned as prompt TEXT because the prompt is the only artefact — the model
  // reads these lines and answers the owner from them, so a line that is untrue is a bug the same
  // way a wrong branch is.
  const core = (deviceId: string): string => systemPrompt(makeDevice(deviceId))[0]!.text

  it('names the owner-chosen due time as an exception to auto-deferral', () => {
    // nagLadder returns rung 0 at a still-future due time untouched. The section used to promise
    // "anything you schedule that would land inside that window is moved" and list three
    // exceptions, so "remind me to take my pills at 2am" got a 02:00 nudge while Otto told the
    // owner he would chase at 07:00 — a lie, in the one section that forbids exactly that.
    const text = core('dev_pe9')
    expect(text).toContain('Four things go through regardless')
    expect(text).toContain('a due time the owner picked themselves')
    expect(text).toContain('Never tell them a reminder due inside their quiet hours will wait until morning')
  })

  it('reconciles wake-checks with the alarm section that says you never follow one up', () => {
    // ALARMS_VS_REMINDERS says of create_alarm "It rings once. You never follow up on it", and is
    // read BEFORE this section. Naming the contradiction here is the seam-respecting fix: editing
    // the earlier section is a cross-branch conflict, and should be.
    const text = core('dev_pe10')
    expect(text).toContain('You never follow up on it')
    expect(text).toContain('This is the one exception to "it rings once, you never follow up on it"')
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
