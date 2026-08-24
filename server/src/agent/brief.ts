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
    'You are writing ONE daily brief. They did not ask for this just now, so it has to earn the',
    'interruption.',
    '',
    '## A morning brief is the SHAPE of their day, in ONE sentence',
    'You are given counts and, at most, the next thing that happens. That is all you get, because',
    'that is all it is for: everything on that list will reach them again on its own, at the moment',
    'it actually matters. You are not listing their day, you are telling them how big it is.',
    'One sentence. "Three things today, first at 2." "Quiet one — just the dentist at 4."',
    'Never enumerate. Never name anything except the one item you were given as the next thing.',
    'If you were given no next thing, say only how much is on.',
    'Nothing is late at this hour and nothing has been missed, so there is no edge to take. Neutral.',
    '',
    '## An evening brief is about TOMORROW, and may list',
    'Open with the single thing that most changes their day. If nothing does, open with the next',
    'thing that happens.',
    'Three or four items at most. Drop the least important rather than listing everything.',
    'One short line per item is allowed HERE ONLY. That narrowly overrides the one-to-three-sentence',
    'rule in # Writing, for this message and nothing else.',
    '',
    '## Both',
    'Never a greeting, never the date, never "here is your day".',
    'Only ever one of the two — a morning brief never mentions tomorrow.',
    'The data below is the WHOLE of your evidence. Invent no traffic, no weather, no travel time and',
    'no history you were not given.',
    'If the calendar says it could not be read, say so in a few words and never imply the day is',
    'clear — you do not know that. An empty calendar and an unreadable one are different messages.',
    'No sign-off. Leave them nothing to reply to.',
  ].join('\n'),
].join('\n\n')

/**
 * The morning brief: how big the day is, and the next thing in it. NOT a list.
 *
 * This is the shape the owner's actual complaint bought — "don't remind me of everything in the
 * morning". Every dated reminder already carries its own ladder and will speak for itself at the
 * moment it matters, and the fan-out in `lib/spread.ts` is what stops those moments arriving
 * together. A list at the start of the day was therefore saying everything twice, once when it was
 * useless and once when it was not.
 *
 * Counts rather than rows, so the composer CANNOT enumerate even if it wanted to — the material is
 * not there. `first` is the single exception, because "three things today" with no anchor is a
 * number rather than a sentence.
 */
export type MorningBriefInput = {
  slot: 'morning'
  zone: string
  counts: { events: number; reminders: number; alarms: number }
  /** The next timed thing left in their waking day, already local. Null if nothing is timed. */
  first: { what: string; atLocal: string } | null
  calendarUnreachable: boolean
}

/**
 * The evening brief: unchanged, and deliberately so.
 *
 * It is about TOMORROW, so nothing in it can announce itself before they read it — a list is the
 * only useful form it has, and it is the natural home for the look-ahead the morning slot gave up.
 * It is also off by default. Do not "fix" the inconsistency between the two slots; it is the point.
 */
export type EveningBriefInput = {
  slot: 'evening'
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
   * Distinct from an empty `events`, and the distinction is the whole point: "nothing on tomorrow"
   * is a claim about their day, and making it because we could not ask is how the owner misses a
   * 09:30 appointment on the strength of a message that sounded certain.
   */
  calendarUnreachable: boolean
}

/**
 * Everything the brief is allowed to mention, already resolved to the owner's local wall clock.
 *
 * A discriminated union rather than one shape with optional halves: the two slots genuinely say
 * different kinds of thing now, and making the compiler force a branch at every consumer is what
 * stops a morning brief quietly acquiring a list again.
 *
 * Rendered strings rather than raw rows on purpose: the model never sees an epoch, an id, or a
 * timezone it could get wrong, and the deterministic fallback below reads the exact same fields.
 */
export type BriefInput = MorningBriefInput | EveningBriefInput

/** `n thing(s)`, or null when there are none — so the caller can drop the clause entirely. */
function count(n: number, singular: string, plural: string): string | null {
  if (n === 0) return null
  return `${n} ${n === 1 ? singular : plural}`
}

/**
 * The brief with no model at all: mechanical, no adjectives, no judgement.
 *
 * Exported because it is the contract, not an implementation detail. There is no OPENAI_API_KEY
 * in the test environment, so this is what the whole feature actually delivers under test — and on
 * any morning the model API is unreachable. A brief that reads like a timetable is worth having;
 * a brief that fails to arrive is not.
 *
 * The morning half is ONE line, matching the instruction above rather than merely being shorter
 * than it: if the fallback listed and the model did not, the owner would get the dump back on
 * exactly the mornings the API was down.
 */
export function briefFallback(input: BriefInput): string {
  if (input.slot === 'morning') return morningFallback(input)

  const lines: string[] = []
  if (input.calendarUnreachable) {
    // Said even though it is a fourth line, because the alternative is a brief that reads as a
    // complete picture of the day while silently missing every appointment in it.
    lines.push("I can't see your calendar right now.")
  }
  if (input.events.length > 0) {
    lines.push(`Tomorrow: ${input.events.map((e) => `${e.startLocal} ${e.summary}`).join(', ')}.`)
  }
  if (input.reminders.length > 0) {
    lines.push(`Open: ${input.reminders.map((r) => `${r.title} (${r.evidence})`).join('; ')}.`)
  }
  if (input.alarms.length > 0) {
    lines.push(`Alarms set: ${input.alarms.map((a) => `${a.firesAtLocal} ${a.label}`).join(', ')}.`)
  }
  return lines.join('\n')
}

function morningFallback(input: MorningBriefInput): string {
  const parts = [
    count(input.counts.events, 'thing on the calendar', 'things on the calendar'),
    count(input.counts.reminders, 'reminder', 'reminders'),
    count(input.counts.alarms, 'alarm', 'alarms'),
  ].filter((p): p is string => p !== null)

  const head = parts.length === 0 ? 'Nothing on today' : `Today: ${parts.join(', ')}`
  const tail = input.first === null ? '' : `, first ${input.first.what} at ${input.first.atLocal}`
  const warning = input.calendarUnreachable ? " I can't see your calendar right now." : ''
  return `${head}${tail}.${warning}`
}

/** The user turn: DATA ONLY. Every instruction lives in BRIEF_SYSTEM, where it is cacheable. */
function renderInput(input: BriefInput): string {
  if (input.slot === 'morning') {
    return [
      `This is the morning brief, about today. Timezone ${input.zone}.`,
      `Left in their day: ${input.counts.events} calendar event(s), ${input.counts.reminders} open ` +
        `reminder(s), ${input.counts.alarms} alarm(s) already set.`,
      input.first === null
        ? 'Next timed thing: none.'
        : `Next timed thing: ${input.first.what} at ${input.first.atLocal}.`,
      input.calendarUnreachable
        ? 'The calendar COULD NOT BE READ. This is not an empty calendar — it is no calendar.'
        : 'The calendar was read successfully.',
      'Everything counted above will reach them again on its own when it matters. Do not list it.',
    ].join('\n\n')
  }

  return [
    `This is the evening brief, about tomorrow. Timezone ${input.zone}.`,
    input.events.length > 0
      ? `Calendar (tomorrow):\n${input.events.map((e) => `- ${e.startLocal} ${e.summary}`).join('\n')}`
      : input.calendarUnreachable
        ? 'Calendar (tomorrow): COULD NOT BE READ. This is not an empty calendar — it is no calendar.'
        : 'Calendar (tomorrow): nothing.',
    input.reminders.length > 0
      ? `Open reminders:\n${input.reminders.map((r) => `- ${r.title} (${r.evidence})`).join('\n')}`
      : 'Open reminders: none.',
    input.alarms.length > 0
      ? `Alarms already set for tomorrow:\n${input.alarms.map((a) => `- ${a.firesAtLocal} ${a.label}`).join('\n')}`
      : 'Alarms already set for tomorrow: none.',
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
