import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import type { Device } from '../services/devices.js'
import { loadSession, saveSession, type Msg } from '../services/sessions.js'
import { systemPrompt } from './prompt.js'
import { buildTools, runTool } from './tools.js'

const anthropic = config.anthropic ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null
const MAX_STEPS = 6
const MAX_TOKENS = 1024

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * Drive the tool loop, mutating `history`. Guarantees `history` ends on an assistant turn so the
 * next user message still alternates roles (Anthropic rejects two consecutive user turns).
 */
async function runLoop(device: Device, history: Msg[]): Promise<string> {
  const client = anthropic!
  const model = config.anthropic!.model
  const system = systemPrompt(device)
  const tools = buildTools()

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({ model, max_tokens: MAX_TOKENS, system, tools, messages: history })
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
  // call WITHOUT tools so the model must answer with text, leaving history ending on an assistant
  // turn (never a dangling tool_result). Prevents the "two user turns in a row" poisoning.
  const res = await client.messages.create({ model, max_tokens: MAX_TOKENS, system, messages: history })
  history.push({ role: 'assistant', content: res.content })
  return extractText(res.content) || 'Done.'
}

/**
 * Run one WhatsApp turn: load history, let Claude call tools until it produces a reply, persist a
 * VALID history, and return the reply. On any API/shape error the session is reset so a single bad
 * turn can't poison the conversation forever.
 */
export async function runAgentTurn(params: { waUserId: string; device: Device; text: string }): Promise<string> {
  if (!anthropic || !config.anthropic) {
    return "Otto's AI isn't configured yet (no Anthropic API key set). Alarms sent to your phone still work."
  }
  const { waUserId, device, text } = params
  const history: Msg[] = loadSession(waUserId)
  history.push({ role: 'user', content: text })

  try {
    const reply = await runLoop(device, history)
    saveSession(waUserId, history)
    return reply
  } catch (err) {
    log.error({ err, waUserId }, 'agent turn failed; resetting session')
    saveSession(waUserId, []) // clean slate — next message starts fresh instead of re-failing
    return 'Sorry — I hit a snag. Please try that again.'
  }
}
