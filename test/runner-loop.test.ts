import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __setModelClient } from '../src/agent/llm.js'
import { runAgentTurn } from '../src/agent/runner.js'
import { buildTools } from '../src/agent/tools.js'
import { ensureSchema } from '../src/db/client.js'
import { loadSession, saveSession } from '../src/services/sessions.js'
import { fakeModel, fnCall, say, think } from './fakeModel.js'
import { makeDevice } from './helpers.js'

/**
 * The wire-format coverage this suite has never had.
 *
 * `test/setup-env.ts` deliberately omits the API key, so `config.openai` is null and every OTHER
 * test in the repo exercises the deterministic template fallback. That makes the suite hermetic, but
 * it also means it would stay entirely green through a completely malformed model integration —
 * and because every production surface fails soft to a template, so would production. These tests
 * drive the real `runLoop` against a fake client and assert on the REQUEST it builds.
 */

beforeEach(() => ensureSchema())
afterEach(() => __setModelClient(null))

const device = () => makeDevice('dev_loop')

describe('the request the runner builds', () => {
  it('sends the model, tools, reasoning effort and output cap', async () => {
    const { client, requests } = fakeModel([{ output: [say('Peru is Lima.')] }])
    __setModelClient(client)

    const reply = await runAgentTurn({ waUserId: 'wa_r1', device: device(), content: 'capital of Peru?' })

    expect(reply).toBe('Peru is Lima.')
    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.model).toBe('gpt-5.6-luna')
    expect(req.reasoning).toEqual({ effort: 'low' })
    expect(req.max_output_tokens).toBe(8192)
    expect(req.store).toBe(false)
    expect(req.include).toEqual(['reasoning.encrypted_content'])
    expect(req.prompt_cache_key).toBe('dev_loop')
    // tool_choice is left unset until the step cap forces it.
    expect(req.tool_choice).toBeUndefined()
    // Against buildTools(), not a literal. What this test is for is that the runner sends the WHOLE
    // list; the exact count is pinned deliberately in tools-order.test.ts, and duplicating the
    // number here only means a new tool reddens two files while the second one teaches nothing.
    expect(req.tools).toHaveLength(buildTools().length)
    expect(req.tools!.map((t) => (t as { name: string }).name)).toContain('create_alarm')
    expect(typeof req.instructions).toBe('string')
  })
})

describe('the tool loop', () => {
  it('replays the whole output array, reasoning included, then one output per call', async () => {
    const { client, requests } = fakeModel([
      { output: [think('rs_1'), fnCall('list_alarms', {}, 'call_a')] },
      { output: [say('Nothing set.')] },
    ])
    __setModelClient(client)

    const reply = await runAgentTurn({ waUserId: 'wa_r2', device: device(), content: 'what alarms?' })

    expect(reply).toBe('Nothing set.')
    expect(requests).toHaveLength(2)

    // Step 1 must carry step 0's reasoning item AND its function_call, in order, followed by exactly
    // one function_call_output with the matching call_id. Dropping the reasoning item is the classic
    // port bug: nothing fails, the model just quietly gets less to work with.
    const replayed = requests[1]!.input as Array<Record<string, unknown>>
    expect(replayed.slice(-3)).toEqual([
      expect.objectContaining({ type: 'reasoning', id: 'rs_1' }),
      expect.objectContaining({ type: 'function_call', call_id: 'call_a', name: 'list_alarms' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_a' }),
    ])

    // Guards the guard: runLoop pushes onto the very array it passed as `input`, so if fakeModel
    // stored the reference instead of cloning it, both recorded requests would show the FINAL
    // conversation and every assertion above would pass vacuously.
    expect((requests[0]!.input as unknown[]).length).toBe(1)
    expect(replayed.length).toBe(4)
  })

  it('emits exactly one output per call when several are requested at once', async () => {
    const { client, requests } = fakeModel([
      {
        output: [
          fnCall('list_alarms', {}, 'call_1'),
          fnCall('list_reminders', {}, 'call_2'),
          fnCall('recall_facts', {}, 'call_3'),
        ],
      },
      { output: [say('All done.')] },
    ])
    __setModelClient(client)

    await runAgentTurn({ waUserId: 'wa_r3', device: device(), content: 'status' })

    const replayed = requests[1]!.input as Array<Record<string, unknown>>
    const outputs = replayed.filter((i) => i.type === 'function_call_output')
    expect(outputs.map((o) => o.call_id)).toEqual(['call_1', 'call_2', 'call_3'])
  })

  it('still returns an output when the arguments are not valid JSON', async () => {
    // `arguments` is a JSON STRING now, where the previous provider handed over a parsed object, so
    // JSON.parse is a brand-new throw site inside the loop — and truncation lands in it first.
    // Skipping the output item would 400 the NEXT request, which is non-transient, which trims the
    // conversation at 2 and wipes it at 4. A parsing bug would present as session corruption.
    const { client, requests } = fakeModel([
      { output: [fnCall('list_alarms', '{"whenLocalISO": ', 'call_bad')] },
      { output: [say('Say that again?')] },
    ])
    __setModelClient(client)

    const reply = await runAgentTurn({ waUserId: 'wa_r4', device: device(), content: 'set an alarm' })

    expect(reply).toBe('Say that again?')
    const replayed = requests[1]!.input as Array<Record<string, unknown>>
    const output = replayed.find((i) => i.type === 'function_call_output')
    expect(output).toBeTruthy()
    expect(output!.call_id).toBe('call_bad')
    expect(String(output!.output)).toContain('not valid JSON')
  })

  it('reports an unknown tool through the loop rather than throwing', async () => {
    const { client, requests } = fakeModel([
      { output: [fnCall('no_such_tool', {}, 'call_x')] },
      { output: [say('My mistake.')] },
    ])
    __setModelClient(client)

    await runAgentTurn({ waUserId: 'wa_r5', device: device(), content: 'do a thing' })

    const replayed = requests[1]!.input as Array<Record<string, unknown>>
    const output = replayed.find((i) => i.type === 'function_call_output')
    expect(String(output!.output)).toContain('unknown tool no_such_tool')
  })

  it('forbids further tool use once the step cap is reached', async () => {
    // Ten tool-only responses, then the escape hatch. `tools` MUST still be present on that final
    // request: the input is full of function_call/function_call_output items, and dropping the
    // definitions that describe them invites a 400.
    const script = Array.from({ length: 10 }, (_, i) => ({ output: [fnCall('list_alarms', {}, `call_${i}`)] }))
    const { client, requests } = fakeModel([...script, { output: [say('Enough of that.')] }])
    __setModelClient(client)

    const reply = await runAgentTurn({ waUserId: 'wa_r6', device: device(), content: 'loop please' })

    expect(reply).toBe('Enough of that.')
    expect(requests).toHaveLength(11)
    expect(requests[9]!.tool_choice).toBeUndefined()
    expect(requests[10]!.tool_choice).toBe('none')
    expect(requests[10]!.tools).toHaveLength(buildTools().length)
  })
})

describe('empty completions', () => {
  it('does NOT report success when the response was truncated', async () => {
    // The single most dangerous line in the migration. Reasoning tokens are drawn from
    // max_output_tokens, so an over-budget turn returns `incomplete` with no text and no calls. The
    // old `extractText(...) || 'Done.'` would have answered "Done." to work that never happened.
    const { client } = fakeModel([{ output: [], status: 'incomplete', incompleteReason: 'max_output_tokens' }])
    __setModelClient(client)

    const reply = await runAgentTurn({ waUserId: 'wa_r7', device: device(), content: 'write me an essay' })

    expect(reply).not.toBe('Done.')
    expect(reply).toContain('ran away from me')
  })

  it('still says Done. when the turn completed with nothing left to say', async () => {
    // The one case that keeps the old behaviour: the tool loop did the work, there is no closing
    // sentence, and the response genuinely completed.
    const { client } = fakeModel([{ output: [], status: 'completed' }])
    __setModelClient(client)

    const reply = await runAgentTurn({ waUserId: 'wa_r8', device: device(), content: 'ok' })
    expect(reply).toBe('Done.')
  })
})

describe('failure classification drives the repair ladder', () => {
  const httpError = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { status })

  it('leaves the transcript completely untouched on a transient error', async () => {
    const waUserId = 'wa_r9'
    const d = device()
    saveSession(waUserId, d.deviceId, [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ])
    const before = loadSession(waUserId)

    const { client } = fakeModel([httpError(429)])
    __setModelClient(client)

    const reply = await runAgentTurn({ waUserId, device: d, content: 'next' })

    expect(reply).toContain("couldn't reach my brain")
    // The last good state survives: a rate limit must never cost the owner their conversation.
    expect(loadSession(waUserId)).toEqual(before)
  })

  it('treats a connection error as transient too', async () => {
    const waUserId = 'wa_r10'
    const d = device()
    saveSession(waUserId, d.deviceId, [{ role: 'user', content: 'hello' }])

    const { client } = fakeModel([Object.assign(new Error('socket hang up'), { name: 'APIConnectionError' })])
    __setModelClient(client)

    const reply = await runAgentTurn({ waUserId, device: d, content: 'next' })
    expect(reply).toContain("couldn't reach my brain")
    expect(loadSession(waUserId)).toHaveLength(1)
  })

  it('clears the session after four non-transient failures, not before', async () => {
    const waUserId = 'wa_r11'
    const d = device()
    saveSession(waUserId, d.deviceId, [
      { role: 'user', content: 'a question' },
      { role: 'assistant', content: 'an answer' },
    ])

    // A 400 may mean the conversation itself is malformed, so it counts — but one is not enough.
    const { client } = fakeModel([httpError(400), httpError(400), httpError(400), httpError(400)])
    __setModelClient(client)

    for (let i = 0; i < 3; i++) {
      const reply = await runAgentTurn({ waUserId, device: d, content: `try ${i}` })
      expect(reply).toBe('Sorry — I hit a snag. Please try that again.')
    }
    expect(loadSession(waUserId).length).toBeGreaterThan(0)

    await runAgentTurn({ waUserId, device: d, content: 'try 4' })
    expect(loadSession(waUserId)).toEqual([])
  })
})
