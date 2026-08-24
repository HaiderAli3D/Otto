import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import {
  ACCOUNTABILITY,
  CALENDAR,
  JOURNEYS,
  PREFERENCES,
  REMINDER_LOOP,
  REMINDER_TIMING,
  REPLYING,
} from '../src/agent/promptSections.js'
import { buildTools, runTool } from '../src/agent/tools.js'
import { DEFAULT_NAG_POLICY } from '../src/lib/rungPlan.js'

/**
 * The tool block renders at position 0 of every request, ahead of the system blocks, so its exact
 * bytes are the head of the cached prefix. Any change to the set OR the order rewrites that prefix,
 * and every user pays full input price on their next turn.
 *
 * Hardcoded on purpose. It is the regression net for the split in src/agent/tools/: several feature
 * branches are adding tools in parallel, and this list is what turns "someone reshuffled the
 * spreads" or "someone made buildTools conditional" into a red test rather than a silent bill.
 * Appending a genuinely new tool means appending here too, deliberately, in the same commit.
 */
const EXPECTED = [
  'create_alarm',
  'cancel_alarm',
  'list_alarms',
  'create_reminder',
  'list_reminders',
  'complete_reminder',
  'snooze_reminder',
  'cancel_reminder',
  'reopen_reminder',
  // Kept with its siblings rather than bolted onto the end of the whole list. That shifts every
  // tool after it down the cached prefix, which costs one full-price turn per user at deploy — the
  // same one-off as editing promptSections.ts, and worth it to keep the reminder tools together.
  'update_reminder',
  'remember_fact',
  'recall_facts',
  'forget_fact',
  'list_calendar_events',
  'create_calendar_event',
  'create_task',
  'create_leave_by_alarm',
  'set_preferences',
  // Appended at the very end, which shifts nothing already in the cached prefix — the trade the
  // comment above `update_reminder` weighs, decided the other way because nothing is gained by
  // sitting this next to a sibling.
  'manage_places',
  // Appended after manage_places for the same reason it was appended: nothing already in the
  // cached prefix moves. Grouped together because all three are one feature.
  'add_note',
  'read_notes',
  'delete_note',
  'plan_journey',
  // Appended last for the same cached-prefix reason as manage_places and the note tools, rather
  // than sat beside the three Google tools it belongs with conceptually.
  'link_google',
  // Appended after link_google for the same cached-prefix reason it was appended: nothing already
  // in the prefix moves. The three are grouped because they are one feature — Otto changing a
  // calendar rather than only adding to it — rather than each sitting beside a sibling further up,
  // which would have shifted every tool after it and billed one full-price turn per user at deploy.
  'delete_calendar_event',
  'update_calendar_event',
  'plan_day',
]

describe('tool list is deterministic', () => {
  it('exposes exactly these tools in exactly this order', () => {
    expect(buildTools().map((t) => t.name)).toEqual(EXPECTED)
  })

  it('returns an identical list on every call', () => {
    // The other half of "never a conditional, never a parameter": two calls in the same process
    // must serialise identically, whatever the device or the environment.
    expect(JSON.stringify(buildTools())).toBe(JSON.stringify(buildTools()))
  })

  it('emits a well-formed function tool for every entry', () => {
    // The order and name assertions above both pass for a definition file still written against the
    // OLD provider's `input_schema` key — buildTools would just emit `parameters: undefined` and the
    // tool would be silently unusable at request time, with nothing failing until production.
    // This asserts the WIRE shape, which is the part nothing else in the suite can see.
    for (const tool of buildTools()) {
      expect(tool.type).toBe('function')
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.strict).toBe(false)
      expect((tool.parameters as { type?: string } | null)?.type).toBe('object')
    }
  })

  it('is reachable through the legacy ../agent/tools.js path', () => {
    // tools.ts is now a re-export shim. If it stops re-exporting, agent/runner.ts stops working.
    expect(typeof buildTools).toBe('function')
    expect(typeof runTool).toBe('function')
  })

  it('has a dispatch case for every declared tool', () => {
    // Definitions and dispatch live in different files and nothing type-checks one against the
    // other, so a tool the model can see but nothing can run would only show up as a confused reply
    // in production. Read the switch rather than calling the tools: invoking all twenty-seven with junk
    // input would arm alarms and write rows to prove a routing fact.
    const dispatch = readFileSync(new URL('../src/agent/tools/index.ts', import.meta.url), 'utf8')
    for (const name of EXPECTED) expect(dispatch).toContain(`case '${name}':`)
  })

  it('reports an unknown tool instead of throwing', async () => {
    // Reaches `default:` without touching a service — a hallucinated name must come back as a
    // tool_result the model can recover from, not an exception that kills the turn.
    const device = { deviceId: 'dev_unused', timezone: 'Europe/London' } as never
    expect(await runTool(device, 'no_such_tool', {})).toEqual({ error: 'unknown tool no_such_tool' })
  })
})

/**
 * Tool descriptions and prompt sections sit ~7,000 tokens apart in the SAME cached prefix, and the
 * model reads both. Two branches wrote them, and where they disagreed the tool block won the
 * argument in the worst places — the model reaches for the tool, reads its description, and
 * confirms the opposite of what the code does.
 */
describe('the cached prefix does not contradict itself', () => {
  const schemaOf = (tool: string): Record<string, { description?: string }> =>
    (((buildTools().find((t) => t.name === tool)!.parameters as { properties?: unknown })?.properties ??
      {}) as Record<string, { description?: string }>)

  it('does not claim quiet hours suppress everything proactive', () => {
    // The claim was "Nothing proactive goes out inside it." ACCOUNTABILITY names four things that
    // go through regardless, and the CODE agrees with ACCOUNTABILITY: `nagQuietHours` returns null
    // for an escalating reminder, `runNudge` exempts a due time the owner picked, and the
    // wake-check never touches the ladder at all. So "remind me to take my pills at 2am" IS chased
    // at 02:00, while the tool block had Otto promising to wait until 07:00 — about a medication
    // reminder, which is the worst thing in the system to be wrong about.
    const quietHours = schemaOf('set_preferences').quietHours!.description!
    expect(quietHours).not.toMatch(/nothing proactive/i)
    expect(quietHours).toMatch(/wake-check/i)
    expect(quietHours).toMatch(/alarm/i)
    expect(ACCOUNTABILITY).toContain('Four things go through regardless')
  })

  it('no longer tells the owner to go and delete their own calendar entries', () => {
    // JOURNEYS predates the editing tools and said a duplicate was something "they have to delete
    // themselves", and that the calendar entry was "theirs to delete". Both were true when written
    // and are now false. A prompt that talks the owner into doing by hand what Otto can do in one
    // call is the most expensive kind of stale line, because nothing ever errors and nobody ever
    // finds out — it just quietly stays useless.
    expect(JOURNEYS).not.toMatch(/theirs to delete/i)
    expect(JOURNEYS).not.toMatch(/delete that themselves/i)
    expect(JOURNEYS).toContain('delete_calendar_event')
  })

  it('settles the argument REPLYING would otherwise win about a clear cancellation', () => {
    // REPLYING ends the whole prompt with "Still ask before anything destructive", and it is read
    // LAST. Deleting a calendar event is destructive and irreversible, so on recency alone the model
    // would ask "shall I cancel it?" on every single "cancel my 3pm" — which is exactly the
    // behaviour this feature exists to remove. The exception has to be stated in words the model
    // cannot read past, and this pins that it still is.
    // Matched loosely because the section is hard-wrapped: the sentence spans two lines.
    expect(REPLYING).toMatch(/Still ask before anything\s+destructive/)
    expect(CALENDAR).toContain('Do not ask permission first.')
    expect(CALENDAR).toMatch(/one exception to\s+asking before something destructive/)
  })

  it('states the never-pick rule in the tool block as well as the prompt', () => {
    // The two halves sit ~7,000 tokens apart in the same cached prefix and the model reads both. If
    // they disagree about whether to ask, the tool description wins at the moment of acting — which
    // is the worst possible moment for it to be the half that says "pick one".
    const desc = buildTools().find((t) => t.name === 'delete_calendar_event')!.description
    expect(desc).toMatch(/ambiguous/i)
    expect(desc).toMatch(/never pick/i)
    expect(CALENDAR).toContain('Never pick.')
  })

  it('never lets a half-written day be described as a planned one', () => {
    // plan_day's result has no truthy success field while anything was skipped or failed, and this
    // is the prose half of that guarantee. Together they are what stops "4 of 6 landed" being
    // reported as "all sorted".
    const desc = buildTools().find((t) => t.name === 'plan_day')!.description
    expect(desc).toMatch(/allWritten comes back false/)
    expect(desc).toMatch(/none of these blocks ring/i)
    expect(CALENDAR).toContain('do\n  not describe the day as planned')
  })

  it('does not promise proactive leave-by arming that nothing implements', () => {
    // `mayArm`'s autoLeaveByAlarm branch is unreachable: the only caller of `planLeaveBy` is the
    // tool, which hard-codes `explicit: true`, and DEVICE_SEEDERS has no leave-by producer. "Just
    // set my leave-by alarms automatically, I trust you" got a confident yes and then nothing,
    // forever, with no error and no log line. Until something plans journeys on its own, neither
    // the tool nor the prompt may say otherwise.
    const autoLeaveBy = schemaOf('set_preferences').autoLeaveByAlarm!.description!
    expect(autoLeaveBy).toMatch(/nothing currently plans journeys on its own/i)
    expect(PREFERENCES).toContain('You never plan a journey they did not ask you to plan.')
    expect(PREFERENCES).not.toContain('whether you arm wake-up\n  and leave-by alarms on your own')
  })

  it('settles which of quiet hours and the calendar wins, in the one section that states both', () => {
    // ACCOUNTABILITY promises four exemptions from quiet hours, and pins the promise so precisely
    // that the case above asserts the exact sentence. The commitment rule takes all four back, and
    // it sits in the SAME const forty lines further down — so without this the cached prefix would
    // carry two exception lists that flatly disagree, which is the failure this whole suite exists
    // for. Named the way # Wake-checks names its own override, rather than left to be inferred.
    expect(ACCOUNTABILITY).toContain('# When they are booked')
    expect(ACCOUNTABILITY).toMatch(/All four are about the CLOCK/)
    expect(ACCOUNTABILITY).toMatch(/one exception to "four things go through\s+regardless"/)
    // The code drops these rows; it does not hold them. A prompt that promises a backlog would have
    // Otto apologising for messages that no longer exist.
    expect(ACCOUNTABILITY).toMatch(/DROPPED, not saved up/)
    expect(ACCOUNTABILITY).toMatch(/never tell them you queued something/i)
    // The way back, and the one tool that does it. `reopen_reminder` is real — pinned above.
    expect(ACCOUNTABILITY).toContain('reopen_reminder')
  })

  it('does not offer to switch off a rule that has no switch', () => {
    // Same class as the autoLeaveByAlarm case above. PREFERENCES teaches the model that
    // set_preferences is what changes "when you must stay silent", so "message me during meetings,
    // I don't mind" would get a confident yes and then nothing, forever — the commitment gate is in
    // code with no setting behind it.
    expect(ACCOUNTABILITY).toMatch(/This is not a setting\. set_preferences cannot turn it off/)
    expect(Object.keys(schemaOf('set_preferences'))).not.toContain('commitments')
  })

  it('agrees with the tool block about what an unexplained due time means', () => {
    // `create_reminder`'s description and REMINDER_TIMING sit ~7,000 tokens apart in the same cached
    // prefix, and the model reads both. `trigger` has no lead rungs at any intensity, so while it
    // was the default an unclassified "by four" said nothing until four had gone. The default now
    // lives in createReminder, and BOTH halves of the prefix have to say so or the model will keep
    // passing the old one by hand.
    const timing = schemaOf('create_reminder').timing!.description!
    expect(timing).not.toMatch(/Defaults to trigger\./)
    expect(timing).toMatch(/Defaults to deadline whenever dueLocalISO is given/)
    expect(REMINDER_TIMING).toMatch(/A time with no shape stated is a DEADLINE/)
  })

  it('will not let Otto reach for the silent kind on its own', () => {
    // `trigger` says nothing before the moment, which is the exact complaint this whole change
    // answers. It stays reachable — "don't say a word until four" is a real thing to want — but the
    // tool block used to present it as one of three equal options, described in the same neutral
    // voice as the other two, next to the example "remind me at 4". So the model picked it for the
    // most common phrasing there is.
    const timing = schemaOf('create_reminder').timing!.description!
    expect(timing).toMatch(/never the tidy choice and never the safe one/)
    expect(timing).toMatch(/"remind me at 4"/)
    expect(REMINDER_TIMING).toMatch(/trigger is the one you never reach for/)
    expect(REMINDER_TIMING).toMatch(/"Remind me at four" is a deadline too/)
  })

  it('does not offer a reminder that is written down and never mentioned again', () => {
    // dueLocalISO used to invite omission in as many words — "an undated 'someday' reminder that
    // only appears in lists and digests" — and that was an accurate description of the code, which
    // scheduled nothing at all for one. Both halves changed together.
    const due = schemaOf('create_reminder').dueLocalISO!.description!
    expect(due).not.toMatch(/only appears in lists and digests/)
    expect(due).toMatch(/Work one out even when they did not give you a time/)
    expect(schemaOf('update_reminder').clearDue!.description!).toMatch(/still\s+chase an undated reminder/)
    expect(REMINDER_TIMING).toMatch(/No time at all is still a reminder you chase/)
  })

  it('states one default intensity, in the code and in both halves of the prefix', () => {
    // Interpolated rather than written out, which is the whole point: the constant is the only
    // place `hard` is decided, so prose that disagrees with it cannot compile past this line. The
    // previous default was stated in four places — two of them code — and when one moved the other
    // three quietly went on lying to the model.
    const nagPolicy = schemaOf('create_reminder').nagPolicy!.description!
    expect(nagPolicy).toContain(`${DEFAULT_NAG_POLICY} (default)`)
    expect(REMINDER_LOOP).toContain(`Default to ${DEFAULT_NAG_POLICY}.`)
    // And exactly one intensity claims it.
    expect(nagPolicy.match(/\(default\)/g)).toHaveLength(1)
  })
})
