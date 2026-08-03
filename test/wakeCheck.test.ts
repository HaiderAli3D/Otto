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

    const next = await runWakeCheck(wakeJobs()[0]!)

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
    expect(await runWakeCheck(job)).toBeNull()
    expect(sends).toHaveLength(0)
  })

  it('after the last round it arms ONE backup alarm carrying wakeCheck === false', async () => {
    // The non-recursion guard. The backup gets dismissed too; a wake-check on it would start a
    // second ladder, which would arm a third alarm, forever.
    const device = reachableDevice('dev_wc7')
    const alarmId = await wakeAlarm(device, 'alm_wc7', true)
    const dismissedAt = Date.now() - 60 * 60_000
    scheduleWakeCheck(alarmId, device, dismissedAt)

    let job: Job | undefined = wakeJobs()[0]!
    for (let round = 0; round < MAX_WAKE_ROUNDS; round++) {
      const next = await runWakeCheck(job!)
      expect(next).not.toBeNull()
      job = wakeJobs()[0]
    }
    // One more tick: the rounds are spent, so this one escalates.
    expect(await runWakeCheck(job!)).toBeNull()

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
    scheduleWakeCheck(alarmId, device, dismissedAt)

    let job: Job | undefined = wakeJobs()[0]!
    for (let round = 0; round <= MAX_WAKE_ROUNDS; round++) {
      if (!job) break
      await runWakeCheck(job)
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

    expect(await runWakeCheck(wakeJobs()[0]!)).toBeNull()

    expect(sends).toHaveLength(0)
    expect(outboxRows(device.deviceId)).toHaveLength(0)
    expect(armed).toHaveLength(1)
    expect(armed[0]!.data.label).toBe('Still asleep? — Get up')
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

    await runWakeCheck(wakeJobs()[0]!)

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
