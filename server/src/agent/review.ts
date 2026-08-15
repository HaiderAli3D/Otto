import { unquote } from '../lib/text.js'
import type { WeeklyRecord } from '../services/signals.js'
import { composeText, modelClient } from './llm.js'
import { PERSONA, WRITING } from './persona.js'

/** Same envelope as the nudge writer: this runs on the scheduler, so a hung request stalls jobs. */
const TIMEOUT_MS = 15_000
const MAX_RETRIES = 1

/** Exported so a test can pin that this surface and the others share one persona. */
export const REVIEW_SYSTEM = [
  PERSONA,
  WRITING,
  [
    '# This message',
    "You are writing the owner's weekly review. Nobody asked for it — it arrives on a Sunday evening",
    'because you send one every week.',
    'Lead with what actually happened. Then AT MOST TWO patterns. Then stop.',
    'Up to five short lines. That narrowly overrides the usual one-to-three-sentence rule, for THIS',
    'message only — every other surface still holds to it.',
    'The numbers below are the whole of your evidence. Do not round them, do not average them, and',
    'do not claim a trend you cannot point at in them.',
    'Everything listed as still open IS still open, so nothing here has already been fixed and every',
    'pattern in it is fair to raise.',
    'If anything in the list touches health, family, money trouble or grief, drop the edge entirely',
    'and just report it.',
    'Never offer to change how any of this works, and never imply you might stop helping.',
    'Reply with the message text and nothing else. No quotes around it, no preamble.',
  ].join('\n'),
].join('\n\n')

/**
 * The review as a plain string of facts.
 *
 * This is what actually ships whenever there is no API key, the request times out, or the
 * completion comes back empty — and it is what every test exercises, since `config.openai` is
 * null under vitest. It has to read as a real message on its own, not as a degraded one.
 */
function fallback(r: WeeklyRecord): string {
  const lines = [`This week: ${r.finished} finished, ${r.dropped} dropped, ${r.stillOpen} still open.`]

  if (r.alarmsRang > 0 || r.snoozeTotal > 0 || r.alarmsMissed > 0 || r.wakeChecksFailed > 0) {
    const parts = [`${r.alarmsRang} rang`]
    if (r.snoozeTotal > 0) parts.push(`${r.snoozeTotal} snoozes`)
    if (r.alarmsMissed > 0) parts.push(`${r.alarmsMissed} slept through`)
    if (r.wakeChecksFailed > 0) parts.push(`${r.wakeChecksFailed} dismissed then back to sleep`)
    lines.push(`Alarms: ${parts.join(', ')}.`)
  }

  if (r.slippers.length > 0) {
    const stuck = r.slippers.map((s) => `${s.title} (moved ${s.moved}×, chased ${s.chased}×)`).join('; ')
    lines.push(`Still sitting there: ${stuck}.`)
  }

  return lines.join('\n')
}

/**
 * Compose the weekly review with the model.
 *
 * Shaped exactly like `compose.ts` and `nudge.ts`, and deliberately NOT `runAgentTurn`: that one
 * reads and writes the session and is serialized per-user by the inbound chain, so calling it from
 * the scheduler would write history with no user turn and race the webhook. Stateless, no tools,
 * and every failure path lands on `fallback`.
 */
export async function composeWeeklyReview(r: WeeklyRecord, zone: string): Promise<string> {
  const templated = fallback(r)
  if (!modelClient()) return templated

  const context = [
    `Timezone ${zone}. The last seven days:`,
    `- Reminders: ${r.finished} finished, ${r.dropped} dropped, ${r.created} created, ${r.stillOpen} still open now.`,
    r.finishedTitles.length > 0 ? `- Finished: ${r.finishedTitles.join('; ')}.` : null,
    `- Alarms: ${r.alarmsRang} rang, ${r.alarmsSnoozed} of them snoozed (${r.snoozeTotal} snoozes in total), ${r.alarmsMissed} slept through, ${r.wakeChecksFailed} dismissed then back to sleep.`,
    r.slippers.length > 0
      ? `- Still open and slipping:\n${r.slippers.map((s) => `  - ${s.title} (moved ${s.moved}×, chased ${s.chased}×)`).join('\n')}`
      : '- Nothing open is visibly slipping.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n')

  const text = await composeText({
    system: REVIEW_SYSTEM,
    user: context,
    maxOutputTokens: 300,
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    logContext: { surface: 'weeklyReview' },
  })
  return (text ? unquote(text) : '') || templated
}
