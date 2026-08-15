import { composeText, modelClient } from './llm.js'
import { PERSONA, WRITING } from './persona.js'

/** Exported so a test can pin that this surface and the others share one persona. */
export const DIGEST_SYSTEM = [
  PERSONA,
  WRITING,
  [
    '# This message',
    'You are writing one short catch-up. The owner has been away and several reminders came due',
    'while you could not reach them.',
    'Lead with what actually needs action, group related things, and stop at two or three sentences.',
    'Do not apologise for the delay and do not explain that you were unable to message them.',
    'The list below is the whole of your evidence — how overdue something is, and how many times you',
    'have already chased or moved it, are fair game. You have no other record of them in front of',
    'you, so do not invent one.',
  ].join('\n'),
].join('\n\n')

export type DigestItem = {
  title: string
  due: string | null
  overdue: boolean
  /** Nudges already sent for this item, so the digest can escalate rather than restate. */
  chased: number
  /** Times the owner has pushed this back. */
  moved: number
}

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
  if (!modelClient() || items.length < 2) return fallback(items)

  const rendered = items
    .map((i) => {
      const when = i.due ? `due ${i.due}${i.overdue ? ', overdue' : ''}` : 'no date'
      const chased = i.chased > 0 ? `, chased ${i.chased}×` : ''
      const moved = i.moved > 0 ? `, moved ${i.moved}×` : ''
      return `- ${i.title} (${when}${chased}${moved})`
    })
    .join('\n')

  // No timeout/maxRetries override here, unlike the scheduler-driven surfaces: this one runs on the
  // inbound path, where the SDK defaults are fine. Deliberately does NOT unquote, as before.
  const text = await composeText({
    system: DIGEST_SYSTEM,
    user: `Timezone ${zone}. Outstanding:\n${rendered}`,
    maxOutputTokens: 300,
    logContext: { surface: 'digest' },
  })
  return text || fallback(items)
}
