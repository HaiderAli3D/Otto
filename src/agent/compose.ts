import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { log } from '../lib/log.js'

const anthropic = config.anthropic ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null

const SYSTEM = [
  'You are Otto, the owner\'s personal assistant, writing a short catch-up on WhatsApp.',
  'They have been away and several reminders came due while you could not reach them.',
  'Write ONE short message: lead with what actually needs action, group related things, and keep',
  'it to two or three sentences. No headers, no bullet lists, no greeting boilerplate.',
  'Do not apologise for the delay and do not explain that you were unable to message them.',
  'Warm and dry, not chirpy. No emoji.',
].join('\n')

export type DigestItem = { title: string; due: string | null; overdue: boolean }

function fallback(items: DigestItem[]): string {
  const lines = items.map((i) => (i.due ? `${i.title} (${i.due})` : i.title))
  if (lines.length === 1) return `While you were away: ${lines[0]} is still open.`
  return `While you were away, these are still open:\n${lines.map((l) => `- ${l}`).join('\n')}`
}

/**
 * Compose the backlog digest with the model.
 *
 * Deliberately NOT `runAgentTurn`: that one is stateful (it reads and writes the session) and is
 * serialized per-user by the inbound chain, so calling it from the scheduler would write history
 * with no user turn and race the webhook. This is a single stateless call with no tools, and any
 * failure degrades to the templated string rather than losing the digest.
 */
export async function composeDigest(items: DigestItem[], zone: string): Promise<string> {
  if (items.length === 0) return ''
  if (!anthropic || !config.anthropic || items.length < 2) return fallback(items)

  const rendered = items
    .map((i) => `- ${i.title}${i.due ? ` (due ${i.due}${i.overdue ? ', overdue' : ''})` : ' (no date)'}`)
    .join('\n')

  try {
    const res = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Timezone ${zone}. Outstanding:\n${rendered}` }],
    })
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    return text || fallback(items)
  } catch (err) {
    log.warn({ err }, 'digest composition failed; using the templated fallback')
    return fallback(items)
  }
}
