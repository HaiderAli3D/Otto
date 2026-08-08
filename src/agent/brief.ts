import type { BriefSlot } from '../lib/briefSchedule.js'
import { unquote } from '../lib/text.js'
import { composeText, modelClient } from './llm.js'
import { PERSONA, WRITING } from './persona.js'

/**
 * DELIBERATE DEVIATION FROM compose.ts (1 of 2): this call is BOUNDED, like agent/nudge.ts and
 * unlike the digest composer.
 *
 * The digest is composed on the inbound path, where a slow request stalls one reply. A brief fires
 * from the scheduler, whose tick holds a `running` mutex for the whole pass — an unbounded request
 * that hangs would stop every other job on the server (nudges, arm-ack retries, recurrence
 * advances) for as long as the socket stayed open. Worst case here is two attempts of 15s.
 */
const TIMEOUT_MS = 15_000
const MAX_RETRIES = 1

/** Exported so test/persona.test.ts can pin that this surface and the others share one Otto. */
export const BRIEF_SYSTEM = [
  PERSONA,
  WRITING,
  [
    '# This message',
    'You are writing ONE daily brief. They did not ask for this just now, so the first line has to',
    'earn the interruption.',
    'Open with the single thing that most changes their day. If nothing does, open with the next',
    'thing that happens.',
    'Never a greeting, never the date, never "here is your day".',
    'A morning brief is about TODAY. An evening brief is about TOMORROW. Only ever one of the two.',
    'The data below is the WHOLE of your evidence. Invent no traffic, no weather, no travel time and',
    'no history you were not given.',
    'If the calendar says it could not be read, say so in a few words and never imply the day is',
    'clear — you do not know that. An empty calendar and an unreadable one are different messages.',
    'Three or four items at most. Drop the least important rather than listing everything.',
    'One short line per item is allowed HERE ONLY. That narrowly overrides the one-to-three-sentence',
    'rule in # Writing, for this message and nothing else.',
    'No sign-off. Leave them nothing to reply to.',
  ].join('\n'),
].join('\n\n')

/**
 * Everything the brief is allowed to mention, already resolved to the owner's local wall clock.
 *
 * Rendered strings rather than raw rows on purpose: the model never sees an epoch, an id, or a
 * timezone it could get wrong, and the deterministic fallback below reads the exact same fields.
 */
export type BriefInput = {
  slot: BriefSlot
  zone: string
  /** Timed calendar events in the window, e.g. `{ startLocal: '09:30', summary: 'Standup' }`. */
  events: Array<{ summary: string; startLocal: string }>
  /** Open reminders, `evidence` straight from services/signals.ts `reminderEvidence`. */
  reminders: Array<{ title: string; evidence: string }>
  /** Alarms already armed for the window, excluding any a reminder is renting. */
  alarms: Array<{ label: string; firesAtLocal: string }>
  /**
   * The calendar could not be read at all — revoked grant, expired token, Google down.
   *
   * Distinct from an empty `events`, and the distinction is the whole point: "nothing on today" is a
   * claim about their day, and making it because we could not ask is how the owner misses a 09:30
   * appointment on the strength of a message that sounded certain.
   */
  calendarUnreachable: boolean
}

/**
 * The brief with no model at all: at most three lines, mechanical, no adjectives, no judgement.
 *
 * Exported because it is the contract, not an implementation detail. There is no ANTHROPIC_API_KEY
 * in the test environment, so this is what the whole feature actually delivers under test — and on
 * any morning the Anthropic API is unreachable. A brief that reads like a timetable is worth having;
 * a 07:00 brief that fails to arrive is not.
 */
export function briefFallback(input: BriefInput): string {
  const day = input.slot === 'morning' ? 'Today' : 'Tomorrow'
  const lines: string[] = []
  if (input.calendarUnreachable) {
    // Said even though it is a fourth line, because the alternative is a brief that reads as a
    // complete picture of the day while silently missing every appointment in it.
    lines.push("I can't see your calendar right now.")
  }
  if (input.events.length > 0) {
    lines.push(`${day}: ${input.events.map((e) => `${e.startLocal} ${e.summary}`).join(', ')}.`)
  }
  if (input.reminders.length > 0) {
    lines.push(`Open: ${input.reminders.map((r) => `${r.title} (${r.evidence})`).join('; ')}.`)
  }
  if (input.alarms.length > 0) {
    lines.push(`Alarms set: ${input.alarms.map((a) => `${a.firesAtLocal} ${a.label}`).join(', ')}.`)
  }
  return lines.join('\n')
}

/** The user turn: DATA ONLY. Every instruction lives in BRIEF_SYSTEM, where it is cacheable. */
function renderInput(input: BriefInput): string {
  const day = input.slot === 'morning' ? 'today' : 'tomorrow'
  return [
    `This is the ${input.slot} brief, about ${day}. Timezone ${input.zone}.`,
    input.events.length > 0
      ? `Calendar (${day}):\n${input.events.map((e) => `- ${e.startLocal} ${e.summary}`).join('\n')}`
      : input.calendarUnreachable
        ? `Calendar (${day}): COULD NOT BE READ. This is not an empty calendar — it is no calendar.`
        : `Calendar (${day}): nothing.`,
    input.reminders.length > 0
      ? `Open reminders:\n${input.reminders.map((r) => `- ${r.title} (${r.evidence})`).join('\n')}`
      : 'Open reminders: none.',
    input.alarms.length > 0
      ? `Alarms already set for ${day}:\n${input.alarms.map((a) => `- ${a.firesAtLocal} ${a.label}`).join('\n')}`
      : `Alarms already set for ${day}: none.`,
  ].join('\n\n')
}

/**
 * Compose the daily brief with the model.
 *
 * Shaped like agent/compose.ts — stateless, no tools, no session read or write — and deliberately
 * NOT `runAgentTurn`, which is stateful and is serialized per-user by the inbound webhook chain.
 * Calling that from the scheduler would write conversation history with no user turn and race the
 * webhook for the same session row.
 *
 * DELIBERATE DEVIATION FROM compose.ts (2 of 2): there is NO "fewer than 2 items" short-circuit.
 * The digest bails to its template on a single item because a one-line list needs no writer. A
 * one-item brief is the opposite — it is precisely where the model earns its keep, because the whole
 * message is one sentence that has to justify having interrupted them ("Dentist call is four days
 * overdue."). Falling back there would make the most common brief the worst one.
 */
export async function composeBrief(input: BriefInput): Promise<string> {
  const templated = briefFallback(input)
  if (!modelClient()) return templated

  // An empty completion is a failure path like any other, and gets the same deterministic answer —
  // composeText returns null for it (and now logs it, which it previously did not).
  const text = await composeText({
    system: BRIEF_SYSTEM,
    user: renderInput(input),
    maxOutputTokens: 300,
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    logContext: { surface: 'brief', slot: input.slot },
  })
  return (text ? unquote(text) : '') || templated
}
