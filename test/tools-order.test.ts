import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { ACCOUNTABILITY, PREFERENCES } from '../src/agent/promptSections.js'
import { buildTools, runTool } from '../src/agent/tools.js'

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
    // in production. Read the switch rather than calling the tools: invoking all eighteen with junk
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
})
