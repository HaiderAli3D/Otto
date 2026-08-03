import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

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
  'remember_fact',
  'recall_facts',
  'forget_fact',
  'list_calendar_events',
  'create_calendar_event',
  'create_task',
  'create_leave_by_alarm',
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

  it('is reachable through the legacy ../agent/tools.js path', () => {
    // tools.ts is now a re-export shim. If it stops re-exporting, agent/runner.ts stops working.
    expect(typeof buildTools).toBe('function')
    expect(typeof runTool).toBe('function')
  })

  it('has a dispatch case for every declared tool', () => {
    // Definitions and dispatch live in different files and nothing type-checks one against the
    // other, so a tool the model can see but nothing can run would only show up as a confused reply
    // in production. Read the switch rather than calling the tools: invoking all fifteen with junk
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
