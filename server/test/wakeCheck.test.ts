import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const armed = vi.hoisted(() => [] as Array<{ token: string; data: Record<string, string> }>)
vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async (token: string, data: Record<string, string>) => {
    armed.push({ token, data })
    return { ok: true as const }
  }),
}))

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

import { DateTime } from 'luxon'
import { desc, eq } from 'drizzle-orm'
import { db, ensureSchema } from '../src/db/client.js'
import { alarms, jobs as jobsTable, outbox } from '../src/db/schema.js'
import { MAX_WAKE_ROUNDS, wakeCheckAt } from '../src/lib/wakeLadder.js'
import { armAlarm } from '../src/services/alarms.js'
import { clearInboundWindow, getDevice, linkWhatsapp, markInbound, type Device } from '../src/services/devices.js'
import { dueJobs, type Job } from '../src/services/jobs.js'
import { updateSettings } from '../src/services/settings.js'
import { ownerRecord } from '../src/services/signals.js'
import { cancelWakeChecks, runWakeCheck, scheduleWakeCheck } from '../src/services/wakeCheck.js'
import { makeApp, makeDevice } from './helpers.js'

const FAR_FUTURE = Date.now() + 365 * 24 * 3_600_000

/**
 * Run a rung as the scheduler would: at the instant the row says it is due.
 *
 * These tests place a dismissal in the past so the ladder is immediately walkable, then call
 * `runWakeCheck` back to back in real time — so measured against a real clock every rung looks
 * catastrophically late, which is exactly the state `runWakeCheck` now stands down from. Passing the
 * row's own `runAtMillis` says "the scheduler fired this on time", which is the case under test.
 * A test that wants the late case says so explicitly (see 'a ladder left behind by a restart').
 */
const runOnTime = (job: Job): Promise<number | null> => runWakeCheck(job, job.runAtMillis)
const WA_NUMBER = '447700900321'

beforeEach(() => {
  ensureSchema()
  // One in-memory DB per test FILE, so the queue has to be cleared between cases or `wakeJobs()`
  // picks up the previous test's ladder (and its startedAt).
  db.delete(jobsTable).run()
  armed.length = 0
  sends.length = 0
})

/**
 * Reachable over WhatsApp, with the 24h window open but the last inbound two hours old.
 *
 * That gap matters: ANY inbound at or after the dismissal ends the ladder, so a device whose last
 * message is "now" can never run a single round. Two hours is comfortably inside the window and
 * comfortably before every dismissal these tests use.
 */
function reachableDevice(deviceId: string): Device {
  makeDevice(deviceId)
  linkWhatsapp(deviceId, WA_NUMBER)
  markInbound(deviceId, Date.now() - 2 * 3_600_000)
  return getDevice(deviceId)!
}

/** Arm a wake-up alarm and hand back its id. */
async function wakeAlarm(device: Device, alarmId: string, wakeCheck: boolean): Promise<string> {
  await armAlarm(device, {
    alarmId,
    triggerAtMillis: Date.now() + 3_600_000,
    label: 'Get up',
    wakeCheck,
  })
  armed.length = 0
  return alarmId
}

const wakeJobs = (): Job[] => dueJobs(FAR_FUTURE).filter((j) => j.kind === 'wake_check')

/**
 * Start a ladder for a dismissal the phone reported PROMPTLY — `now` is the dismissal instant.
 *
 * Most cases below back-date the dismissal so every rung is already due and the ladder can be driven
 * synchronously, which is a statement about test time, not about report latency. Since
 * `scheduleWakeCheck` refuses a dismissal it hears about more than a ladder-span late (see
 * STALE_DISMISSAL_MS), those cases have to say which of the two they mean.
 */
const scheduleReportedAt = (alarmId: string, device: Device, dismissedAt: number): boolean =>
  scheduleWakeCheck(alarmId, device, dismissedAt, dismissedAt)

const outboxRows = (deviceId: string) =>
  db.select().from(outbox).where(eq(outbox.deviceId, deviceId)).all()

describe('scheduling the ladder', () => {
  it('does nothing for an alarm that did not opt in', async () => {
    const device = reachableDevice('dev_wc1')
    const alarmId = await wakeAlarm(device, 'alm_wc1', false)
    expect(scheduleWakeCheck(alarmId, device, Date.now())).toBe(false)
    expect(wakeJobs()).toHaveLength(0)
  })

  it('queues exactly one round-0 job twelve minutes after the dismissal', async () => {
    const device = reachableDevice('dev_wc2')
    const alarmId = await wakeAlarm(device, 'alm_wc2', true)
    const dismissedAt = Date.now()

    expect(scheduleWakeCheck(alarmId, device, dismissedAt)).toBe(true)

    const queued = wakeJobs()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.runAtMillis).toBe(dismissedAt + 12 * 60_000)
    expect(queued[0]!.alarmId).toBe(alarmId)
  })

  it('a re-delivered DISMISSED replaces the ladder rather than forking a second one', async () => {
    const device = reachableDevice('dev_wc3')
    const alarmId = await wakeAlarm(device, 'alm_wc3', true)
    scheduleWakeCheck(alarmId, device, Date.now())
    scheduleWakeCheck(alarmId, device, Date.now())
    expect(wakeJobs()).toHaveLength(1)
  })

  it('a re-delivered DISMISSED does not restart a ladder that is halfway through', async () => {
    // The app's outbox retries at-least-once, and this hook sits OUTSIDE the guard `recordEvent`
    // keeps for exactly that. Phone reports DISMISSED, the 204 is lost, the ladder runs rounds 0
    // and 1 — then the identical report lands again. Re-anchoring round 0 at an instant already
    // twenty minutes past makes the very next tick ask "You up?" all over again.
    const device = reachableDevice('dev_wc12')
    const alarmId = await wakeAlarm(device, 'alm_wc12', true)
    const dismissedAt = Date.now() - 60 * 60_000

    expect(scheduleReportedAt(alarmId, device, dismissedAt)).toBe(true)
    const originalJobId = wakeJobs()[0]!.id
    await runOnTime(wakeJobs()[0]!)
    await runOnTime(wakeJobs()[0]!)
    expect(sends).toHaveLength(2)

    // The duplicate report. Same alarm, same instant, and reported just as promptly — so the latch
    // is what refuses it, not the staleness gate.
    expect(scheduleReportedAt(alarmId, device, dismissedAt)).toBe(false)
    expect(wakeJobs()).toHaveLength(1)
    expect(wakeJobs()[0]!.id).toBe(originalJobId)

    // The ladder carries on from where it was rather than starting over.
    await runOnTime(wakeJobs()[0]!)
    expect(sends.map((s) => s.body)).toEqual([
      'You up?',
      'Still nothing. Are you up?',
      "Get up was half an hour ago and you've gone quiet. Last ask before I ring the phone again.",
    ])
  })

  it('a DISMISSED re-delivered after the ladder has already finished does not start a second one', async () => {
    // Why the latch is a durable alarm_events row and not "is there a live wake_check job": by the
    // time the chain has escalated its job is gone, so a late replay would find nothing, re-walk
    // every round and arm a SECOND backup alarm.
    const device = reachableDevice('dev_wc15')
    const alarmId = await wakeAlarm(device, 'alm_wc15', true)
    const dismissedAt = Date.now() - 60 * 60_000

    scheduleReportedAt(alarmId, device, dismissedAt)
    for (let round = 0; round <= MAX_WAKE_ROUNDS; round++) {
      const job = wakeJobs()[0]
      if (!job) break
      await runOnTime(job)
    }
    db.delete(jobsTable).run() // the scheduler settles a null outcome by deleting the row
    expect(armed).toHaveLength(1)

    expect(scheduleReportedAt(alarmId, device, dismissedAt)).toBe(false)
    expect(wakeJobs()).toHaveLength(0)
    expect(armed).toHaveLength(1)
  })

  it('rings the backup alarm when the scheduler fires the last rung a few seconds late', async () => {
    // The regression this guard nearly caused. `STALE_DISMISSAL_MS` IS `wakeCheckAt(MAX_WAKE_ROUNDS, 0)`,
    // and the last round schedules its successor at exactly `startedAt + that`. The scheduler polls on
    // a 15-second tick unrelated to the dismissal, so `nowMillis` arrives LATE by construction — and a
    // `>` comparison against the span itself stood the ladder down before `escalate` was ever reached.
    // No ring, no record row, on the healthy path, every time. The other tests miss it because
    // `runOnTime` passes `job.runAtMillis`, the one clock value that makes the difference zero.
    const device = reachableDevice('dev_wc_late')
    const alarmId = await wakeAlarm(device, 'alm_wc_late', true)
    const dismissedAt = Date.now() - 60_000
    scheduleReportedAt(alarmId, device, dismissedAt)

    // Walk the ladder the way the scheduler does, each rung a few seconds after it was due.
    for (let i = 0; i <= MAX_WAKE_ROUNDS; i++) {
      const job = wakeJobs()[0]
      if (!job) break
      await runWakeCheck(job, job.runAtMillis + 7_000)
    }

    expect(armed).toHaveLength(1)
    expect(armed[0]!.data.label).toContain('Still asleep?')
    expect(ownerRecord(device.deviceId).sleptThroughAfterDismiss).toBe(1)
  })

  it('stands a ladder down rather than replaying it after a restart outlasted it', async () => {
    // Every rung is derived from the DISMISSAL rather than from now, so a process down longer than
    // the ladder's own span comes back with the whole remainder already in the past. That used to
    // walk all three rounds on consecutive fifteen-second ticks and ring a real alarm within a
    // minute of boot — three messages and a phone at full volume hours after the owner got up,
    // plus WAKE_CHECK_FAILED on the permanent record, read back to them as "went back to sleep".
    const device = reachableDevice('dev_wc_stale')
    const alarmId = await wakeAlarm(device, 'alm_wc_stale', true)
    const dismissedAt = Date.now() - 5 * 60_000
    scheduleReportedAt(alarmId, device, dismissedAt)
    const job = wakeJobs()[0]!

    // The scheduler comes back three hours late.
    const next = await runWakeCheck(job, dismissedAt + 3 * 3_600_000)

    expect(next).toBeNull()
    expect(sends).toHaveLength(0)
    expect(armed).toHaveLength(0)
    // And nothing on the record: they were never in a position to answer a question nobody sent.
    expect(ownerRecord(device.deviceId).sleptThroughAfterDismiss).toBe(0)
  })

  it('a genuinely new dismissal of the same alarm still replaces the chain', async () => {
    // The latch is keyed on the dismissal instant, not the alarm, so a re-armed alarm dismissed
    // again tomorrow is not mistaken for yesterday's replay.
    const device = reachableDevice('dev_wc16')
    const alarmId = await wakeAlarm(device, 'alm_wc16', true)
    const first = Date.now() - 60 * 60_000

    expect(scheduleReportedAt(alarmId, device, first)).toBe(true)
    expect(scheduleReportedAt(alarmId, device, first + 1)).toBe(true)
    const queued = wakeJobs()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.runAtMillis).toBe(wakeCheckAt(0, first + 1))
  })

  it('refuses a dismissal the phone only got round to reporting hours later', async () => {
    // `atMillis` is when the owner SWIPED, not when we heard about it. The Android app drains an
    // append-only event outbox under NetworkType.CONNECTED with Result.retry(), so a phone with no
    // signal at 06:31 reports at 09:20 still carrying 06:31 — and every rung derived from that
    // dismissal is already in the past. The 15s tick walked the whole ladder in 45 seconds, armed a
    // REAL alarm that rings on the commute three hours after they got up, and wrote
    // WAKE_CHECK_FAILED against someone who had been awake all morning.
    //
    // Neither existing guard catches it: the stand-down compares lastInboundAt against the
    // DISMISSAL, so last night's message does not count, and WAKE_TTL_MS is measured from the
    // enqueue rather than from the dismissal.
    const device = reachableDevice('dev_wc17')
    const alarmId = await wakeAlarm(device, 'alm_wc17', true)
    const dismissedAt = Date.now() - 3 * 3_600_000

    expect(scheduleWakeCheck(alarmId, device, dismissedAt)).toBe(false)

    expect(wakeJobs()).toHaveLength(0)
    expect(sends).toHaveLength(0)
    expect(armed).toHaveLength(0)
    expect(ownerRecord(device.deviceId).sleptThroughAfterDismiss).toBe(0)
  })

  it('still starts a ladder for a report that is merely a little late', async () => {
    // The threshold is the ladder's own span, not zero: a report delayed by a couple of minutes is
    // an ordinary retry and every rung still lands roughly where it was meant to.
    const device = reachableDevice('dev_wc18')
    const alarmId = await wakeAlarm(device, 'alm_wc18', true)
    const dismissedAt = Date.now() - 2 * 60_000

    expect(scheduleWakeCheck(alarmId, device, dismissedAt)).toBe(true)
    expect(wakeJobs()[0]!.runAtMillis).toBe(wakeCheckAt(0, dismissedAt))
  })

  it('carries wakeCheck across a recurring re-arm — day two still gets checked', async () => {
    // armAlarm is an upsert, so the flag has to be in the conflict SET as well as the values.
    const device = reachableDevice('dev_wc4')
    await armAlarm(device, { alarmId: 'alm_wc4', triggerAtMillis: Date.now() + 60_000, label: 'Get up', wakeCheck: true })
    await armAlarm(device, { alarmId: 'alm_wc4', triggerAtMillis: Date.now() + 120_000, label: 'Get up', wakeCheck: true })
    expect(db.select().from(alarms).where(eq(alarms.alarmId, 'alm_wc4')).get()!.wakeCheck).toBe(true)
  })
})

describe('running the ladder', () => {
  it('round 0 asks "You up?"', async () => {
    const device = reachableDevice('dev_wc5')
    const alarmId = await wakeAlarm(device, 'alm_wc5', true)
    const dismissedAt = Date.now()
    scheduleWakeCheck(alarmId, device, dismissedAt)

    const next = await runOnTime(wakeJobs()[0]!)

    expect(sends).toEqual([{ to: WA_NUMBER, body: 'You up?' }])
    expect(next).toBe(wakeCheckAt(1, dismissedAt))
    // No backup alarm yet — the ringer is the last resort, not the first.
    expect(armed).toHaveLength(0)
  })

  it('an inbound cancels the chain, and a mid-tick one stands the round down', async () => {
    const device = reachableDevice('dev_wc6')
    const alarmId = await wakeAlarm(device, 'alm_wc6', true)
    const dismissedAt = Date.now() - 1_000
    scheduleWakeCheck(alarmId, device, dismissedAt)
    const job = wakeJobs()[0]!

    // The webhook hook: any inbound at all, including a voice note.
    markInbound(device.deviceId)
    cancelWakeChecks(device.deviceId)
    expect(wakeJobs()).toHaveLength(0)

    // And the handler's own re-check, for an inbound that lands while a tick is in flight.
    expect(await runOnTime(job)).toBeNull()
    expect(sends).toHaveLength(0)
  })

  it('after the last round it arms ONE backup alarm carrying wakeCheck === false', async () => {
    // The non-recursion guard. The backup gets dismissed too; a wake-check on it would start a
    // second ladder, which would arm a third alarm, forever.
    const device = reachableDevice('dev_wc7')
    const alarmId = await wakeAlarm(device, 'alm_wc7', true)
    const dismissedAt = Date.now() - 60 * 60_000
    scheduleReportedAt(alarmId, device, dismissedAt)

    let job: Job | undefined = wakeJobs()[0]!
    for (let round = 0; round < MAX_WAKE_ROUNDS; round++) {
      const next = await runOnTime(job!)
      expect(next).not.toBeNull()
      job = wakeJobs()[0]
    }
    // One more tick: the rounds are spent, so this one escalates.
    expect(await runOnTime(job!)).toBeNull()

    expect(sends).toHaveLength(MAX_WAKE_ROUNDS)
    const backups = db
      .select()
      .from(alarms)
      .where(eq(alarms.deviceId, device.deviceId))
      .orderBy(desc(alarms.createdAt))
      .all()
      .filter((a) => a.alarmId !== alarmId)
    expect(backups).toHaveLength(1)
    expect(backups[0]!.label).toBe('Still asleep? — Get up')
    expect(backups[0]!.wakeCheck).toBe(false)
  })

  it('records WAKE_CHECK_FAILED against the ORIGINAL alarm and puts it on the record', async () => {
    const device = reachableDevice('dev_wc8')
    const alarmId = await wakeAlarm(device, 'alm_wc8', true)
    const dismissedAt = Date.now() - 60 * 60_000
    scheduleReportedAt(alarmId, device, dismissedAt)

    let job: Job | undefined = wakeJobs()[0]!
    for (let round = 0; round <= MAX_WAKE_ROUNDS; round++) {
      if (!job) break
      await runOnTime(job)
      job = wakeJobs()[0]
    }

    const record = ownerRecord(device.deviceId)
    expect(record.sleptThroughAfterDismiss).toBe(1)
    // And the alarm's own state was never touched by the audit row.
    expect(db.select().from(alarms).where(eq(alarms.alarmId, alarmId)).get()!.state).toBe('ARMED')
  })

  it('a shut window skips the chat rounds entirely and rings straight away', async () => {
    // Three undeliverable messages and then a ring half an hour later is worse than the ring now.
    const device = reachableDevice('dev_wc9')
    const alarmId = await wakeAlarm(device, 'alm_wc9', true)
    scheduleWakeCheck(alarmId, device, Date.now())
    clearInboundWindow(device.deviceId)

    expect(await runOnTime(wakeJobs()[0]!)).toBeNull()

    expect(sends).toHaveLength(0)
    expect(outboxRows(device.deviceId)).toHaveLength(0)
    expect(armed).toHaveLength(1)
    expect(armed[0]!.data.label).toBe('Still asleep? — Get up')
  })

  it('does NOT put a failure on the record when it never managed to ask', async () => {
    // WAKE_CHECK_FAILED is quoted back at the owner — "dismissed and went back to sleep N×" in the
    // conversational record, "N dismissed then back to sleep" in Sunday's review. Escalating on a
    // shut window sends nothing at all, so recording a failure there accuses someone who got up
    // perfectly normally of sleeping through a question nobody asked. The ring stays; the row goes.
    const device = reachableDevice('dev_wc13')
    const alarmId = await wakeAlarm(device, 'alm_wc13', true)
    scheduleWakeCheck(alarmId, device, Date.now())
    clearInboundWindow(device.deviceId)

    expect(await runOnTime(wakeJobs()[0]!)).toBeNull()

    expect(sends).toHaveLength(0)
    expect(armed).toHaveLength(1) // still rung — a shut window is no reason to leave them asleep
    expect(ownerRecord(device.deviceId).sleptThroughAfterDismiss).toBe(0)
  })

  it('DOES record a failure once at least one round has actually gone out', async () => {
    // The line is "was anything ever asked", not "did we run out of rounds" — one delivered round
    // and then a window that shut is a real unanswered check, and belongs on the record.
    const device = reachableDevice('dev_wc14')
    const alarmId = await wakeAlarm(device, 'alm_wc14', true)
    scheduleReportedAt(alarmId, device, Date.now() - 60 * 60_000)

    await runOnTime(wakeJobs()[0]!)
    expect(sends).toHaveLength(1)
    clearInboundWindow(device.deviceId)
    expect(await runOnTime(wakeJobs()[0]!)).toBeNull()

    expect(ownerRecord(device.deviceId).sleptThroughAfterDismiss).toBe(1)
  })
})

describe('the webhook cancel hook', () => {
  it('a VOICE NOTE ends the ladder — it lands before the non-text early return', async () => {
    // Being awake enough to send anything at all is exactly the question being asked, so the hook
    // sits immediately after markInbound and ahead of the "I can only read text" bail-out.
    const app = await makeApp()
    // Its own number: every other device in this file shares WA_NUMBER, and deviceForWhatsapp
    // resolves a shared number to the FIRST device that claimed it.
    const from = '447700900999'
    makeDevice('dev_wc11')
    linkWhatsapp('dev_wc11', from)
    markInbound('dev_wc11', Date.now() - 2 * 3_600_000)
    const device = getDevice('dev_wc11')!
    const alarmId = await wakeAlarm(device, 'alm_wc11', true)
    scheduleWakeCheck(alarmId, device, Date.now())
    expect(wakeJobs()).toHaveLength(1)

    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.wc11', type: 'audio', from }] } }] }],
    })
    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'test-app-secret').update(body).digest('hex'),
      },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    // The webhook acks first and processes after, so let the per-user chain settle.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(wakeJobs()).toHaveLength(0)
    // And it still told them it can only read text — the cancel does not swallow the reply.
    expect(sends.some((s) => s.body.includes('only read text'))).toBe(true)
  })
})

describe('quiet hours never suppress a wake-check', () => {
  it('delivers inside a window that covers right now', async () => {
    // A 06:30 wake-check inside a 22:00–07:00 window is the entire point of the feature. Pinned so
    // that a future refactor cannot route this through the nag ladder and quietly lose it.
    const device = reachableDevice('dev_wc10')
    const now = DateTime.now().setZone('UTC')
    updateSettings(device.deviceId, {
      quietHours: `${now.minus({ minutes: 90 }).toFormat('HH:mm')}-${now.plus({ hours: 3 }).toFormat('HH:mm')}`,
    })
    const alarmId = await wakeAlarm(device, 'alm_wc10', true)
    scheduleWakeCheck(alarmId, device, Date.now())

    await runOnTime(wakeJobs()[0]!)

    expect(sends).toEqual([{ to: WA_NUMBER, body: 'You up?' }])
  })

  it('never reaches the nag ladder in the first place', () => {
    // Structural, not behavioural: neither module may IMPORT the ladder or the quiet-hours
    // machinery, so a refactor that "unifies" proactive sending has to delete this test on purpose
    // rather than quietly routing a 06:30 wake-check through a 22:00–07:00 window.
    const forbidden = ['nagLadder.js', 'nagging.js', 'quietHours.js', 'settings.js']
    for (const path of ['../src/services/wakeCheck.ts', '../src/services/handlers/wakeCheck.ts']) {
      const imports = readFileSync(new URL(path, import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('import '))
        .join('\n')
      for (const module of forbidden) expect(imports).not.toContain(module)
    }
  })
})
