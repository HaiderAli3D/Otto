import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

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

const listEvents = vi.hoisted(() => vi.fn())
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(): void {}
      },
    },
    calendar: () => ({ events: { list: listEvents } }),
    tasks: () => ({ tasks: { insert: vi.fn() } }),
  },
}))

import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { alarmEvents, alarms, googleAccounts, jobs as jobsTable } from '../src/db/schema.js'
import { armAlarm } from '../src/services/alarms.js'
import { getDevice, linkWhatsapp, markInbound, setTimezone, type Device } from '../src/services/devices.js'
import { dueJobs, type Job } from '../src/services/jobs.js'
import { runWakeCheck, scheduleWakeCheck } from '../src/services/wakeCheck.js'
import { makeDevice } from './helpers.js'

// config.google is null in tests (setup-env.ts sets no GOOGLE_OAUTH_*), and oauthClient() throws on
// that before googleapis is reached. `config` is a plain object; `as const` is compile-time only.
Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

/**
 * The wake-check stands DOWN inside a commitment rather than being deferred or dropped.
 *
 * This is the case that decides the outbox gate needs no wake_check exemption. Without standing the
 * ladder down at its source, every round would be silently swallowed at delivery — `runWakeCheck`
 * ignores the return of `enqueueAndTryFlush`, so a dropped round looks exactly like a delivered one
 * — the ladder would run out, and `escalate` would arm a backup alarm that the same rule then holds.
 * Owner asleep, every safety net quietly removed.
 */

const ZONE = 'Europe/London'
const NOW = Date.parse('2026-09-10T13:30:00Z') // 14:30 London
const FAR_FUTURE = NOW + 365 * 24 * 3_600_000

function meeting(over: Record<string, unknown> = {}) {
  return {
    id: 'evt_sync',
    summary: 'Sync with Sam',
    status: 'confirmed',
    start: { dateTime: '2026-09-10T14:00:00+01:00' },
    end: { dateTime: '2026-09-10T15:00:00+01:00' },
    attendees: [{ email: 'me@example.com' }, { email: 'sam@example.com' }],
    organizer: { self: true },
    ...over,
  }
}

let seq = 0
function readyDevice(withCalendar: boolean): Device {
  const deviceId = `dev_wcc${++seq}`
  makeDevice(deviceId)
  setTimezone(deviceId, ZONE)
  linkWhatsapp(deviceId, `4477009${String(90000 + seq).padStart(5, '0')}`)
  markInbound(deviceId, Date.now() - 2 * 3_600_000)
  if (withCalendar) {
    db.insert(googleAccounts).values({ deviceId, refreshToken: 'rt', updatedAt: Date.now() }).run()
  }
  return getDevice(deviceId)!
}

const wakeJobs = (): Job[] => dueJobs(FAR_FUTURE).filter((j) => j.kind === 'wake_check')

beforeEach(() => {
  ensureSchema()
  db.delete(jobsTable).run()
  db.delete(alarms).run()
  db.delete(alarmEvents).run()
  armed.length = 0
  sends.length = 0
  listEvents.mockReset()
  listEvents.mockResolvedValue({ data: { items: [meeting()] } })
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => vi.useRealTimers())

/** Arm a wake-up alarm, start its ladder from a dismissal, and hand back the round-0 job. */
async function ladderFor(device: Device): Promise<Job> {
  const alarmId = `alm_${device.deviceId}`
  await armAlarm(device, {
    alarmId,
    triggerAtMillis: Date.now() + 3_600_000,
    label: 'Get up',
    wakeCheck: true,
  })
  armed.length = 0
  const dismissedAt = Date.now()
  expect(scheduleWakeCheck(alarmId, device, dismissedAt)).toBe(true)
  return wakeJobs()[0]!
}

describe('a wake-check round that lands inside a commitment', () => {
  it('stands the ladder down instead of asking, and rings no backup alarm', async () => {
    // Sitting in a meeting with other people answers "are you awake?" at least as well as a tapped
    // Done does — which is exactly the argument the lastActivityAt stand-down beside it makes.
    const device = readyDevice(true)
    const job = await ladderFor(device)

    vi.setSystemTime(job.runAtMillis)
    const next = await runWakeCheck(job)

    expect(next).toBeNull()
    expect(sends).toHaveLength(0)
    expect(armed).toHaveLength(0)
  })

  it('puts nothing on the record, because they were never asked', async () => {
    // WAKE_CHECK_FAILED is read straight back to the owner as evidence. Someone in a meeting did not
    // sleep through anything, and the persona forbids accusing them of it.
    const device = readyDevice(true)
    const job = await ladderFor(device)

    vi.setSystemTime(job.runAtMillis)
    await runWakeCheck(job)

    // WAKE_CHECK_STARTED is written by scheduleWakeCheck as a durable latch and is expected here.
    // The two that must not appear are the ones renderRecord reads back as "dismissed and went
    // back to sleep".
    const rows = db.select().from(alarmEvents).where(eq(alarmEvents.deviceId, device.deviceId)).all()
    const accusations = rows.filter(
      (r) => r.event === 'WAKE_CHECK_FAILED' || r.event === 'WAKE_CHECK_UNREACHABLE',
    )
    expect(accusations).toHaveLength(0)
  })

  it('still asks when there is no meeting', async () => {
    const device = readyDevice(true)
    listEvents.mockResolvedValue({ data: { items: [] } })
    const job = await ladderFor(device)

    vi.setSystemTime(job.runAtMillis)
    const next = await runWakeCheck(job)

    expect(next).not.toBeNull()
    expect(sends).toHaveLength(1)
  })

  it('is inert for an owner with no calendar linked at all', async () => {
    const device = readyDevice(false)
    const job = await ladderFor(device)

    vi.setSystemTime(job.runAtMillis)
    const next = await runWakeCheck(job)

    expect(next).not.toBeNull()
    expect(sends).toHaveLength(1)
    expect(listEvents).not.toHaveBeenCalled()
  })
})
