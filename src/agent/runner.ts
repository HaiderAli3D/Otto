import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import type { Device } from '../services/devices.js'
import { loadSession, saveSession, type Msg } from '../services/sessions.js'
import { systemPrompt } from './prompt.js'
import { buildTools, runTool } from './tools.js'

const anthropic = config.anthropic ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null
const MAX_STEPS = 6

/**
 * Run one WhatsApp turn through the Claude agent: load conversation history, let the model call
 * tools (which set/cancel/list alarms and touch the calendar) until it produces a final text reply,
 * persist the updated history, and return the reply to send back on WhatsApp.
 */
export async function runAgentTurn(params: { waUserId: string; device: Device; text: string }): Promise<string> {
  if (!anthropic || !config.anthropic) {
    return "Otto's AI isn't configured yet (no Anthropic API key set). Alarms sent to your phone still work."
  }
  const { waUserId, device, text } = params
  const history: Msg[] = loadSession(waUserId)
  history.push({ role: 'user', content: text })

  const tools = buildTools()
  let reply = ''

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: systemPrompt(device),
      tools,
      messages: history,
    })
    history.push({ role: 'assistant', content: res.content })

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) {
      reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      break
    }

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

  saveSession(waUserId, history)
  return reply || 'Done.'
}
