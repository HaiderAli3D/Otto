import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above the file body, so every mock fn must be created inside vi.hoisted.
const { sendMock, hasGoogleMock, listEventsMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  hasGoogleMock: vi.fn((): boolean => false),
  // `tryListCalendarEvents`, not `listCalendarEvents`: the wrapper IS what the brief must call — it
  // is the only thing that queues the "your Google access has been revoked" warning — and it
  // answers `null` for an unreachable calendar rather than throwing.
  listEventsMock: vi.fn(async (): Promise<Array<{ summary: string; startIso: string; endIso: string }> | null> => []),
}))
vi.mock('../src/fcm/sender.js', () => ({ sendData: vi.fn(async () => ({ ok: true as const })) }))
vi.mock('../src/services/whatsapp.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, sendText: sendMock }
})
// Partial mock: the brief must be testable both with a working calendar and with a revoked grant,
// and the test environment has no Google credentials at all.
vi.mock('../src/services/google.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, hasGoogle: hasGoogleMock, tryListCalendarEvents: listEventsMock }
})

import { and, asc, eq } from 'drizzle-orm'
import { briefFallback } from '../src/agent/brief.js'
import { config } from '../src/config.js'
import { MIN_RUNG_GAP_MS } from '../src/lib/nagLadder.js'
import { db, ensureSchema } from '../src/db/client.js'
import { jobs, outbox, reminders } from '../src/db/schema.js'
import { runJob } from '../src/scheduler/loop.js'
import { armAlarm } from '../src/services/alarms.js'
import { collectBrief, runBrief } from '../src/services/brief.js'
import { getDevice, linkWhatsapp, markInbound, type Device } from '../src/services/devices.js'
import { maybeCollapseBacklog } from '../src/services/digest.js'
import { seedBrief } from '../src/services/handlers/brief.js'
import { enqueueJob } from '../src/services/jobs.js'
import { enqueueOutbound, flushOutbox, pendingFor } from '../src/services/outbox.js'
import { createReminder, getReminder } from '../src/services/reminders.js'
import { getSettings, updateSettings } from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

const HOUR = 3_600_000

/** Monday 3 August 2026, 07:00 — the default morning boundary. Devices are UTC in tests. */
const NOW = Date.UTC(2026, 7, 3, 7, 0, 0)

beforeEach(() => {
  ensureSchema()
  // The dedupe key is `brief:<local date>:<slot>` and the unique index behind it spans the whole
  // table, so without this every test after the first would have its row silently rejected as a
  // duplicate of another test's. Same reason scheduler.test.ts clears `jobs`.
  db.delete(outbox).run()
  db.delete(jobs).run()
  // ONLY Date is faked. Faking timers wholesale would replace the microtask plumbing that every
  // `await` in this file depends on; all these tests need is a clock that does not move under them.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  sendMock.mockReset()
  sendMock.mockResolvedValue({ ok: true })
  hasGoogleMock.mockReset()
  hasGoogleMock.mockReturnValue(false)
  listEventsMock.mockReset()
  listEventsMock.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

/** A paired device with a WhatsApp number, which is the minimum for a brief to have a recipient. */
function owner(deviceId: string, waUserId: string): Device {
  makeDevice(deviceId)
  linkWhatsapp(deviceId, waUserId)
  const device = getDevice(deviceId)
  if (!device) throw new Error('device row missing')
  return device
}

const briefRows = (waUserId: string) => pendingFor(waUserId).filter((r) => r.kind === 'brief')

const briefJobs = (deviceId: string) =>
  db.select().from(jobs).where(and(eq(jobs.kind, 'brief'), eq(jobs.deviceId, deviceId))).all()

const TOMORROW_0700 = Date.UTC(2026, 7, 4, 7, 0, 0)

describe('the model is never reached in tests', () => {
  it('has no API key configured — the precondition for every byte-for-byte assertion below', () => {
    expect(config.openai).toBeNull()
  })
})

describe('silence', () => {
  it('says nothing at all when there are no events, no reminders and no alarms', async () => {
    // The single most important behaviour in the feature. A proactive message with nothing in it is
    // how a brief gets muted in week one, and there is no undo for that.
    const device = owner('dev_b1', '447700900001')
    markInbound(device.deviceId)

    expect(await runBrief(device, NOW)).toBe(false)
    expect(await collectBrief(device, 'morning', NOW)).toBeNull()
    expect(pendingFor('447700900001')).toHaveLength(0)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('says nothing when the slot is switched off', async () => {
    const device = owner('dev_b2', '447700900002')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })
    updateSettings(device.deviceId, { briefEnabled: false })

    expect(await runBrief(device, NOW)).toBe(false)
    expect(pendingFor('447700900002')).toHaveLength(0)
  })

  it('says nothing when no WhatsApp number is linked', async () => {
    const device = makeDevice('dev_b3')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    expect(device.whatsappNumber).toBeNull()
    expect(await runBrief(device, NOW)).toBe(false)
  })

  it('refuses to deliver a run that is more than 3h stale', async () => {
    // The machine was down. A 07:00 brief arriving at 14:00 describes a morning that already
    // happened — same reasoning as STALE_NUDGE_MS in nagging.ts.
    const device = owner('dev_b4', '447700900004')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    vi.setSystemTime(NOW + 7 * HOUR)
    expect(await runBrief(device, NOW)).toBe(false)
    expect(pendingFor('447700900004')).toHaveLength(0)

    // …and the same run three hours late is still delivered.
    vi.setSystemTime(NOW + 2 * HOUR)
    expect(await runBrief(device, NOW)).toBe(true)
  })
})

describe('delivery', () => {
  it('queues exactly one PENDING brief for a single overdue reminder', async () => {
    const device = owner('dev_b5', '447700900005')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    expect(await runBrief(device, NOW)).toBe(true)

    const rows = briefRows('447700900005')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dedupeKey).toBe('brief:2026-08-03:morning')
  })

  it('does not send a second brief the same local day', async () => {
    // Guard two of three: lastBriefAt + sameLocalDay. The singleton job row and the outbox dedupe
    // index are the other two, and any one of them failing must not reach the owner.
    const device = owner('dev_b6', '447700900006')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    expect(await runBrief(device, NOW)).toBe(true)
    expect(getSettings(device.deviceId).lastBriefAt).toBe(NOW)

    vi.setSystemTime(NOW + HOUR)
    expect(await runBrief(device, NOW)).toBe(false)
    expect(briefRows('447700900006')).toHaveLength(1)
  })

  it('keeps the evening marker separate from the morning one', async () => {
    const device = owner('dev_b7', '447700900007')
    updateSettings(device.deviceId, { eveningBriefEnabled: true })
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    expect(await runBrief(device, NOW)).toBe(true)

    // 21:00 the same day is the evening slot: a different brief about a different day.
    const evening = Date.UTC(2026, 7, 3, 21, 0, 0)
    vi.setSystemTime(evening)
    expect(await runBrief(device, evening)).toBe(true)

    // Every state, not just PENDING: with the window open these are DELIVERED rather than queued,
    // and the question here is which keys were written, not what is still waiting.
    const rows = db
      .select()
      .from(outbox)
      .where(and(eq(outbox.waUserId, '447700900007'), eq(outbox.kind, 'brief')))
      .orderBy(asc(outbox.createdAt))
      .all()
    expect(rows.map((r) => r.dedupeKey)).toEqual(['brief:2026-08-03:morning', 'brief:2026-08-03:evening'])
  })

  it('writes the deterministic fallback byte-for-byte when there is no model', async () => {
    // config.openai is null in every test, so this IS what the feature delivers under test — and
    // on any morning the model API is unreachable.
    const device = owner('dev_b8', '447700900008')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    await runBrief(device, NOW)

    const input = await collectBrief(device, 'morning', NOW)
    expect(input).not.toBeNull()
    expect(briefRows('447700900008')[0]!.body).toBe(briefFallback(input!))
  })

  it('sends immediately when the window is open, and holds the row when it is shut', async () => {
    const open = owner('dev_b9', '447700900009')
    markInbound(open.deviceId)
    await createReminder(open, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    await runBrief(open, NOW)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(pendingFor('447700900009')).toHaveLength(0)

    // A device that has never messaged in: the row waits rather than being dropped or rejected.
    const shut = owner('dev_b10', '447700900010')
    await createReminder(shut, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    await runBrief(shut, NOW)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(briefRows('447700900010')).toHaveLength(1)
  })

  it('EXPIRES an undelivered morning brief after 4h instead of surfacing it at 10pm', async () => {
    // THE load-bearing TTL. Flushed at 22:00 next to an evening brief opening "tomorrow starts
    // with…", a stale 07:00 brief is worse than no brief at all.
    const device = owner('dev_b11', '447700900011')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    await runBrief(device, NOW)
    const row = briefRows('447700900011')[0]!
    expect(row.expiresAtMillis).toBe(NOW + 4 * HOUR)

    vi.setSystemTime(NOW + 5 * HOUR)
    markInbound(device.deviceId)
    expect(await flushOutbox('447700900011', device.deviceId)).toEqual([])
    expect(sendMock).not.toHaveBeenCalled()
    expect(db.select().from(outbox).where(eq(outbox.id, row.id)).get()?.state).toBe('EXPIRED')
  })
})

describe('what goes in it', () => {
  it('counts an alarm a reminder is renting exactly once', async () => {
    // listArmed and listReminders both know about the same alarm. Counting both is one thing
    // counted twice, and a brief that overstates the size of the day is one that gets ignored.
    const device = owner('dev_b12', '447700900012')
    const rented = await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW + 2 * HOUR, ring: true })
    expect(rented.alarmId).not.toBeNull()
    await armAlarm(device, { alarmId: 'alm_free', triggerAtMillis: NOW + 3 * HOUR, label: 'Leave for the station' })

    const input = await collectBrief(device, 'morning', NOW)

    expect(input!.slot).toBe('morning')
    expect(input).toMatchObject({ counts: { reminders: 1, alarms: 1 } })
    // The rented alarm is not counted a second time; the standalone one is what the 1 refers to.
    // It is also what the brief NAMES: `first` ranges over events and alarms only, never reminders,
    // because a reminder's due time is when Otto chases them about it anyway.
    expect(input!.slot === 'morning' && input.first?.what).toBe('Leave for the station')
  })

  it('never carries the aggregate 14-day record', async () => {
    // The sharpest call in the feature: "3 alarms slept through" is the evidence for CHASING, in a
    // conversation the owner started. Unprompted at 07:00 it is a performance review before coffee.
    const device = owner('dev_b13', '447700900013')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    await runBrief(device, NOW)

    const body = briefRows('447700900013')[0]!.body
    expect(body).not.toContain('The record')
    expect(body).not.toContain('last 14 days')
    // Nor any per-item evidence, now that the morning brief no longer names items at all. Nothing
    // is late at the START of the day, so there is nothing here to be sharp about — the chase
    // itself arrives later, on the item's own rung, where the counters belong.
    expect(body).not.toContain('OVERDUE')
    expect(body).not.toContain('Call the dentist')
    expect(body).toContain('1 reminder')
  })

  it('takes timed calendar events and drops all-day ones', async () => {
    const device = owner('dev_b14', '447700900014')
    hasGoogleMock.mockReturnValue(true)
    listEventsMock.mockResolvedValue([
      { summary: 'Standup', startIso: '2026-08-03T09:30:00+00:00', endIso: '2026-08-03T09:45:00+00:00' },
      // An all-day entry is a label on the day, not a moment in it. Rendering it "00:00" is a lie.
      { summary: 'August bank holiday', startIso: '2026-08-03', endIso: '2026-08-04' },
    ])

    const input = await collectBrief(device, 'morning', NOW)

    // One counted event, not two: the bank holiday is a label on the day rather than a moment in
    // it, so it neither counts nor becomes the thing the brief names.
    expect(input).toMatchObject({ counts: { events: 1 } })
    expect(input!.slot === 'morning' && input.first).toEqual({ what: 'Standup', atLocal: '09:30' })
  })

  it('survives a revoked Google grant instead of killing the job', async () => {
    // An unsettled job row is still due, so an exception escaping here would re-run every 15s
    // forever. The brief is still worth sending without the calendar.
    const device = owner('dev_b15', '447700900015')
    hasGoogleMock.mockReturnValue(true)
    listEventsMock.mockResolvedValue(null)
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    const input = await collectBrief(device, 'morning', NOW)

    expect(input).toMatchObject({ counts: { events: 0, reminders: 1 } })
    expect(await runBrief(device, NOW)).toBe(true)
  })

  it('says the calendar could not be read instead of implying an empty day', async () => {
    // "Nothing on today" is a claim ABOUT THEIR DAY, and the brief was making it whenever Google
    // was unreachable — a revoked refresh token reads exactly like a clear diary. The owner puts
    // the phone down on the strength of it and misses the 09:30 they never heard about.
    //
    // The mock is on `tryListCalendarEvents` for a second reason: routing through that wrapper is
    // also what queues the one-per-day reconnect-link warning (pinned in
    // test/google-events.test.ts), and a private try/catch in the brief meant the daily path — the
    // one guaranteed to hit a dead token every morning — was the one path that never told them.
    const device = owner('dev_b25', '447700900025')
    hasGoogleMock.mockReturnValue(true)
    listEventsMock.mockResolvedValue(null)
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    const input = await collectBrief(device, 'morning', NOW)

    expect(listEventsMock).toHaveBeenCalled()
    expect(input!.calendarUnreachable).toBe(true)
    expect(briefFallback(input!)).toContain("I can't see your calendar right now.")

    // …and a calendar that answers with no events is still reported as an ordinary empty day.
    listEventsMock.mockResolvedValue([])
    const clear = await collectBrief(device, 'morning', NOW)
    expect(clear!.calendarUnreachable).toBe(false)
    expect(briefFallback(clear!)).not.toContain("can't see your calendar")
  })
})

describe('the scheduler seam', () => {
  it('seeds exactly one chain per device, however many times it runs', () => {
    // The seeder runs on every boot AND after every gc pass, so idempotence is the whole contract.
    const device = owner('dev_b18', '447700900018')
    seedBrief(device, NOW)
    seedBrief(device, NOW)
    seedBrief(device, NOW)

    const rows = briefJobs(device.deviceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.runAtMillis).toBe(TOMORROW_0700)
  })

  it('advances the SAME row instead of ending the chain', async () => {
    // `settle` moves the row the handler just ran. Delete-then-enqueue would lose a recurring chain
    // in the crash window between the two statements — the failure arm_ack goes out of its way to
    // avoid, and the reason the handler returns a time rather than queueing one.
    const device = owner('dev_b19', '447700900019')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })
    seedBrief(device, NOW - 2 * HOUR)

    const row = briefJobs(device.deviceId)[0]!
    expect(row.runAtMillis).toBe(NOW)
    await runJob(row)

    const after = briefJobs(device.deviceId)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(row.id)
    expect(after[0]!.runAtMillis).toBe(TOMORROW_0700)
    expect(briefRows('447700900019')).toHaveLength(1)
  })

  it('keeps the chain alive for a device with both slots switched off', async () => {
    // NEVER null for a device that still exists. Ending the chain here would mean turning the brief
    // back on has no path to re-create it until the next gc pass.
    const device = owner('dev_b20', '447700900020')
    updateSettings(device.deviceId, { briefEnabled: false })
    seedBrief(device, NOW - 2 * HOUR)

    const row = briefJobs(device.deviceId)[0]!
    await runJob(row)

    expect(briefJobs(device.deviceId)).toHaveLength(1)
    expect(briefRows('447700900020')).toHaveLength(0)
  })

  it('advances the chain even when delivery blows up', async () => {
    // An exception escaping the handler leaves the row unsettled — still due, and re-run every 15
    // seconds forever, composing a brief on each pass.
    const device = owner('dev_b21', '447700900021')
    markInbound(device.deviceId)
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })
    sendMock.mockRejectedValue(new Error('transport on fire'))
    seedBrief(device, NOW - 2 * HOUR)

    const row = briefJobs(device.deviceId)[0]!
    await runJob(row)

    // The send really was attempted and really did throw — without this the test passes vacuously.
    expect(sendMock).toHaveBeenCalledTimes(1)
    const after = briefJobs(device.deviceId)
    expect(after).toHaveLength(1)
    expect(after[0]!.runAtMillis).toBe(TOMORROW_0700)
  })

  it('ends the chain for a device that has gone away', async () => {
    enqueueJob('brief', NOW, { deviceId: 'dev_vanished' })
    const row = briefJobs('dev_vanished')[0]!

    await runJob(row)

    expect(briefJobs('dev_vanished')).toHaveLength(0)
  })
})

describe('interaction with the backlog digest', () => {
  /** Every outbox row for a user by body, whatever state it ended in — SUPERSEDED rows included. */
  const statesByBody = (waUserId: string): Map<string, string> =>
    new Map(
      db
        .select()
        .from(outbox)
        .where(eq(outbox.waUserId, waUserId))
        .all()
        .map((r) => [r.body, r.state]),
    )

  it('no longer retires a nudge backlog on behalf of a brief that names nothing', async () => {
    // THE behaviour that had to go when the morning brief stopped listing. It used to retire a
    // stale backlog on the grounds that "the brief covers these anyway" — true while the brief
    // enumerated the owner's open items, and false the moment it became one line about the size of
    // the day. Retiring them now would drop three messages the owner never saw in favour of a
    // sentence that never mentions them.
    const device = owner('dev_b16', '447700900016')
    markInbound(device.deviceId)
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    // Three hours old: past digest.ts's BACKLOG_AGE_MS, so these are a backlog rather than a queue.
    vi.setSystemTime(NOW - 3 * HOUR)
    for (const n of [1, 2, 3]) {
      enqueueOutbound({ waUserId: '447700900016', deviceId: device.deviceId, kind: 'nudge', body: `nudge ${n}`, dedupeKey: `n:${n}` })
    }
    vi.setSystemTime(NOW)
    // A nudge written minutes ago is not a backlog — it is about to go out with the brief.
    enqueueOutbound({ waUserId: '447700900016', deviceId: device.deviceId, kind: 'nudge', body: 'fresh', dedupeKey: 'n:fresh' })

    await runBrief(device, NOW)

    const states = statesByBody('447700900016')
    // Every one of them reaches the owner. None is SUPERSEDED.
    expect([states.get('nudge 1'), states.get('nudge 2'), states.get('nudge 3')]).toEqual([
      'SENT',
      'SENT',
      'SENT',
    ])
    // The fresh nudge and the brief are still PENDING rather than SENT, and that is MAX_SENDS_PER_FLUSH
    // (3) doing its job, not a message being lost — the outbox_flush job picks the tail up five
    // minutes later. The point of the assertion is the state: queued, never SUPERSEDED.
    expect(states.get('fresh')).toBe('PENDING')
    expect(pendingFor('447700900016').map((r) => r.kind)).toEqual(['nudge', 'brief'])
  })

  it('leaves the backlog alone when the brief cannot go out yet, and heals on next contact', async () => {
    // The window is SHUT, so this brief is a row with a 4h fuse and nothing more. Retiring the
    // nudges now bets the whole backlog on a message that may never be delivered — and when the
    // fuse burns out, flushOutbox drops the brief too and the owner hears nothing at all.
    const device = owner('dev_b22', '447700900022')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    vi.setSystemTime(NOW - 3 * HOUR)
    for (const n of [1, 2, 3]) {
      enqueueOutbound({ waUserId: '447700900022', deviceId: device.deviceId, kind: 'nudge', body: `nudge ${n}`, dedupeKey: `s:${n}` })
    }
    vi.setSystemTime(NOW)

    await runBrief(device, NOW)

    expect(sendMock).not.toHaveBeenCalled()
    expect(pendingFor('447700900022').map((r) => r.kind)).toEqual(['nudge', 'nudge', 'nudge', 'brief'])

    // 12:00: the brief expired at 11:00 unseen, and the owner finally messages. Because the nudges
    // are still there, the backlog collapses into a catch-up digest instead of vanishing.
    vi.setSystemTime(NOW + 5 * HOUR)
    expect(await maybeCollapseBacklog(device, '447700900022')).toBe(true)
    expect(pendingFor('447700900022').map((r) => r.kind)).toEqual(['brief', 'digest'])
  })

  it('lets an EXPIRED brief fall through to the digest instead of eating the backlog', async () => {
    // pendingFor filters on state alone and expiry is applied lazily inside flushOutbox, which runs
    // AFTER this — so a dead brief still reads PENDING here. Believing it retired three real nudges
    // for a message that was about to be dropped unsent: zero sends, total silence.
    const device = owner('dev_b23', '447700900023')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    // 07:00, window shut: the brief is queued with its 4h morning TTL and dies at 11:00.
    enqueueOutbound({
      waUserId: '447700900023',
      deviceId: device.deviceId,
      kind: 'brief',
      body: 'the brief',
      dedupeKey: 'brief:dead',
      ttlMs: 4 * HOUR,
    })
    // 07:30: three nudges queue behind it.
    vi.setSystemTime(NOW + HOUR / 2)
    for (const n of [1, 2, 3]) {
      enqueueOutbound({ waUserId: '447700900023', deviceId: device.deviceId, kind: 'nudge', body: `nudge ${n}`, dedupeKey: `x:${n}` })
    }

    // 11:30: first contact of the day.
    vi.setSystemTime(NOW + 4.5 * HOUR)
    expect(await maybeCollapseBacklog(device, '447700900023')).toBe(true)

    const states = statesByBody('447700900023')
    expect(states.get('nudge 1')).toBe('SUPERSEDED')
    expect(pendingFor('447700900023').map((r) => r.kind)).toEqual(['brief', 'digest'])
    expect(getDevice(device.deviceId)!.lastDigestAt).toBe(NOW + 4.5 * HOUR)
  })

  it('does not let a queued brief cancel the digest, however much time is left on it', async () => {
    // The same removal seen from the digest's side. `SUMMARY_KINDS` no longer contains 'brief', so
    // a queued brief neither silences the digest nor retires what it would have collapsed. The
    // backlog becomes a catch-up digest, which is the mechanism built for exactly that.
    const device = owner('dev_b24', '447700900024')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    vi.setSystemTime(NOW - 3 * HOUR)
    for (const n of [1, 2, 3]) {
      enqueueOutbound({ waUserId: '447700900024', deviceId: device.deviceId, kind: 'nudge', body: `nudge ${n}`, dedupeKey: `y:${n}` })
    }
    vi.setSystemTime(NOW)
    enqueueOutbound({
      waUserId: '447700900024',
      deviceId: device.deviceId,
      kind: 'brief',
      body: 'the brief',
      dedupeKey: 'brief:live',
      ttlMs: 4 * HOUR,
    })

    expect(await maybeCollapseBacklog(device, '447700900024')).toBe(true)
    expect(pendingFor('447700900024').map((r) => r.kind)).toEqual(['brief', 'digest'])
  })

  it('lets a queued WEEKLY REVIEW cancel the digest too', async () => {
    // The guard was written as `kind === 'brief'` by the branch that built the digest, and the
    // accountability branch then added a second kind that opens by enumerating the same open items
    // ("3 still open", plus the slipping ones by name). Sunday's review queued against a shut
    // window was therefore followed, on the owner's next message, by a catch-up digest restating
    // the identical list in a different voice — the exact double-up this handshake exists to stop.
    const device = owner('dev_b26', '447700900026')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    vi.setSystemTime(NOW - 3 * HOUR)
    for (const n of [1, 2, 3]) {
      enqueueOutbound({ waUserId: '447700900026', deviceId: device.deviceId, kind: 'nudge', body: `nudge ${n}`, dedupeKey: `w:${n}` })
    }
    vi.setSystemTime(NOW)
    enqueueOutbound({
      waUserId: '447700900026',
      deviceId: device.deviceId,
      kind: 'weekly',
      body: 'This week: 0 finished, 0 dropped, 3 still open.',
      dedupeKey: 'weekly:x',
      ttlMs: 36 * HOUR,
    })

    expect(await maybeCollapseBacklog(device, '447700900026')).toBe(false)

    const states = statesByBody('447700900026')
    expect([states.get('nudge 1'), states.get('nudge 2'), states.get('nudge 3')]).toEqual([
      'SUPERSEDED',
      'SUPERSEDED',
      'SUPERSEDED',
    ])
    expect(pendingFor('447700900026').map((r) => r.kind)).toEqual(['weekly'])
    // No digest went out, so the day's one digest is still available if a real backlog builds later.
    expect(getDevice(device.deviceId)!.lastDigestAt).toBeNull()
  })

  it('lets a queued brief cancel the digest without spending the day\'s digest', async () => {
    // Was the mirror image of the case above — the brief queued first, this contact flushing it —
    // and it rested on the brief restating the same reminders. It restates nothing now, so the two
    // messages say different things and both are worth having: one line about the size of the day,
    // and a catch-up naming what is actually outstanding.
    const device = owner('dev_b17', '447700900017')
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    vi.setSystemTime(NOW - 3 * HOUR)
    for (const n of [1, 2, 3]) {
      enqueueOutbound({ waUserId: '447700900017', deviceId: device.deviceId, kind: 'nudge', body: `nudge ${n}`, dedupeKey: `d:${n}` })
    }
    vi.setSystemTime(NOW)
    enqueueOutbound({ waUserId: '447700900017', deviceId: device.deviceId, kind: 'brief', body: 'the brief', dedupeKey: 'brief:x' })

    expect(await maybeCollapseBacklog(device, '447700900017')).toBe(true)

    const pending = pendingFor('447700900017')
    expect(pending.map((r) => r.kind)).toEqual(['brief', 'digest'])
    expect(pending[0]!.body).toBe('the brief')
    // A digest DID go out, so the day's allowance is spent — unlike the weekly-review case above,
    // where nothing was queued and the allowance is deliberately kept.
  })
})

/**
 * The window-edge collision, which only exists once quiet hours and the brief are both live.
 *
 * `deferPastQuietHours` returns the window's exclusive end with no spread, so EVERY rung chased
 * overnight resolves to the same millisecond — and the default brief sits on that same boundary.
 * Measured on the merged tree before this was fixed: the brief listing three overdue reminders,
 * then three nudges chasing those same three, four messages inside one scheduler tick.
 */
describe('the brief does not repeat itself in the same second', () => {
  const dueNudges = (deviceId: string) =>
    db.select().from(jobs).where(and(eq(jobs.kind, 'nudge'), eq(jobs.deviceId, deviceId))).all()

  it('pushes a nudge that is due right now for something it just named', async () => {
    const device = owner('dev_edge', 'wa_edge')
    markInbound(device.deviceId)
    const r = await createReminder(device, {
      title: 'call the dentist',
      detail: null,
      dueAtMillis: NOW - HOUR,
      recurrence: null,
      nagPolicy: 'persistent',
      ring: false,
      escalateWithAlarm: false,
    })
    // Land its rung exactly on the brief, the way an overnight defer does.
    db.update(reminders).set({ nextNagAtMillis: NOW }).where(eq(reminders.reminderId, r.reminderId)).run()

    await runBrief(device, NOW, NOW)

    const rung = db.select().from(reminders).where(eq(reminders.reminderId, r.reminderId)).get()!
    expect(rung.nextNagAtMillis).toBe(NOW + MIN_RUNG_GAP_MS)
    // The chase is postponed, NOT spent: nagCount drives the "chased N×" evidence the persona cites.
    expect(rung.nagCount).toBe(0)
    expect(dueNudges(device.deviceId).every((j) => j.runAtMillis === NOW + MIN_RUNG_GAP_MS)).toBe(true)
  })

  it('leaves a nudge that is hours away completely alone', async () => {
    const device = owner('dev_edge2', 'wa_edge2')
    markInbound(device.deviceId)
    const r = await createReminder(device, {
      title: 'book the MOT',
      detail: null,
      dueAtMillis: NOW + 6 * HOUR,
      recurrence: null,
      nagPolicy: 'gentle',
      ring: false,
      escalateWithAlarm: false,
    })
    const before = db.select().from(reminders).where(eq(reminders.reminderId, r.reminderId)).get()!

    await runBrief(device, NOW, NOW)

    const after = db.select().from(reminders).where(eq(reminders.reminderId, r.reminderId)).get()!
    expect(after.nextNagAtMillis).toBe(before.nextNagAtMillis)
  })

  it('does not silence nudges when the brief itself is held back', async () => {
    // Window shut: the brief is a queued row with a fuse, and if it burns out nobody ever read it.
    // Silencing the nudges it "covered" would leave the owner with nothing at all.
    const device = owner('dev_edge3', 'wa_edge3')
    const r = await createReminder(device, {
      title: 'email Teal',
      detail: null,
      dueAtMillis: NOW - HOUR,
      recurrence: null,
      nagPolicy: 'persistent',
      ring: false,
      escalateWithAlarm: false,
    })
    db.update(reminders).set({ nextNagAtMillis: NOW }).where(eq(reminders.reminderId, r.reminderId)).run()

    await runBrief(device, NOW, NOW)

    expect(db.select().from(reminders).where(eq(reminders.reminderId, r.reminderId)).get()!.nextNagAtMillis).toBe(NOW)
  })
})

/**
 * The morning brief as a SHAPE rather than a list — the change the owner actually asked for.
 *
 * Everything here runs under this file's fixed `NOW` with only `Date` faked, so none of it can
 * pass or fail by the hour the suite happens to run at.
 */
describe('the morning brief is one line about the size of the day', () => {
  it('names nothing and counts everything', async () => {
    const device = owner('dev_b30', '447700900030')
    for (const title of ['Call the dentist', 'File the tax return', 'Take the bins out']) {
      await createReminder(device, { title, dueAtMillis: NOW + 3 * HOUR })
    }

    await runBrief(device, NOW)

    const body = briefRows('447700900030')[0]!.body
    expect(body).toContain('3 reminders')
    for (const title of ['Call the dentist', 'File the tax return', 'Take the bins out']) {
      expect(body).not.toContain(title)
    }
    // One line. The old brief allowed one line PER ITEM; this is the guarantee that it does not.
    expect(body.split('\n')).toHaveLength(1)
  })

  it('counts the whole backlog rather than truncating it at four', async () => {
    // MAX_REMINDERS caps the EVENING list. Applying it to a count would understate the day —
    // "4 reminders" when there are nine is a worse answer than saying nothing.
    const device = owner('dev_b31', '447700900031')
    for (let i = 0; i < 9; i++) {
      await createReminder(device, { title: `thing ${i}`, dueAtMillis: NOW + 3 * HOUR })
    }

    const input = await collectBrief(device, 'morning', NOW)

    expect(input).toMatchObject({ counts: { reminders: 9 } })
  })

  it('leaves out a deadline that is days away', async () => {
    // The asymmetry that would otherwise rebuild the dump one item at a time: events and alarms
    // were always windowed to the day and reminders never were, so something due on Friday counted
    // towards "today" every morning from Monday.
    const device = owner('dev_b32', '447700900032')
    await createReminder(device, { title: 'File the tax return', dueAtMillis: NOW + 5 * 24 * HOUR })

    expect(await collectBrief(device, 'morning', NOW)).toBeNull()
  })

  it('still counts an undated reminder, which has no date to fall outside the day', async () => {
    // "Sort the loft out" is exactly the kind of thing that goes missing, so it counts. It has no
    // due time to compare against the window, and dropping it for that reason would be backwards.
    const device = owner('dev_b33', '447700900033')
    await createReminder(device, { title: 'Sort the loft out' })

    expect(await collectBrief(device, 'morning', NOW)).toMatchObject({ counts: { reminders: 1 } })
  })

  it('counts a reminder due late tonight, past midnight, as part of today', async () => {
    // The owner in question goes to bed at two. Their day ends at their bedtime, not at midnight,
    // so a 01:00 deadline is tonight's problem and `endOf('day')` would call it tomorrow's.
    const device = owner('dev_b34', '447700900034')
    updateSettings(device.deviceId, { bedWindow: '01:00-02:00', wakeWindow: '11:00-12:00' })
    // NOW is 07:00 UTC; 20 hours on is 03:00 the next day, comfortably past their 02:00 bedtime.
    await createReminder(device, { title: 'late one', dueAtMillis: NOW + 16 * HOUR })
    await createReminder(device, { title: 'too late', dueAtMillis: NOW + 20 * HOUR })

    expect(await collectBrief(device, 'morning', NOW)).toMatchObject({ counts: { reminders: 1 } })
  })

  it('stays silent, and does not spend the day, when there is nothing on', async () => {
    // Silence is the common case now and must not burn the once-a-day marker, or a genuinely busy
    // afternoon could not produce a brief tomorrow.
    const device = owner('dev_b35', '447700900035')

    expect(await runBrief(device, NOW)).toBe(false)
    expect(briefRows('447700900035')).toHaveLength(0)
    expect(getSettings(device.deviceId).lastBriefAt).toBeNull()
  })

  it('holds a rung that would land in the same tick as the brief', async () => {
    // Not about repetition any more — the brief names nothing. It is about BURST: one line about
    // the day plus a chase, inside a single scheduler tick, is two buzzes at once.
    const device = owner('dev_b36', '447700900036')
    markInbound(device.deviceId)
    const r = await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })
    db.update(reminders).set({ nextNagAtMillis: NOW }).where(eq(reminders.reminderId, r.reminderId)).run()

    await runBrief(device, NOW)

    const after = getReminder(r.reminderId)!
    expect(after.nextNagAtMillis).toBe(NOW + 30 * 60 * 1000)
    // The rung MOVED but was not spent: nagCount is the evidence the persona cites, and a message
    // that only got out of the way must not inflate it.
    expect(after.nagCount).toBe(0)
  })

  it('leaves a rung hours away completely alone', async () => {
    const device = owner('dev_b37', '447700900037')
    markInbound(device.deviceId)
    const r = await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW + 6 * HOUR })
    db.update(reminders).set({ nextNagAtMillis: NOW + 4 * HOUR }).where(eq(reminders.reminderId, r.reminderId)).run()

    await runBrief(device, NOW)

    expect(getReminder(r.reminderId)!.nextNagAtMillis).toBe(NOW + 4 * HOUR)
  })

  it('keeps the evening brief a list, because nothing in tomorrow can announce itself first', async () => {
    const device = owner('dev_b38', '447700900038')
    updateSettings(device.deviceId, { eveningBriefEnabled: true })
    await createReminder(device, { title: 'Call the dentist', dueAtMillis: NOW - 4 * 24 * HOUR })

    const input = await collectBrief(device, 'evening', NOW)

    expect(input!.slot).toBe('evening')
    expect(input!.slot === 'evening' && input.reminders.map((r) => r.title)).toEqual(['Call the dentist'])
    expect(briefFallback(input!)).toContain('Call the dentist')
  })
})
