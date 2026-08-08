/**
 * Live smoke test against the real OpenAI API. `npm run smoke`.
 *
 * WHY THIS EXISTS: nothing in `npm test` touches the network, by design — the suite is hermetic
 * because `test/setup-env.ts` omits the API key. That means the unit tests cannot tell you whether
 * the wire format is actually accepted by OpenAI, and every production surface fails soft to a
 * deterministic template, so a completely broken integration looks like a slightly boring Otto.
 * This script is the integration test. Run it before deploying.
 *
 * Deliberately imports only leaf modules (`agent/tools/alarms.ts` has one type-only import,
 * `agent/persona.ts` has none), so it needs OPENAI_API_KEY and nothing else — no database, no
 * Firebase service account, no .env beyond the key.
 *
 * Checks 3 and 6 are DEPLOY GATES. Do not ship on a red.
 */
import OpenAI from 'openai'
import { alarmTools } from '../src/agent/tools/alarms.js'
import { PERSONA, WRITING } from '../src/agent/persona.js'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set. Export it and re-run; the key is never printed.')
  process.exit(1)
}

const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna'
const client = new OpenAI({ apiKey })

const tools = alarmTools.map((t) => ({
  type: 'function' as const,
  name: t.name,
  description: t.description,
  parameters: t.parameters as Record<string, unknown>,
  strict: false,
}))

let failures = 0
let gateFailed = false

function report(n: number, name: string, ok: boolean, detail: string, gate = false): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}. ${name}${gate ? '  [GATE]' : ''}\n      ${detail}`)
  if (!ok) {
    failures++
    if (gate) gateFailed = true
  }
}

function textOf(res: OpenAI.Responses.Response): string {
  return res.output
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content)
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('\n')
    .trim()
}

async function main(): Promise<void> {
  console.log(`Model: ${MODEL}\n`)

  // 1. The one-shot writer shape. The four short writers run on 200-300 token caps, and reasoning
  //    tokens come out of that same budget — so this proves effort:'none' really spends zero.
  const one = await client.responses.create({
    model: MODEL,
    instructions: [PERSONA, WRITING].join('\n\n'),
    input: 'Remind me in one sentence that the bins go out tonight.',
    max_output_tokens: 200,
    reasoning: { effort: 'none' },
    store: false,
  })
  const reasoningUsed = one.usage?.output_tokens_details?.reasoning_tokens ?? -1
  report(
    1,
    "one-shot writer at effort:'none'",
    one.status === 'completed' && textOf(one).length > 0 && reasoningUsed === 0,
    `status=${one.status} reasoning_tokens=${reasoningUsed} text=${JSON.stringify(textOf(one).slice(0, 60))}`,
  )

  // 2. Tool emission. Printed, never executed.
  const two = await client.responses.create({
    model: MODEL,
    instructions: 'You set alarms on the owner\'s phone. The local time is 2026-08-08T09:00:00, Europe/London.',
    input: 'set an alarm for 7am tomorrow',
    tools,
    max_output_tokens: 2048,
    reasoning: { effort: 'low' },
    store: false,
    include: ['reasoning.encrypted_content'],
  })
  const call = two.output.find((i) => i.type === 'function_call')
  let parsed: unknown = null
  try {
    parsed = call ? JSON.parse(call.arguments) : null
  } catch {
    parsed = null
  }
  report(
    2,
    'emits a create_alarm function_call with parseable arguments',
    call?.name === 'create_alarm' && parsed !== null,
    `name=${call?.name ?? 'none'} arguments=${call?.arguments ?? 'none'}`,
  )

  // 3. GATE — the replay. The only check that catches a malformed replay before production.
  if (call) {
    const three = await client.responses.create({
      model: MODEL,
      instructions: 'You set alarms on the owner\'s phone.',
      input: [
        { role: 'user', content: 'set an alarm for 7am tomorrow' },
        ...(two.output as never[]),
        { type: 'function_call_output', call_id: call.call_id, output: '{"ok":true,"alarmId":"alm_1"}' },
      ],
      tools,
      max_output_tokens: 2048,
      reasoning: { effort: 'low' },
      store: false,
      include: ['reasoning.encrypted_content'],
    })
    report(
      3,
      'accepts the full output replay + function_call_output',
      three.status === 'completed' && textOf(three).length > 0,
      `status=${three.status} text=${JSON.stringify(textOf(three).slice(0, 80))}`,
      true,
    )

    // 4. The MAX_STEPS escape hatch: tools still declared, but forbidden.
    const four = await client.responses.create({
      model: MODEL,
      instructions: 'You set alarms on the owner\'s phone.',
      input: [
        { role: 'user', content: 'set an alarm for 7am tomorrow' },
        ...(two.output as never[]),
        { type: 'function_call_output', call_id: call.call_id, output: '{"ok":true}' },
      ],
      tools,
      tool_choice: 'none',
      max_output_tokens: 2048,
      reasoning: { effort: 'low' },
      store: false,
    })
    report(
      4,
      "tool_choice:'none' with tools present forces a text answer",
      four.output.every((i) => i.type !== 'function_call') && textOf(four).length > 0,
      `status=${four.status} calls=${four.output.filter((i) => i.type === 'function_call').length}`,
    )
  } else {
    report(3, 'replay', false, 'skipped — no function_call to replay', true)
    report(4, "tool_choice:'none'", false, 'skipped — no function_call to replay')
  }

  // 5. The image path. A 1x1 red JPEG.
  const JPEG_1PX =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
  const five = await client.responses.create({
    model: MODEL,
    instructions: 'Describe what you are shown in a few words.',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_image', detail: 'auto', image_url: `data:image/jpeg;base64,${JPEG_1PX}` },
          { type: 'input_text', text: 'what is this?' },
        ],
      },
    ],
    max_output_tokens: 200,
    reasoning: { effort: 'none' },
    store: false,
  })
  report(
    5,
    'accepts an input_image data URI',
    five.status === 'completed' && textOf(five).length > 0,
    `status=${five.status} text=${JSON.stringify(textOf(five).slice(0, 60))}`,
  )

  // 6. GATE — prompt caching. A long stable prefix sent twice with the same cache key. The cached
  //    prefix is a ~10x cost difference on input, and this repo has been bitten by losing it once.
  const bigPrefix = [PERSONA, WRITING, 'Reference notes:', 'lorem ipsum dolor sit amet. '.repeat(900)].join('\n\n')
  const cacheKey = 'smoke-cache-probe'
  const warm = await client.responses.create({
    model: MODEL,
    instructions: bigPrefix,
    input: 'Say OK.',
    max_output_tokens: 64,
    reasoning: { effort: 'none' },
    store: false,
    prompt_cache_key: cacheKey,
  })
  const hot = await client.responses.create({
    model: MODEL,
    instructions: bigPrefix,
    input: 'Say OK again.',
    max_output_tokens: 64,
    reasoning: { effort: 'none' },
    store: false,
    prompt_cache_key: cacheKey,
  })
  const cached = hot.usage?.input_tokens_details?.cached_tokens ?? 0
  report(
    6,
    'prompt caching engages on a repeated prefix',
    cached > 0,
    `first_input=${warm.usage?.input_tokens} second_input=${hot.usage?.input_tokens} cached=${cached}`,
    true,
  )

  // 7. Truncation. Not a pass/fail so much as "learn the real shape" — runner.ts `finish()` is
  //    written against this, and it is the failure that otherwise reports success.
  const seven = await client.responses.create({
    model: MODEL,
    instructions: 'You are a careful assistant.',
    input: 'Write a detailed 2000-word essay about the history of alarm clocks.',
    max_output_tokens: 16,
    reasoning: { effort: 'low' },
    store: false,
  })
  report(
    7,
    'a starved budget reports incomplete rather than empty success',
    seven.status === 'incomplete',
    `status=${seven.status} reason=${seven.incomplete_details?.reason ?? 'none'} text=${JSON.stringify(textOf(seven))}`,
  )

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
  if (gateFailed) console.log('A DEPLOY GATE failed — do not deploy.')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('smoke run threw:', err instanceof Error ? err.message : err)
  process.exit(1)
})
