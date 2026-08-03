import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import type { Device } from '../services/devices.js'
import {
  bumpSessionFailures,
  clearSessionFailures,
  loadSession,
  saveSession,
  trimToValidStart,
  type Msg,
} from '../services/sessions.js'
import { systemPrompt } from './prompt.js'
import { buildTools, runTool } from './tools.js'

const anthropic = config.anthropic ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null

// 15 tools and multi-step reminder work (list → complete → reply) need more headroom than the
// original 6. The fallback call below burns one step of the budget.
const MAX_STEPS = 10
// Bounds response text only (no `thinking` is set — the old budget_tokens shape 400s on this
// model). You only pay for what is generated, and 1024 truncated multi-item list replies.
const MAX_TOKENS = 2048

/** How many messages to keep when repairing a session that keeps failing on a shape error. */
const SALVAGE_MESSAGES = 8

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * A copy of `history` with a cache breakpoint on the final content block, so the next step in the
 * tool loop reads this step's entire conversation prefix from cache. Steps are seconds apart, well
 * inside the 5-minute TTL.
 *
 * Returns a copy deliberately: `cache_control` must never be persisted into the session JSON.
 */
function withConversationCacheBreakpoint(history: Msg[]): Msg[] {
  if (history.length === 0) return history
  const out = history.slice()
  const last = out[out.length - 1]
  if (!last) return out

  if (typeof last.content === 'string') {
    out[out.length - 1] = {
      role: last.role,
      content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }],
    }
    return out
  }
  if (!Array.isArray(last.content) || last.content.length === 0) return out
  const blocks = last.content.slice()
  const tail = blocks[blocks.length - 1]
  if (!tail || typeof tail !== 'object') return out
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } } as (typeof blocks)[number]
  out[out.length - 1] = { role: last.role, content: blocks }
  return out
}

/**
 * Transient = the request never really landed (network, rate limit, server fault). The persisted
 * history is fine and must be left alone. Anything else (a 400, a shape error) may mean the
 * conversation itself is malformed.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true
  if (err instanceof Anthropic.APIConnectionTimeoutError) return true
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0
    return status === 429 || status >= 500
  }
  return false
}

/**
 * Drive the tool loop, mutating `history`. Guarantees `history` ends on an assistant turn so the
 * next user message still alternates roles (Anthropic rejects two consecutive user turns).
 */
async function runLoop(device: Device, history: Msg[]): Promise<string> {
  const client = anthropic!
  const model = config.anthropic!.model
  // Built ONCE, before the loop: a remember_fact write during this turn must not change the
  // cached system prefix mid-flight. It takes effect on the next turn.
  const system = systemPrompt(device)
  const tools = buildTools()

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      messages: withConversationCacheBreakpoint(history),
    })
    if (step === 0) {
      log.debug(
        {
          cacheRead: res.usage.cache_read_input_tokens,
          cacheWrite: res.usage.cache_creation_input_tokens,
          input: res.usage.input_tokens,
        },
        'agent usage',
      )
    }
    history.push({ role: 'assistant', content: res.content })

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) return extractText(res.content) || 'Done.'

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      let output: unknown
      try {
        output = await runTool(device, tu.name, tu.input)
      } catch (err) {
        log.error({ err, tool: tu.name }, 'agent tool failed')
        output = { error: err instanceof Error ? err.message : String(err) }
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(output) })
    }
    history.push({ role: 'user', content: toolResults })
  }

  // Step cap reached still mid-tool-use: the last message is a user tool_result turn. Make one final
  // call that forbids further tool use (tool_choice: none) so the model must answer with text,
  // leaving history ending on an assistant turn (never a dangling tool_result). `tools` MUST stay
  // defined here — the Anthropic API rejects (400) any request whose messages contain
  // tool_use/tool_result blocks without a tools parameter.
  const res = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    tools,
    tool_choice: { type: 'none' },
    messages: withConversationCacheBreakpoint(history),
  })
  history.push({ role: 'assistant', content: res.content })
  return extractText(res.content) || 'Done.'
}

/**
 * Run one WhatsApp turn: load history, let Claude call tools until it produces a reply, persist a
 * VALID history, and return the reply.
 *
 * Failure handling is graduated rather than destructive. The previous implementation called
 * `saveSession(..., [])` on ANY throw, so a single 429 or socket reset erased the owner's entire
 * conversation. Now: a transient error persists nothing at all (the last good state survives
 * untouched), and a genuine shape error has to recur before we trim, and recur again before we
 * clear.
 */
export async function runAgentTurn(params: {
  waUserId: string
  device: Device
  /**
   * The user turn: a plain string for text and for a transcribed voice note, or content blocks for
   * a photo. Blocks rather than a second parameter so `services/ingest.ts` decides the shape once
   * and every path below — history, trimming, the cache breakpoint — stays identical.
   */
  content: string | Anthropic.ContentBlockParam[]
}): Promise<string> {
  if (!anthropic || !config.anthropic) {
    return "Otto's AI isn't configured yet (no Anthropic API key set). Alarms sent to your phone still work."
  }
  const { waUserId, device, content } = params
  const history: Msg[] = loadSession(waUserId)
  history.push({ role: 'user', content })

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
