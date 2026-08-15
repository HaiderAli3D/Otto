import type OpenAI from 'openai'
import { log } from '../lib/log.js'
import type { Device } from '../services/devices.js'
import {
  bumpSessionFailures,
  clearSessionFailures,
  loadSession,
  saveSession,
  trimToValidStart,
  type Item,
} from '../services/sessions.js'
import { MODEL, isTransient, modelClient, outputText } from './llm.js'
import { systemPrompt } from './prompt.js'
import { buildTools, runTool } from './tools.js'

// 18 tools and multi-step reminder work (list → complete → reply) need headroom. The fallback call
// below burns one step of the budget.
const MAX_STEPS = 10

/**
 * Bounds reasoning AND response text together — they are drawn from the same budget.
 *
 * 8192, up from the 2048 that bounded response text alone, because `effort: 'low'` now spends part
 * of this on reasoning before a single visible token is produced. Too tight a cap does not merely
 * truncate the reply; it can return a completion with NO text at all (see `finish`). You only pay
 * for what is generated, so the headroom is close to free.
 */
const MAX_OUTPUT_TOKENS = 8192

/** How many items to keep when repairing a session that keeps failing on a shape error. */
const SALVAGE_MESSAGES = 8

type Call = OpenAI.Responses.ResponseFunctionToolCall

/**
 * Append the model's own output to the running input.
 *
 * The whole array, in order, reasoning items included — that is the documented replay pattern, and
 * replaying the reasoning is what makes `effort: 'low'` worth anything across the steps of one turn.
 * (It is stripped again before the session is persisted; see lib/history.ts `stripReasoning`.)
 *
 * The cast is deliberate and narrow. `ResponseOutputItem` includes hosted-tool items — code
 * interpreter, shell, web search — that are not members of `ResponseInputItem`. This agent declares
 * only function tools, so nothing but messages, `function_call`s and reasoning items can appear.
 */
function pushOutput(history: Item[], res: OpenAI.Responses.Response): void {
  history.push(...(res.output as unknown as Item[]))
}

/**
 * Run one tool call and wrap the result as a `function_call_output`.
 *
 * EVERY path through this function returns exactly one output item for `call.call_id`, including
 * both error paths. That is not tidiness — a missing output makes the NEXT request a 400 ("no tool
 * output found for function call"), which `isTransient` correctly classifies as non-transient,
 * which bumps the failure counter, which trims the conversation at 2 and wipes it at 4. A
 * malformed-arguments bug would present as session corruption.
 */
async function resultItem(device: Device, call: Call): Promise<Item> {
  const out = (value: unknown): Item => ({
    type: 'function_call_output',
    call_id: call.call_id,
    output: JSON.stringify(value),
  })

  // `arguments` is a JSON STRING here, where the previous provider handed over a parsed object. So
  // this is a brand-new throw site inside the loop — and truncation at max_output_tokens lands in
  // it first, as a half-written object.
  let input: unknown
  try {
    input = call.arguments && call.arguments.length > 0 ? JSON.parse(call.arguments) : {}
  } catch (err) {
    log.error({ err, tool: call.name, raw: call.arguments.slice(0, 200) }, 'tool arguments were not valid JSON')
    return out({
      error: `your arguments for ${call.name} were not valid JSON — call it again with one complete JSON object`,
    })
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return out({ error: `your arguments for ${call.name} must be a JSON object` })
  }

  try {
    return out(await runTool(device, call.name, input as Record<string, unknown>))
  } catch (err) {
    log.error({ err, tool: call.name }, 'agent tool failed')
    return out({ error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The reply text, or an honest apology.
 *
 * The old code was `extractText(...) || 'Done.'`, which is now actively dangerous. Under the
 * previous provider, empty text with no tool use was near-impossible. Here, reasoning tokens are
 * drawn from `max_output_tokens`, so a truncated turn comes back `incomplete` with NO text and no
 * calls — and `|| 'Done.'` would report confident success for work that never happened. This is the
 * one failure mode that looks healthy from the outside, which is why it logs at error.
 */
function finish(res: OpenAI.Responses.Response): string {
  const text = outputText(res)
  if (text.length > 0) return text

  if (res.status === 'incomplete') {
    const reason = res.incomplete_details?.reason
    log.error({ reason, outputTokens: res.usage?.output_tokens }, 'agent response truncated with no text')
    if (reason === 'max_output_tokens') {
      return "That one ran away from me — give me the short version and I'll get it done."
    }
    return "I couldn't finish that thought — try me again."
  }

  // Completed, with genuinely nothing to say: the tool loop did the work. The ONLY case that keeps
  // the old behaviour.
  return 'Done.'
}

/**
 * INFO, not debug. Production runs LOG_LEVEL=info, so the previous debug line was effectively off
 * and a prompt-cache regression — a 10x swing on input cost — was invisible until the bill arrived.
 * One line per agent turn on a single-user server is nothing.
 */
function logUsage(res: OpenAI.Responses.Response): void {
  const usage = res.usage
  if (!usage) return
  log.info(
    {
      input: usage.input_tokens,
      cacheRead: usage.input_tokens_details?.cached_tokens,
      cacheWrite: usage.input_tokens_details?.cache_write_tokens,
      output: usage.output_tokens,
      reasoning: usage.output_tokens_details?.reasoning_tokens,
    },
    'agent usage',
  )
}

/**
 * Drive the tool loop, mutating `history`. Guarantees `history` ends on an assistant turn, never on
 * a dangling `function_call_output`.
 */
async function runLoop(device: Device, history: Item[]): Promise<string> {
  const client = modelClient()!
  // Built ONCE, before the loop: a remember_fact write during this turn must not change the cached
  // prefix mid-flight. It takes effect on the next turn.
  const instructions = systemPrompt(device)
  const tools = buildTools()

  const base = {
    model: MODEL,
    instructions,
    tools,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    // Low, not none: this is a cost-tier model choosing between 18 tools, and that choice is
    // exactly what reasoning buys. The four one-shot writers use 'none' — they have 200-300 token
    // budgets, where any reasoning at all would empty the completion.
    reasoning: { effort: 'low' as const },
    // The owner's private messages. Nothing here uses previous_response_id, so server-side
    // retention would buy nothing.
    store: false,
    // Required to get reasoning items back at all in stateless mode, which `pushOutput` replays.
    include: ['reasoning.encrypted_content' as const],
    // Routes one owner's turns to the same cache shard.
    prompt_cache_key: device.deviceId,
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.create({ ...base, input: history })
    if (step === 0) logUsage(res)
    pushOutput(history, res)

    // Exit on the ABSENCE of tool calls rather than on a status value: more robust, and it
    // preserves the previous semantics exactly. `status` is consulted only inside `finish`.
    const calls = res.output.filter((item): item is Call => item.type === 'function_call')
    if (calls.length === 0) return finish(res)

    // Sequential, not Promise.all: these arm alarms and write rows, and the previous implementation
    // was sequential. Reordering side effects is not part of a provider migration.
    for (const call of calls) history.push(await resultItem(device, call))
  }

  // Step cap reached still mid-tool-use: the last item is a tool output. Make one final call that
  // forbids further tool use so the model must answer with text, leaving history ending on an
  // assistant turn. `tools` MUST stay defined — the input contains function_call and
  // function_call_output items, and dropping the definitions that describe them invites a 400.
  const res = await client.create({ ...base, input: history, tool_choice: 'none' })
  pushOutput(history, res)
  return finish(res)
}

/**
 * Run one WhatsApp turn: load history, let the model call tools until it produces a reply, persist a
 * VALID history, and return the reply.
 *
 * Failure handling is graduated rather than destructive. An earlier implementation called
 * `saveSession(..., [])` on ANY throw, so a single 429 or socket reset erased the owner's entire
 * conversation. Now: a transient error persists nothing at all (the last good state survives
 * untouched), and a genuine shape error has to recur before we trim, and recur again before we
 * clear.
 */
export async function runAgentTurn(params: {
  waUserId: string
  device: Device
  /**
   * The user turn: a plain string for text and for a transcribed voice note, or content parts for a
   * photo. Parts rather than a second parameter so `services/ingest.ts` decides the shape once and
   * every path below — history, trimming, persistence — stays identical.
   */
  content: string | OpenAI.Responses.ResponseInputContent[]
}): Promise<string> {
  if (!modelClient()) {
    return "Otto's AI isn't configured yet (no OpenAI API key set). Alarms sent to your phone still work."
  }
  const { waUserId, device, content } = params
  const history: Item[] = loadSession(waUserId)
  history.push({ role: 'user', content } as Item)

  try {
    const reply = await runLoop(device, history)
    saveSession(waUserId, device.deviceId, history)
    clearSessionFailures(waUserId)
    return reply
  } catch (err) {
    if (isTransient(err)) {
      // Persist NOTHING. The in-memory mutations die with this call; the next turn reloads the
      // last known-good history.
      log.warn({ err, waUserId }, 'agent turn failed transiently; history untouched')
      return "I couldn't reach my brain just then — try me again in a moment."
    }

    const fails = bumpSessionFailures(waUserId)
    log.error({ err, waUserId, fails }, 'agent turn failed')
    if (fails >= 4) {
      saveSession(waUserId, device.deviceId, [])
      clearSessionFailures(waUserId)
      log.error({ waUserId }, 'session cleared after repeated failures')
    } else if (fails >= 2) {
      const salvaged = trimToValidStart(loadSession(waUserId), SALVAGE_MESSAGES)
      saveSession(waUserId, device.deviceId, salvaged, SALVAGE_MESSAGES)
      log.warn({ waUserId, kept: salvaged.length }, 'session trimmed after repeated failures')
    }
    return 'Sorry — I hit a snag. Please try that again.'
  }
}
