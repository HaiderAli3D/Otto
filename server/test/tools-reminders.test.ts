import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { DateTime } from 'luxon'
import { runTool } from '../src/agent/tools.js'
import { ensureSchema } from '../src/db/client.js'
import { isNagPolicy, isTimingKind } from '../src/lib/nagLadder.js'
import { getReminder } from '../src/services/reminders.js'
import { makeDevice } from './helpers.js'

/**
 * `create_reminder` through the DISPATCH, asserting the row it wrote.
 *
 * The rest of the suite tests `createReminder` directly, and `tools-order.test.ts` tests the tool
 * SCHEMA as text. A defect lived comfortably between the two for a release: the dispatch answered
 * `timing` itself before `createReminder` was ever called, which made the service's own default
 * unreachable code, and every dated reminder the model did not classify was stored as the one kind
 * that says nothing until the moment has already gone. Nothing failed loudly — the tool result even
 * reported the wrong kind back, and was believed.
 *
 * So everything here asserts the stored ROW. That was the only place the truth was.
 */

beforeEach(() => ensureSchema())

let seq = 0
const nextDevice = () => makeDevice(`dev_tr${++seq}`)

const inHours = (h: number): number => Date.now() + h * 3_600_000

/** The wall-clock string the model actually sends: local to the device zone, no offset. */
const localIso = (ms: number, zone: string): string =>
  DateTime.fromMillis(ms, { zone }).toFormat("yyyy-MM-dd'T'HH:mm:ss")

type CreateResult = {
  reminderId: string
  timing: string
  nagPolicy: string
  dueLocal: string | null
  nextChasesLocal: string[]
}

const create = async (device: ReturnType<typeof makeDevice>, args: Record<string, unknown>) =>
  (await runTool(device, 'create_reminder', args)) as CreateResult

describe('create_reminder through runTool', () => {
  it('stores an omitted timing as a deadline, so the first word lands BEFORE the due time', async () => {
    // The regression. Two days out rather than hours: the suite runs at whatever the wall clock
    // says, and a run-up measured in hours can sit entirely inside the default 22:00-07:00 window,
    // where every lead rung is pruned for landing past its own deadline. Two days always leaves
    // one standing, whatever time of day the test runs at.
    const device = nextDevice()
    const res = await create(device, {
      title: 'file the tax return',
      dueLocalISO: localIso(inHours(48), device.timezone),
    })

    const row = getReminder(res.reminderId)!
    expect(row.timingKind).toBe('deadline')
    expect(row.dueAtMillis).not.toBeNull()
    expect(row.nextNagAtMillis).not.toBeNull()
    // The whole point: a warning is scheduled, and it is in the run-up rather than on the deadline.
    expect(row.nextNagAtMillis!).toBeLessThan(row.dueAtMillis!)
  })

  it('still stores a trigger when the model asks for one by name', async () => {
    // The kind stays reachable — "don't say a word until four" is a real thing to want. It is only
    // no longer what you get by saying nothing.
    const device = nextDevice()
    const res = await create(device, {
      title: 'mention the parcel',
      dueLocalISO: localIso(inHours(48), device.timezone),
      timing: 'trigger',
    })

    const row = getReminder(res.reminderId)!
    expect(row.timingKind).toBe('trigger')
    // Silent until the moment itself: the first rung IS the due instant, never earlier.
    expect(row.nextNagAtMillis).toBe(row.dueAtMillis)
  })

  it('reports the reminder it stored, not the arguments it was handed', async () => {
    // Both locals are `undefined` in the dispatch when the model says nothing, so reporting them
    // back verbatim would tell it nothing about the reminder it had just made. It is instructed to
    // confirm from what happened rather than from what was asked, which it can only do if the
    // result carries the answer.
    const device = nextDevice()
    const res = await create(device, {
      title: 'renew the passport',
      dueLocalISO: localIso(inHours(48), device.timezone),
    })

    const row = getReminder(res.reminderId)!
    expect(isTimingKind(res.timing)).toBe(true)
    expect(isNagPolicy(res.nagPolicy)).toBe(true)
    expect(res.timing).toBe(row.timingKind)
    expect(res.nagPolicy).toBe(row.nagPolicy)
    // And the schedule it quotes back is the one actually queued.
    expect(res.nextChasesLocal.length).toBeGreaterThan(0)
  })

  it('refuses to strip the due time off a repeating reminder', async () => {
    // create_reminder already refuses a recurrence with no due time, because `nextOccurrence` needs
    // an anchor to roll forward from. update_reminder had no such guard, so clearDue got round it —
    // and the next completion took the "nothing to roll to" branch and wrote DONE. The whole series
    // ended silently, and the tool result said completed:true with no next occurrence, so Otto
    // confirmed it cheerfully.
    const device = nextDevice()
    const res = await create(device, {
      title: 'take the bins out',
      dueLocalISO: localIso(inHours(24), device.timezone),
      recurrence: 'FREQ=WEEKLY',
    })

    const cleared = (await runTool(device, 'update_reminder', {
      reminderId: res.reminderId,
      clearDue: true,
    })) as { error?: string }

    expect(cleared.error).toMatch(/repeats/)
    const row = getReminder(res.reminderId)!
    expect(row.dueAtMillis).not.toBeNull()
    expect(row.recurrence).toBe('FREQ=WEEKLY')
  })

  it('lets the owner end the series and drop the date in one call', async () => {
    // The refusal above must not be a dead end: "there's no deadline on that any more" is a real
    // thing to want, and clearRecurrence is the answer.
    const device = nextDevice()
    const res = await create(device, {
      title: 'take the bins out',
      dueLocalISO: localIso(inHours(24), device.timezone),
      recurrence: 'FREQ=WEEKLY',
    })

    const cleared = (await runTool(device, 'update_reminder', {
      reminderId: res.reminderId,
      clearDue: true,
      clearRecurrence: true,
    })) as { error?: string }

    expect(cleared.error).toBeUndefined()
    const row = getReminder(res.reminderId)!
    expect(row.dueAtMillis).toBeNull()
    expect(row.recurrence).toBeNull()
    // And it is still chased, on the undated ladder.
    expect(row.nextNagAtMillis).not.toBeNull()
  })

  it('honours an explicit nagPolicy rather than overriding it', async () => {
    const device = nextDevice()
    const res = await create(device, {
      title: 'water the plants',
      dueLocalISO: localIso(inHours(48), device.timezone),
      nagPolicy: 'gentle',
    })

    expect(getReminder(res.reminderId)!.nagPolicy).toBe('gentle')
    expect(res.nagPolicy).toBe('gentle')
  })
})
