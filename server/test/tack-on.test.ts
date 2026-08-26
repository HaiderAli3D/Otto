import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

// Partial mock, matching test/nagging.test.ts: signature verification and the inbound parser have
// to stay real or importing the app graph falls over.
const sends = vi.hoisted(() => [] as Array<{ to: string; body: string }>)
vi.mock('../src/services/whatsapp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/whatsapp.js')>()
  return {
    ...actual,
    sendText: vi.fn(async (to: string, body: string) => {
      sends.push({ to, body })
      return { ok: true as const }
    }),
  }
})

import { and, eq } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { __setModelClient } from '../src/agent/llm.js'
import { systemPrompt } from '../src/agent/prompt.js'
import { runAgentTurn } from '../src/agent/runner.js'
import { db, ensureSchema } from '../src/db/client.js'
import { jobs, reminders } from '../src/db/schema.js'
import { getDevice, linkWhatsapp, markInbound, setTimezone, type Device } from '../src/services/devices.js'
import { enqueueOutbound, nudgeHistory } from '../src/services/outbox.js'
import { createReminder, getReminder, leadCountFor } from '../src/services/reminders.js'
import { updateSettings } from '../src/services/settings.js'
import { reminderEvidence } from '../src/services/signals.js'
import { TACK_ON_COOLDOWN_MS, TACK_ON_HORIZON_MS, chaseInReply, tackOnCandidate } from '../src/services/tackOn.js'
import { fakeModel, fnCall, say } from './fakeModel.js'
import { makeDevice } from './helpers.js'

/**
 * Folding ONE pending chase into a reply the owner already opened, instead of interrupting them
 * with it separately later.
 *
 * ANTI-FLAKE: every test here pins `quietHours` explicitly rather than inheriting
 * `config.quietHoursDefault` ('22:00-07:00'). This suite runs at whatever the wall clock happens to
 * be, that window is true for a third of the day, and the candidate predicate has a quiet-hours
 * clause — so without pinning, half these tests would pass by day and fail by night. Precedent:
 * the note at the top of nagging.test.ts, and two commits in this repo that had to go back and fix
 * exactly this.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

beforeEach(() => {
  ensureSchema()
  sends.length = 0
  __setModelClient(null)
})

/** A device reachable over WhatsApp, on a number of its own — see the note in nagging-guards. */
function reachableDevice(deviceId: string): Device {
  const waNumber = `4477009${String(Math.abs(hash(deviceId)) % 100000).padStart(5, '0')}`
  makeDevice(deviceId)
  linkWhatsapp(deviceId, waNumber)
  markInbound(deviceId)
  updateSettings(deviceId, { quietHours: 'off' })
  return getDevice(deviceId)!
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/**
 * Put a reminder in the state the candidate predicate is actually asking about.
 *
 * Written straight to the row rather than through the ladder: this suite is about the SELECTION
 * rules, and driving the ladder to produce each shape would make every test depend on the rung
 * tables as well.
 */
function setRow(reminderId: string, patch: Partial<typeof reminders.$inferSelect>): void {
  db.update(reminders).set(patch).where(eq(reminders.reminderId, reminderId)).run()
}

function pendingNudgeJobs(reminderId: string) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, 'nudge'), eq(jobs.reminderId, reminderId)))
    .all()
}

describe('choosing the one thing worth tacking on', () => {
  it('has nothing to say when nothing is open', () => {
    expect(tackOnCandidate(reachableDevice('dev_t1'))).toBeNull()
  })

  it('takes a rung inside the horizon and leaves one beyond it', async () => {
    const device = reachableDevice('dev_t2')
    const now = Date.now()
    const r = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    setRow(r.reminderId, { nagCount: 1, lastNaggedAtMillis: null })

    setRow(r.reminderId, { nextNagAtMillis: now + TACK_ON_HORIZON_MS - MINUTE })
    expect(tackOnCandidate(device, now)?.reminder.reminderId).toBe(r.reminderId)

    setRow(r.reminderId, { nextNagAtMillis: now + TACK_ON_HORIZON_MS + MINUTE })
    expect(tackOnCandidate(device, now)).toBeNull()
  })

  it('is never the first thing Otto says about a reminder', async () => {
    // The first word belongs on the ladder the owner's `timing` implied. Pre-empting rung 0 changes
    // when they first hear about it, which is the one thing `timing` exists to decide — and it is
    // also what stops "the reminder they created ninety seconds ago" being tacked on, with no age
    // constant to tune.
    const device = reachableDevice('dev_t3')
    const now = Date.now()
    const r = await createReminder(device, { title: 'the report', dueAtMillis: now + 3 * HOUR })
    setRow(r.reminderId, { nagCount: 0, lastNaggedAtMillis: null, nextNagAtMillis: now + HOUR })

    expect(tackOnCandidate(device, now)).toBeNull()

    // Once Otto HAS spoken about it, it becomes eligible.
    setRow(r.reminderId, { nagCount: 1 })
    expect(tackOnCandidate(device, now)?.reminder.reminderId).toBe(r.reminderId)
  })

  it('takes an overdue reminder even before Otto has said anything about it', async () => {
    // The other half of the same clause: something already late is fair game on its own, because
    // the moment `timing` was protecting has passed.
    const device = reachableDevice('dev_t4')
    const now = Date.now()
    const r = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    setRow(r.reminderId, { nagCount: 0, lastNaggedAtMillis: null, nextNagAtMillis: now + HOUR })

    expect(tackOnCandidate(device, now)?.reminder.reminderId).toBe(r.reminderId)
  })

  it('has nothing to replace when the ladder is spent', async () => {
    // No rung means no message to pre-empt, so raising it would be pure addition — the one thing
    // this feature must never do.
    const device = reachableDevice('dev_t5')
    const now = Date.now()
    const r = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    setRow(r.reminderId, { nagCount: 3, lastNaggedAtMillis: null, nextNagAtMillis: null })

    expect(tackOnCandidate(device, now)).toBeNull()
  })

  it('prefers something overdue to a warning that happens to be sooner', async () => {
    // A chase is the message the owner minds most and the one answerable in a word. A warning is
    // cheap and can wait for its own rung.
    const device = reachableDevice('dev_t6')
    const now = Date.now()
    const late = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    const soon = await createReminder(device, { title: 'the dentist', dueAtMillis: now + 4 * HOUR })
    setRow(late.reminderId, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + 2 * HOUR })
    setRow(soon.reminderId, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + MINUTE })

    expect(tackOnCandidate(device, now)?.reminder.reminderId).toBe(late.reminderId)
  })

  it('takes the soonest rung among two that are equally overdue', async () => {
    const device = reachableDevice('dev_t7')
    const now = Date.now()
    const a = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    const b = await createReminder(device, { title: 'the bins', dueAtMillis: now - HOUR })
    setRow(a.reminderId, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + 2 * HOUR })
    setRow(b.reminderId, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + MINUTE })

    expect(tackOnCandidate(device, now)?.reminder.reminderId).toBe(b.reminderId)
  })

  describe('the cooldown', () => {
    it('stays quiet either side of the boundary', async () => {
      const device = reachableDevice('dev_t8')
      const now = Date.now()
      const r = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
      setRow(r.reminderId, { nagCount: 1, nextNagAtMillis: now + HOUR })

      setRow(r.reminderId, { lastNaggedAtMillis: now - TACK_ON_COOLDOWN_MS + MINUTE })
      expect(tackOnCandidate(device, now)).toBeNull()

      setRow(r.reminderId, { lastNaggedAtMillis: now - TACK_ON_COOLDOWN_MS - MINUTE })
      expect(tackOnCandidate(device, now)?.reminder.reminderId).toBe(r.reminderId)
    })

    it('applies ACROSS reminders — a nudge about A silences a tack-on about B', async () => {
      // The honest question is "has Otto raised anything at them recently", not "has it raised THIS".
      // A chase about the bins twenty minutes ago is exactly when the owner is replying to that
      // chase, and asking them about the report in the same breath is the pile-on this avoids.
      const device = reachableDevice('dev_t9')
      const now = Date.now()
      const a = await createReminder(device, { title: 'the bins', dueAtMillis: now - HOUR })
      const b = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
      setRow(a.reminderId, { nagCount: 1, lastNaggedAtMillis: now - 20 * MINUTE, nextNagAtMillis: now + 5 * HOUR })
      setRow(b.reminderId, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + HOUR })

      expect(tackOnCandidate(device, now)).toBeNull()
    })
  })

  describe('quiet hours', () => {
    /**
     * A device pinned to UTC with a real 22:00-07:00 window, and an explicit `nowMillis` INSIDE it.
     *
     * Both instants are fixed ISO strings rather than offsets from `Date.now()`: the predicate under
     * test asks whether `now` is inside the window and whether the rung is outside it, so a relative
     * setup would answer differently depending on the hour the suite ran at.
     */
    async function atNight(deviceId: string) {
      const device = reachableDevice(deviceId)
      setTimezone(device.deviceId, 'UTC')
      updateSettings(device.deviceId, { quietHours: '22:00-07:00' })
      const fresh = getDevice(device.deviceId)!
      const now = DateTime.fromISO('2026-08-03T23:00:00', { zone: 'UTC' }).toMillis()
      const r = await createReminder(fresh, { title: 'the report', dueAtMillis: now - HOUR })
      setRow(r.reminderId, { nagCount: 1, lastNaggedAtMillis: null })
      return { device: fresh, reminderId: r.reminderId, now }
    }

    it('skips a rung the window has already moved out of reach', async () => {
      // Saying it now cannot REPLACE that message: `nextNagAt` would defer the new rung straight
      // back to the same window edge, so the owner would get one extra touch rather than one fewer.
      const { device, reminderId, now } = await atNight('dev_t10')
      // 09:00 the next morning: past the 07:00 edge, so this rung has already been parked outside.
      setRow(reminderId, {
        nextNagAtMillis: DateTime.fromISO('2026-08-04T09:00:00', { zone: 'UTC' }).toMillis(),
      })

      expect(tackOnCandidate(device, now)).toBeNull()
    })

    it('does not blanket-suppress — replying is never held back', async () => {
      // The complement, and the reason the guard is narrow rather than "stay quiet at night". This
      // owner wakes at noon, so their window covers a third of the clock; switching the feature off
      // inside it would switch it off for most of the hours they are awake.
      const { device, reminderId, now } = await atNight('dev_t11')
      // 23:30, still inside the window: nothing has been moved out of reach, so this is replaceable.
      setRow(reminderId, {
        nextNagAtMillis: DateTime.fromISO('2026-08-03T23:30:00', { zone: 'UTC' }).toMillis(),
      })

      expect(tackOnCandidate(device, now)?.reminder.reminderId).toBe(reminderId)
    })
  })

  it('hands back the same evidence line the chase-list and the nudge writer use', async () => {
    // Three surfaces, one sentence. If they could drift, Otto would say "chased 4×" in a tack-on
    // and "warned 4× beforehand" about the same reminder a moment later.
    const device = reachableDevice('dev_t12')
    const now = Date.now()
    const r = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    setRow(r.reminderId, { nagCount: 2, lastNaggedAtMillis: null, nextNagAtMillis: now + HOUR })

    const candidate = tackOnCandidate(device, now)!
    const row = getReminder(r.reminderId)!
    expect(candidate.evidence).toBe(reminderEvidence(row, device.timezone, now, leadCountFor(device, row)))
  })
})

describe('what the model is told', () => {
  it('names the candidate and says what it would otherwise cost', async () => {
    const device = reachableDevice('dev_t13')
    const now = Date.now()
    const r = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    setRow(r.reminderId, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + HOUR })

    const prompt = systemPrompt(device)
    expect(prompt).toContain('One thing you may tack on:')
    expect(prompt).toContain(r.reminderId)
    expect(prompt).not.toContain('Nothing to tack on this turn')
  })

  it('says so explicitly when there is nothing, rather than staying silent', () => {
    // An omission is indistinguishable from a switched-off feature, and a model that cannot tell
    // the difference starts inventing candidates out of the chase-list directly above it.
    const device = reachableDevice('dev_t14')
    expect(systemPrompt(device)).toContain('Nothing to tack on this turn')
  })

  it('keeps the per-turn values in the volatile tail, after the frozen rules', async () => {
    // Anything per-device in front of the cache breakpoint re-bills the whole prefix, tools and all.
    const device = reachableDevice('dev_t15')
    const now = Date.now()
    const r = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    setRow(r.reminderId, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + HOUR })

    const prompt = systemPrompt(device)
    expect(prompt.indexOf('One thing you may tack on:')).toBeGreaterThan(prompt.indexOf('# Writing'))
  })
})

describe('chase_in_reply', () => {
  /** An eligible reminder plus the device it belongs to, ready to be tacked on. */
  async function ready(deviceId: string) {
    const device = reachableDevice(deviceId)
    const now = Date.now()
    const r = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    setRow(r.reminderId, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + HOUR })
    return { device, reminderId: r.reminderId, now }
  }

  it('advances the ladder, cancels the pending job, and leaves exactly one in its place', async () => {
    const { device, reminderId } = await ready('dev_t16')
    const { client } = fakeModel([
      { output: [fnCall('chase_in_reply', { reminderId }, 'c1')] },
      { output: [say('Added. btw did you finish the report?')] },
    ])
    __setModelClient(client)

    const reply = await runAgentTurn({
      waUserId: device.whatsappNumber!,
      device,
      content: 'add take out the trash tonight',
    })

    // The reply is EXACTLY what the model wrote. Nothing is appended by code — the weaving is the
    // whole feature, and a templated addendum would be two voices in one message.
    expect(reply).toBe('Added. btw did you finish the report?')

    const after = getReminder(reminderId)!
    expect(after.nagCount).toBe(2)
    expect(after.lastNaggedAtMillis).not.toBeNull()
    expect(after.nextNagAtMillis).not.toBeNull()

    // The real assertion: the chase was MOVED, not duplicated. One job row, at the new rung.
    const queued = pendingNudgeJobs(reminderId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.runAtMillis).toBe(after.nextNagAtMillis)
  })

  it('gives the model the evidence to word the question with', async () => {
    const { device, reminderId } = await ready('dev_t17')
    const { client, requests } = fakeModel([
      { output: [fnCall('chase_in_reply', { reminderId }, 'c1')] },
      { output: [say('Done.')] },
    ])
    __setModelClient(client)

    await runAgentTurn({ waUserId: device.whatsappNumber!, device, content: 'hello' })

    const items = requests[1]!.input as Array<{ type?: string; output?: string }>
    const result = items.find((i) => i.type === 'function_call_output')!
    const parsed = JSON.parse(result.output!) as Record<string, unknown>
    expect(parsed.timesRaised).toBe(2)
    expect(parsed.overdue).toBe(true)
    expect(parsed.evidence).toContain('OVERDUE')
    expect(parsed.replacedChaseAtLocal).toBeTruthy()
    // The warning that the tool result carries as well as the prompt and the tool description.
    expect(parsed.reminder).toContain('only reaches them if you actually say it')
  })

  it('leaves a nudge that is already queued alone rather than dropping it', async () => {
    // This used to call `supersedePending`, so that a reply saying the thing REPLACED a message
    // waiting to say it. The trouble is the ordering: the rung is spent, and the queued row dropped,
    // before the reply exists — and nothing verifies the model then actually mentions it. A turn
    // that called the tool and wrote a reply without the tack-on left the owner with no message at
    // all, the rung burned, and `nagCount` claiming they had been asked.
    //
    // Dropping a message that is already written and waiting is the one irreversible half of this
    // operation, and it is not worth what it buys: a queued nudge saying the same thing is a
    // repetition, which the owner can shrug off; silence about something they asked to be chased on
    // is the failure this whole feature exists to prevent.
    const { device, reminderId } = await ready('dev_t18')
    enqueueOutbound({
      waUserId: device.whatsappNumber!,
      deviceId: device.deviceId,
      kind: 'nudge',
      body: 'the report is still open',
      reminderId,
      dedupeKey: `nag:${reminderId}:0`,
    })
    expect(nudgeHistory(reminderId, 10)).toHaveLength(1)

    const { client } = fakeModel([
      { output: [fnCall('chase_in_reply', { reminderId }, 'c1')] },
      { output: [say('btw, the report?')] },
    ])
    __setModelClient(client)
    await runAgentTurn({ waUserId: device.whatsappNumber!, device, content: 'hello' })

    expect(nudgeHistory(reminderId, 10)).toHaveLength(1)
  })

  it('refuses a reminder that is not this turn\'s tack-on', async () => {
    // Every clause in `tackOnCandidate` removes a case where tacking on would ADD a message rather
    // than move one, and none of it was enforced here — the tool took any open reminder id and
    // spent its rung, so all of it rested on the model picking the id it had been given three
    // thousand tokens earlier.
    // A device id of its own: this file shares one database across the whole suite, and
    // `reachableDevice` derives the WhatsApp number from the id, so reusing one leaks reminders
    // into the next test's candidate set.
    const { device, reminderId } = await ready('dev_t19b')
    const other = await createReminder(device, {
      title: 'something else entirely',
      dueAtMillis: Date.now() + 30 * 60_000,
    })

    const res = chaseInReply(device, other.reminderId)

    expect('error' in res).toBe(true)
    expect((res as { error: string }).error).toContain("not this turn's tack-on")
    // Neither ladder moved: not the one it refused, and not the one it was actually offered.
    expect(getReminder(other.reminderId)!.nagCount).toBe(0)
    expect(getReminder(reminderId)!.nagCount).toBe(1)
  })

  it('refuses a second call in the same reply, and moves only one reminder', async () => {
    const device = reachableDevice('dev_t19')
    const now = Date.now()
    const a = await createReminder(device, { title: 'the report', dueAtMillis: now - HOUR })
    const b = await createReminder(device, { title: 'the bins', dueAtMillis: now - HOUR })
    for (const id of [a.reminderId, b.reminderId]) {
      setRow(id, { nagCount: 1, lastNaggedAtMillis: null, nextNagAtMillis: now + HOUR })
    }

    const { client, requests } = fakeModel([
      {
        output: [
          fnCall('chase_in_reply', { reminderId: a.reminderId }, 'c1'),
          fnCall('chase_in_reply', { reminderId: b.reminderId }, 'c2'),
        ],
      },
      { output: [say('Added. btw the report?')] },
    ])
    __setModelClient(client)

    await runAgentTurn({ waUserId: device.whatsappNumber!, device, content: 'hello' })

    expect(getReminder(a.reminderId)!.nagCount).toBe(2)
    expect(getReminder(b.reminderId)!.nagCount).toBe(1)

    const items = requests[1]!.input as Array<{ type?: string; call_id?: string; output?: string }>
    const second = items.find((i) => i.type === 'function_call_output' && i.call_id === 'c2')!
    expect(JSON.parse(second.output!).error).toContain('one per reply')
  })

  describe('refusals write nothing', () => {
    it('refuses an id that is not an open reminder on this device', async () => {
      const { device } = await ready('dev_t20')
      const { client, requests } = fakeModel([
        { output: [fnCall('chase_in_reply', { reminderId: 'rem_nope' }, 'c1')] },
        { output: [say('ok')] },
      ])
      __setModelClient(client)
      await runAgentTurn({ waUserId: device.whatsappNumber!, device, content: 'hello' })

      const items = requests[1]!.input as Array<{ type?: string; output?: string }>
      const out = items.find((i) => i.type === 'function_call_output')!
      expect(JSON.parse(out.output!).error).toContain('list_reminders')
    })

    it('refuses when nothing is scheduled, and leaves the count alone', async () => {
      const device = reachableDevice('dev_t21')
      const r = await createReminder(device, { title: 'the report', dueAtMillis: Date.now() - HOUR })
      setRow(r.reminderId, { nagCount: 3, lastNaggedAtMillis: null, nextNagAtMillis: null })

      const { client, requests } = fakeModel([
        { output: [fnCall('chase_in_reply', { reminderId: r.reminderId }, 'c1')] },
        { output: [say('ok')] },
      ])
      __setModelClient(client)
      await runAgentTurn({ waUserId: device.whatsappNumber!, device, content: 'hello' })

      const items = requests[1]!.input as Array<{ type?: string; output?: string }>
      const out = items.find((i) => i.type === 'function_call_output')!
      expect(JSON.parse(out.output!).error).toContain('nothing is scheduled')
      expect(getReminder(r.reminderId)!.nagCount).toBe(3)
    })
  })

  it('leaves the no-API-key path completely alone', async () => {
    // setup-env.ts sets no OPENAI_API_KEY, so this is the 3am path and the one every degraded
    // morning takes. The whole feature is model-gated and must not touch a single row without one.
    const { device, reminderId } = await ready('dev_t22')
    __setModelClient(null)

    await runAgentTurn({ waUserId: device.whatsappNumber!, device, content: 'hello' })

    expect(getReminder(reminderId)!.nagCount).toBe(1)
  })
})
