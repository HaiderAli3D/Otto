import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

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

// Partial mock, matching test/nagging-guards.test.ts: signature verification and the inbound parser
// have to stay real or importing the app graph falls over.
const sends = vi.hoisted(() => [] as Array<{ to: string; body: string }>)
const outOfWindow = vi.hoisted(() => ({ value: false }))
vi.mock('../src/services/whatsapp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/whatsapp.js')>()
  return {
    ...actual,
    sendText: vi.fn(async (to: string, body: string) => {
      if (outOfWindow.value) {
        return { ok: false as const, permanent: false, status: 400, metaCode: 131047, outOfWindow: true, body: '' }
      }
      sends.push({ to, body })
      return { ok: true as const }
    }),
  }
})

import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { alarms, googleAccounts, jobs } from '../src/db/schema.js'
import { listArmed } from '../src/services/alarms.js'
import { getDevice, linkWhatsapp, markInbound, setTimezone, type Device } from '../src/services/devices.js'
import { runNudge } from '../src/services/nagging.js'
import { createReminder, getReminder, snoozeReminder } from '../src/services/reminders.js'
import { makeDevice } from './helpers.js'

// config.google is null in tests (setup-env.ts sets no GOOGLE_OAUTH_*), and oauthClient() throws on
// that before googleapis is reached. `config` is a plain object; `as const` is compile-time only.
Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

/**
 * The hard rule: Otto does not speak while the owner is inside a timed calendar commitment.
 *
 * Every case here is about what happens to a rung, never about what the message says. The gate sits
 * BEFORE the atomic claim in `runNudge`, so the property under test throughout is that being held
 * costs no rung — a burned rung inflates the "chased N times" counter the persona cites as its
 * whole evidence, over a message nobody was ever sent.
 */

const ZONE = 'Europe/London'
const at = (localHHMM: string, day = '10'): number => Date.parse(`2026-09-${day}T${localHHMM}:00+01:00`)

/** One raw Google events.list item — the real mapper runs, rather than a test-only CalendarEvent. */
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

/**
 * A device with WhatsApp, a linked calendar and a pinned zone.
 *
 * The number has to be unique per test: `ensureSchema()` creates tables but does not empty them and
 * the outbox is keyed on `waUserId`, so a shared number means one test flushes another's leftovers.
 */
let seq = 0
function readyDevice(): Device {
  const deviceId = `dev_cn${++seq}`
  makeDevice(deviceId)
  setTimezone(deviceId, ZONE)
  linkWhatsapp(deviceId, `4477009${String(70000 + seq).padStart(5, '0')}`)
  markInbound(deviceId)
  db.insert(googleAccounts).values({ deviceId, refreshToken: 'rt', updatedAt: Date.now() }).run()
  return getDevice(deviceId)!
}

const nudgeJobs = (reminderId: string) =>
  db.select().from(jobs).where(eq(jobs.reminderId, reminderId)).all().filter((j) => j.kind === 'nudge')

beforeEach(() => {
  ensureSchema()
  sends.length = 0
  outOfWindow.value = false
  listEvents.mockReset()
  listEvents.mockResolvedValue({ data: { items: [meeting()] } })
  db.delete(alarms).run()
  db.delete(jobs).run()
  vi.useFakeTimers()
})

afterEach(() => vi.useRealTimers())

describe('a rung that lands inside a commitment', () => {
  it('says nothing, burns no rung, and comes back when the meeting ends', async () => {
    vi.setSystemTime(at('13:00'))
    const device = readyDevice()
    const r = await createReminder(device, {
      title: 'send the invoice',
      dueAtMillis: at('14:00'),
      timing: 'trigger',
    })

    vi.setSystemTime(at('14:00'))
    await runNudge(r.reminderId)

    expect(sends).toHaveLength(0)
    const after = getReminder(r.reminderId)!
    expect(after.nagCount).toBe(0)
    expect(after.nextNagAtMillis).toBe(at('15:00'))
    expect(nudgeJobs(r.reminderId).some((j) => j.runAtMillis === at('15:00'))).toBe(true)
  })

  it('holds the rung on the due time the owner picked themselves', async () => {
    // Quiet hours deliberately exempt this instant — the owner named it, so it stands. The
    // commitment gate deliberately does NOT: they named 14:00 before the 14:00 meeting existed, and
    // honouring it now means interrupting the very thing they named it for. Rung 0 of a trigger IS
    // the due instant, so this test is that exemption not carrying over.
    vi.setSystemTime(at('13:00'))
    const device = readyDevice()
    const r = await createReminder(device, { title: 'ring the bank', dueAtMillis: at('14:00'), timing: 'trigger' })
    expect(getReminder(r.reminderId)!.nextNagAtMillis).toBe(at('14:00'))

    vi.setSystemTime(at('14:00'))
    await runNudge(r.reminderId)

    expect(sends).toHaveLength(0)
    expect(getReminder(r.reminderId)!.nagCount).toBe(0)
  })

  it('does not ring the escalation alarm either, opt-in or not', async () => {
    // `escalateWithAlarm` is exempt from quiet hours wholesale, ringing included. It is NOT exempt
    // here: the alarm this would raise is one OTTO raises, and the settled rule holds those. Their
    // own alarms and their leave-by alarms never pass through this module, so they still ring.
    vi.setSystemTime(at('12:00'))
    const device = readyDevice()
    const r = await createReminder(device, {
      title: 'move the car',
      dueAtMillis: at('12:00'),
      timing: 'trigger',
      escalateWithAlarm: true,
    })

    // A shut window and two and a half hours overdue is exactly the state that escalates.
    outOfWindow.value = true
    vi.setSystemTime(at('14:30'))
    await runNudge(r.reminderId)

    expect(listArmed(device.deviceId)).toHaveLength(0)
    expect(getReminder(r.reminderId)!.lastEscalatedAtMillis).toBeNull()
    expect(getReminder(r.reminderId)!.nagCount).toBe(0)
  })

  it('never lets the end of a meeting smuggle a rung past quiet hours', async () => {
    vi.setSystemTime(at('21:00'))
    const device = readyDevice()
    listEvents.mockResolvedValue({
      data: {
        items: [
          meeting({
            summary: 'Dinner with Sam',
            start: { dateTime: '2026-09-10T21:30:00+01:00' },
            end: { dateTime: '2026-09-10T23:00:00+01:00' },
          }),
        ],
      },
    })
    const r = await createReminder(device, { title: 'put the bins out', dueAtMillis: at('21:30'), timing: 'trigger' })

    vi.setSystemTime(at('21:30'))
    await runNudge(r.reminderId)

    // 23:00 is inside the default 22:00-07:00 window, so the resume instant is the window's end.
    expect(sends).toHaveLength(0)
    expect(getReminder(r.reminderId)!.nextNagAtMillis).toBe(at('07:00', '11'))
  })
})

describe('a reminder whose due time fell inside a commitment', () => {
  it('assumes it happened, closes it, and says so exactly once', async () => {
    vi.setSystemTime(at('13:00'))
    const device = readyDevice()
    const r = await createReminder(device, { title: 'see the dentist', dueAtMillis: at('14:00'), timing: 'trigger' })

    vi.setSystemTime(at('14:00'))
    await runNudge(r.reminderId)
    expect(sends).toHaveLength(0)

    vi.setSystemTime(at('15:00'))
    await runNudge(r.reminderId)

    const after = getReminder(r.reminderId)!
    expect(after.state).toBe('DONE')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.body).toContain('see the dentist')
    expect(sends[0]!.body).toContain('Sync with Sam')

    // Stamped to the completion's OWN instant. services/signals.ts counts the record off
    // completedAtMillis, and equality is what excludes an assumption from it.
    expect(after.assumedAttendedAtMillis).toBe(after.completedAtMillis)

    // Asked ONCE. The reminder is DONE, so a later rung returns at the top of runNudge.
    await runNudge(r.reminderId)
    expect(sends).toHaveLength(1)
  })

  it('rolls a recurring one forward instead of ending the series', async () => {
    vi.setSystemTime(at('13:00'))
    const device = readyDevice()
    const r = await createReminder(device, {
      title: 'the standup',
      dueAtMillis: at('14:00'),
      timing: 'trigger',
      recurrence: 'FREQ=DAILY',
    })

    vi.setSystemTime(at('14:00'))
    await runNudge(r.reminderId)
    vi.setSystemTime(at('15:00'))
    await runNudge(r.reminderId)

    // completeReminder does this, which is exactly why the close goes through it rather than
    // writing state directly: a hand-rolled DONE would end a daily series for ever.
    const after = getReminder(r.reminderId)!
    expect(after.state).toBe('OPEN')
    expect(after.dueAtMillis).toBe(at('14:00', '11'))
    expect(sends).toHaveLength(1)
  })

  it('does not close something the owner explicitly snoozed', async () => {
    // A snooze pushes the due rung later without touching nagCount, so on its own it satisfies
    // every other condition the check-in tests. Closing a task the owner has just said "later" to
    // would lose it silently — the deferral instant has to be the one this gate wrote.
    vi.setSystemTime(at('13:00'))
    const device = readyDevice()
    const r = await createReminder(device, { title: 'chase the invoice', dueAtMillis: at('14:00'), timing: 'trigger' })

    vi.setSystemTime(at('14:00'))
    await runNudge(r.reminderId)
    expect(getReminder(r.reminderId)!.nextNagAtMillis).toBe(at('15:00'))

    // The owner comes out of the meeting and pushes it to four.
    snoozeReminder(r.reminderId, at('16:00'))

    vi.setSystemTime(at('16:00'))
    await runNudge(r.reminderId)

    const after = getReminder(r.reminderId)!
    expect(after.state).toBe('OPEN')
    expect(after.assumedAttendedAtMillis).toBeNull()
    expect(sends).toHaveLength(1)
    expect(sends[0]!.body).toContain('chase the invoice')
  })

  it('goes back to an ordinary nudge if the meeting was cancelled in the meantime', async () => {
    // The calendar is re-read at the deferred instant rather than remembered from the hold, on the
    // leave-by recheck's argument: if the dinner was called off, nothing was attended and assuming
    // otherwise would silently close a real task.
    vi.setSystemTime(at('13:00'))
    const device = readyDevice()
    const r = await createReminder(device, { title: 'call the plumber', dueAtMillis: at('14:00'), timing: 'trigger' })

    vi.setSystemTime(at('14:00'))
    await runNudge(r.reminderId)
    expect(sends).toHaveLength(0)

    listEvents.mockResolvedValue({ data: { items: [] } })
    vi.setSystemTime(at('15:00'))
    await runNudge(r.reminderId)

    const after = getReminder(r.reminderId)!
    expect(after.state).toBe('OPEN')
    expect(after.assumedAttendedAtMillis).toBeNull()
    expect(sends).toHaveLength(1)
    expect(sends[0]!.body).toContain('call the plumber')
    expect(after.nagCount).toBe(1)
  })
})
