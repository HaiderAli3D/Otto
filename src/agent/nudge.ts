import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { nudgeText } from '../lib/nagLadder.js'
import { log } from '../lib/log.js'
import { unquote } from '../lib/text.js'
import { renderFacts } from '../services/facts.js'
import { nudgeHistory } from '../services/outbox.js'
import type { Reminder } from '../services/reminders.js'
import { reminderEvidence } from '../services/signals.js'
import { PERSONA, WRITING } from './persona.js'

const anthropic = config.anthropic ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null

/**
 * A nudge fires from the scheduler, not from a reply, so a hung request stalls the job loop rather
 * than one conversation. Bound it hard: worst case is two attempts of 15s.
 */
const TIMEOUT_MS = 15_000
const MAX_RETRIES = 1

/** Exported so a test can pin that this surface and the others share one persona. */
export const NUDGE_SYSTEM = [
  PERSONA,
  WRITING,
  [
    '# This message',
    'You are writing ONE nudge: an unprompted message chasing a single task the owner has not',
    'finished. They did not just message you — you are interrupting them.',
    'One or two sentences. No greeting, no sign-off.',
    'Name the task, so they know which one you mean.',
    'Everything you know about this chase is below, including every nudge you have already sent for',
    'it. Do not reuse a line you have already used, and do not restate what you have already said —',
    'this is an escalation, not a resend.',
    'Leave it answerable in one word — "done", "later", "drop it" — without listing those options',
    'like a menu.',
    'Reply with the message text and nothing else. No quotes around it, no preamble.',
  ].join('\n'),
].join('\n\n')

/**
 * Write the next nudge for a reminder.
 *
 * Deliberately shaped like `compose.ts` rather than `runAgentTurn`: stateless, no tools, no session
 * read or write. The scheduler is not serialized against the inbound webhook chain, so anything
 * that touched conversation state from here would race it.
 *
 * Every failure path — no API key, timeout, transport error, empty completion — returns the exact
 * templated string this function replaced. That is the point: nudges fire at 3am on a machine that
 * may have no working Anthropic credentials, and a nudge that doesn't send is worse than a nudge
 * that reads like a template.
 */
export async function writeNudge(r: Reminder, zone: string, overdueDescription?: string): Promise<string> {
  const templated = nudgeText(r.title, r.nagCount, overdueDescription)
  if (!anthropic || !config.anthropic) return templated

  const already = nudgeHistory(r.reminderId)
  const context = [
    `Task: ${r.title}`,
    r.detail ? `Detail: ${r.detail}` : null,
    `Timing: ${reminderEvidence(r, zone)}`,
    `This is nudge number ${r.nagCount + 1} for this task.`,
    already.length > 0
      ? `Nudges you have already sent for it, oldest first:\n${already.map((b) => `- ${b}`).join('\n')}`
      : 'You have not nudged them about this one yet.',
    renderFacts(r.deviceId),
  ]
    .filter((l): l is string => l !== null)
    .join('\n\n')

  try {
    const res = await anthropic.messages.create(
      {
        model: config.anthropic.model,
        max_tokens: 200,
        // Thinking is ON by default from Sonnet 5 / Opus 5 onward, and max_tokens caps thinking
        // AND response text together. At 200 tokens a thinking pass would eat the whole budget and
        // return an empty completion — which falls through to the template and silently undoes this
        // whole module. One sentence chasing a known task needs no reasoning; turn it off.
        thinking: { type: 'disabled' },
        system: NUDGE_SYSTEM,
        messages: [{ role: 'user', content: context }],
      },
      { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES },
    )
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    return unquote(text) || templated
  } catch (err) {
    log.warn({ err, reminderId: r.reminderId }, 'nudge composition failed; using the templated fallback')
    return templated
  }
}
