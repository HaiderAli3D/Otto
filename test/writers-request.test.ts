import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composeBrief } from '../src/agent/brief.js'
import { composeDigest } from '../src/agent/compose.js'
import { __setModelClient } from '../src/agent/llm.js'
import { writeNudge } from '../src/agent/nudge.js'
import { composeWeeklyReview } from '../src/agent/review.js'
import { ensureSchema } from '../src/db/client.js'
import { createReminder } from '../src/services/reminders.js'
import { weeklyRecord } from '../src/services/signals.js'
import { fakeModel, say } from './fakeModel.js'
import { makeDevice } from './helpers.js'

/**
 * The cheapest, highest-value test in the migration.
 *
 * All four one-shot writers run on 200-300 token budgets, and reasoning tokens are drawn from that
 * same budget. If any of them ever sends a reasoning effort above 'none', the reasoning pass eats
 * the whole cap, the completion comes back empty, and the surface falls through to its deterministic
 * template — silently, forever. No error, no thrown exception, and (before this migration) not even
 * a log line. Otto just quietly becomes a timetable.
 *
 * The comments in nudge.ts and brief.ts show the team was already burned by exactly this on the
 * previous provider, where the mechanism was `thinking` rather than `reasoning`.
 */

beforeEach(() => ensureSchema())
afterEach(() => __setModelClient(null))

const brief = () => ({
  slot: 'morning' as const,
  zone: 'Europe/London',
  events: [{ summary: 'Standup', startLocal: '09:30' }],
  reminders: [{ title: 'Dentist', evidence: 'due today' }],
  alarms: [{ label: 'Wake', firesAtLocal: '07:00' }],
  calendarUnreachable: false,
})

const digestItems = [
  { title: 'Bins', due: 'today', overdue: true, chased: 2, moved: 1 },
  { title: 'Tax return', due: 'Friday', overdue: false, chased: 0, moved: 3 },
]

describe('every one-shot writer disables reasoning', () => {
  it('the daily brief', async () => {
    const { client, requests } = fakeModel([{ output: [say('Dentist is today.')] }])
    __setModelClient(client)

    expect(await composeBrief(brief())).toBe('Dentist is today.')
    expect(requests[0]!.reasoning).toEqual({ effort: 'none' })
    expect(requests[0]!.max_output_tokens).toBe(300)
    expect(requests[0]!.store).toBe(false)
    // No tools on any of these four: they are stateless writers, not agents.
    expect(requests[0]!.tools).toBeUndefined()
  })

  it('the backlog digest', async () => {
    const { client, requests } = fakeModel([{ output: [say('Bins and the tax return.')] }])
    __setModelClient(client)

    expect(await composeDigest(digestItems, 'Europe/London')).toBe('Bins and the tax return.')
    expect(requests[0]!.reasoning).toEqual({ effort: 'none' })
    expect(requests[0]!.max_output_tokens).toBe(300)
  })

  it('the weekly review', async () => {
    const device = makeDevice('dev_wr')
    const { client, requests } = fakeModel([{ output: [say('A quiet week.')] }])
    __setModelClient(client)

    expect(await composeWeeklyReview(weeklyRecord(device.deviceId), 'Europe/London')).toBe('A quiet week.')
    expect(requests[0]!.reasoning).toEqual({ effort: 'none' })
    expect(requests[0]!.max_output_tokens).toBe(300)
  })

  it('the nudge writer — the tightest budget of the four, at 200', async () => {
    const device = makeDevice('dev_nw')
    const reminder = await createReminder(device, { title: 'Take the bins out', dueAtMillis: Date.now() + 3_600_000 })
    const { client, requests } = fakeModel([{ output: [say('Bins. Still.')] }])
    __setModelClient(client)

    expect(await writeNudge(reminder, device.timezone)).toBe('Bins. Still.')
    expect(requests[0]!.reasoning).toEqual({ effort: 'none' })
    expect(requests[0]!.max_output_tokens).toBe(200)
  })
})

describe('a writer that comes back empty falls through to its template', () => {
  it('treats an incomplete response as a failure rather than an answer', async () => {
    // Belt and braces for the case the test above exists to prevent: if reasoning ever DID eat the
    // budget, the writer must still produce its deterministic text rather than an empty message.
    const { client } = fakeModel([{ output: [], status: 'incomplete', incompleteReason: 'max_output_tokens' }])
    __setModelClient(client)

    const out = await composeDigest(digestItems, 'Europe/London')
    expect(out).toContain('Bins')
    expect(out).toContain('Tax return')
  })

  it('falls through when the request throws outright', async () => {
    const { client } = fakeModel([Object.assign(new Error('HTTP 401'), { status: 401 })])
    __setModelClient(client)

    const out = await composeDigest(digestItems, 'Europe/London')
    expect(out).toContain('While you were away')
  })
})
