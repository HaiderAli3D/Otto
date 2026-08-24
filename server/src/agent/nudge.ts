import { nudgeTextFor, rungPhaseFor, type RungPhase } from '../lib/nagLadder.js'
import { unquote } from '../lib/text.js'
import { renderFacts } from '../services/facts.js'
import { nudgeHistory } from '../services/outbox.js'
import { timingKindOf, type Reminder } from '../services/reminders.js'
import { reminderEvidence } from '../services/signals.js'
import { composeText, modelClient } from './llm.js'
import { PERSONA, WRITING } from './persona.js'

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

/** "3 hours", "2 days", "20 minutes" — enough for a sentence, never a precise duration. */
function roughGap(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/**
 * Where this rung sits, in words — the sentence the writer needs and the counts cannot give it.
 *
 * Deliberately says what the timing MEANS rather than naming the enum: "it has to be finished by
 * then" is what changes the wording, and "timing=deadline" is jargon the model has to translate.
 */
function describePosition(r: Reminder, phase: RungPhase, now: number): string {
  // Before the kind is mentioned at all. A kind describes what a due time MEANS, so pairing one
  // with "it has no date" handed the model a sentence about a time that does not exist — and now
  // that undated reminders are actually chased, that would have been the wording of every single
  // one of these. Nothing here is late, and the message must not imply it is: this rung is asking
  // whether the thing is still wanted, not chasing a miss.
  if (r.dueAtMillis === null) {
    return (
      'This one has NO date on it. Nothing about it is late and you must not suggest it is — you ' +
      'are checking it is still wanted, and nudging them to either do it or give you a time for it.'
    )
  }

  const kind = timingKindOf(r)
  const meaning =
    kind === 'deadline'
      ? 'This is a deadline: the task has to be FINISHED by that time.'
      : kind === 'appointment'
        ? 'This is an appointment: it happens at that moment and is then over.'
        : 'This is a plain reminder: that time is when they asked to be told, not when anything happens.'

  if (phase === 'lead') {
    return (
      `${meaning} It is NOT due yet — they have ${roughGap(r.dueAtMillis - now)} left. ` +
      'You are giving them a heads-up so it gets done in time. Do not tell them off for something ' +
      'that is not late.'
    )
  }
  if (phase === 'due') return `${meaning} That moment is now.`
  return `${meaning} It is ${roughGap(now - r.dueAtMillis)} overdue.`
}

/**
 * Write the next nudge for a reminder.
 *
 * Deliberately shaped like `compose.ts` rather than `runAgentTurn`: stateless, no tools, no session
 * read or write. The scheduler is not serialized against the inbound webhook chain, so anything
 * that touched conversation state from here would race it.
 *
 * Every failure path — no API key, timeout, transport error, empty completion — returns the exact
 * templated string this function replaced. That is the point: nudges fire at 3am on a machine that
 * may have no working model credentials, and a nudge that doesn't send is worse than a nudge that
 * reads like a template.
 */
export async function writeNudge(
  r: Reminder,
  zone: string,
  overdueDescription?: string,
  ladder?: { leadCount: number; totalRungs: number },
): Promise<string> {
  const leadCount = ladder?.leadCount ?? 0
  const phase = rungPhaseFor(leadCount, r.nagCount)
  const index = phase === 'lead' ? r.nagCount : phase === 'due' ? 0 : r.nagCount - leadCount - 1
  const templated = nudgeTextFor({ title: r.title, phase, index, overdueDescription })
  // Checked before the context is built: assembling it costs two DB reads (nudge history, facts).
  if (!modelClient()) return templated

  const already = nudgeHistory(r.reminderId)
  const context = [
    `Task: ${r.title}`,
    r.detail ? `Detail: ${r.detail}` : null,
    `Timing: ${reminderEvidence(r, zone, Date.now(), leadCount)}`,
    // The phase is the one thing that genuinely licenses a different sentence at each rung, and it
    // is not derivable from the count alone. Without it a warning three hours before a deadline
    // reads as a chase, which is the fastest way to teach someone to ignore the warnings.
    describePosition(r, phase, Date.now()),
    ladder
      ? `This is rung ${r.nagCount + 1} of ${ladder.totalRungs} on this ladder.`
      : `This is nudge number ${r.nagCount + 1} for this task.`,
    already.length > 0
      ? `Nudges you have already sent for it, oldest first:\n${already.map((b) => `- ${b}`).join('\n')}`
      : 'You have not nudged them about this one yet.',
    renderFacts(r.deviceId),
  ]
    .filter((l): l is string => l !== null)
    .join('\n\n')

  // `reasoning: { effort: 'none' }` lives in composeText and is load-bearing at this 200-token cap
  // — see the note there.
  const text = await composeText({
    system: NUDGE_SYSTEM,
    user: context,
    maxOutputTokens: 200,
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    logContext: { surface: 'nudge', reminderId: r.reminderId },
  })
  return (text ? unquote(text) : '') || templated
}
