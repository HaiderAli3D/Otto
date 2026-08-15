import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { systemPrompt } from '../src/agent/prompt.js'
import { buildTools, runTool } from '../src/agent/tools/index.js'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { alarms, googleAccounts, jobs } from '../src/db/schema.js'
import { runJob } from '../src/scheduler/loop.js'
import { getAlarm, listArmed } from '../src/services/alarms.js'
import { getDevice, setTimezone, type Device } from '../src/services/devices.js'
import { rememberFact } from '../src/services/facts.js'
import type { CalendarEvent } from '../src/services/google.js'
import {
  computeLeaveByPlan,
  isVirtualLocation,
  leaveByLabel,
  mayArm,
  planLeaveBy,
  resolveOrigin,
  wakeLabel,
} from '../src/services/leaveBy.js'
import { updateSettings } from '../src/services/settings.js'
import { resetTravelBudget } from '../src/services/travel.js'
import { makeDevice } from './helpers.js'

// config.google is null in tests (setup-env.ts sets no GOOGLE_OAUTH_*), and oauthClient() throws on
// that before googleapis is reached. `config` is a plain object; `as const` is compile-time only.
Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

const ZONE = 'Europe/London'
/** Tuesday 4 August 2026, 08:00 in London (BST). Everything below is relative to this instant. */
const NOW = Date.parse('2026-08-04T07:00:00Z')

beforeEach(() => {
  ensureSchema()
  resetTravelBudget()
  listEvents.mockReset()
  db.delete(jobs).run()
  db.delete(alarms).run()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => vi.useRealTimers())

let seq = 0
function makeLondonDevice(): Device {
  const deviceId = `dev_lb${++seq}`
  makeDevice(deviceId)
  setTimezone(deviceId, ZONE)
  db.insert(googleAccounts).values({ deviceId, refreshToken: 'rt', updatedAt: Date.now() }).run()
  return getDevice(deviceId)!
}

function ev(p: Partial<CalendarEvent> & { id: string; startIso: string; endIso: string }): CalendarEvent {
  return {
    summary: 'Standup',
    location: 'The Ship, Wandsworth',
    status: 'confirmed',
    isAllDay: false,
    ...p,
  }
}

/** The default travel estimate in these tests: no Maps key, no buffer fact, so settings' 30. */
const DEFAULT_TRAVEL_MIN = 30

const STANDUP = ev({
  id: 'evt_standup',
  summary: 'Standup',
  startIso: '2026-08-04T12:00:00+01:00',
  endIso: '2026-08-04T13:00:00+01:00',
})

const leaveByJobs = () => db.select().from(jobs).where(eq(jobs.kind, 'leave_by')).all()

describe('guardrails: every reason a leave-by alarm must not ring', () => {
  it('an all-day entry has no time to leave for', async () => {
    const device = makeLondonDevice()
    const plan = await computeLeaveByPlan({
      device,
      event: ev({ id: 'e1', summary: 'Bank holiday', startIso: '2026-08-04', endIso: '2026-08-05', isAllDay: true }),
    })
    expect(plan.blocked).toBe('all-day')
    expect(plan.leaveAtMillis).toBeNull()
  })

  it('an event with no location has nowhere to travel to', async () => {
    const device = makeLondonDevice()
    const plan = await computeLeaveByPlan({ device, event: ev({ ...STANDUP, location: null }) })
    expect(plan.blocked).toBe('no-location')
  })

  it.each([
    'https://meet.google.com/abc-defg-hij',
    'Zoom',
    'Teams',
    // Outlook writes the join link into the location as well, which is what catches the very
    // common "Microsoft Teams Meeting https://teams.microsoft.com/..." — the keyword list is
    // START-anchored, so the URL test is the one doing the work there.
    'Microsoft Teams Meeting https://teams.microsoft.com/l/meetup-join/19%3a',
    'Join Zoom Meeting https://zoom.us/j/123',
    'online',
    'TBD',
  ])('a virtual location (%s) never gets a leave-by alarm', async (location) => {
    const device = makeLondonDevice()
    const plan = await computeLeaveByPlan({ device, event: ev({ ...STANDUP, location }) })
    // By far the most common false positive: a video call is not somewhere you leave for.
    expect(plan.blocked).toBe('virtual')
    expect(plan.leaveAtMillis).toBeNull()
  })

  it('an event more than 36 hours out is too far to price', async () => {
    const device = makeLondonDevice()
    const plan = await computeLeaveByPlan({
      device,
      event: ev({ ...STANDUP, startIso: '2026-08-06T00:00:00+01:00', endIso: '2026-08-06T01:00:00+01:00' }),
    })
    expect(plan.blocked).toBe('too-far-out')
  })

  it('says how late they already are instead of ringing', async () => {
    const device = makeLondonDevice()
    const plan = await computeLeaveByPlan({
      device,
      // 08:20 with a 30-minute journey: the departure was ten minutes before now.
      event: ev({ ...STANDUP, startIso: '2026-08-04T08:20:00+01:00', endIso: '2026-08-04T09:00:00+01:00' }),
    })
    expect(plan.blocked).toBe('past')
    expect(plan.note).toContain('10 minutes ago')
    expect(mayArm(plan, { explicit: true, autoLeaveByAlarm: true })).toBe(false)
  })

  it('a departure inside quiet hours is an offer, never an automatic alarm', async () => {
    const device = makeLondonDevice()
    const plan = await computeLeaveByPlan({
      device,
      event: ev({ ...STANDUP, startIso: '2026-08-04T23:30:00+01:00', endIso: '2026-08-05T00:30:00+01:00' }),
    })
    expect(plan.blocked).toBe('quiet-hours')
    expect(mayArm(plan, { explicit: false, autoLeaveByAlarm: true })).toBe(false)
    // Asking IS consent: the owner who requests this by name gets it.
    expect(mayArm(plan, { explicit: true, autoLeaveByAlarm: false })).toBe(true)
  })

  it('an overrunning earlier event is a conversation, not a ringer', async () => {
    const device = makeLondonDevice()
    const overrunning = ev({
      id: 'evt_1to1',
      summary: '1:1',
      startIso: '2026-08-04T11:00:00+01:00',
      endIso: '2026-08-04T11:45:00+01:00',
      location: 'Room 3',
    })
    const plan = await computeLeaveByPlan({ device, event: STANDUP, events: [overrunning, STANDUP] })
    // Departure is 11:30 and the 1:1 runs to 11:45.
    expect(plan.blocked).toBe('double-booked')
    expect(mayArm(plan, { explicit: false, autoLeaveByAlarm: true })).toBe(false)
  })

  it('an estimated travel time is an offer even with auto-arm switched on', async () => {
    const device = makeLondonDevice()
    updateSettings(device.deviceId, { autoLeaveByAlarm: true })

    const plan = await computeLeaveByPlan({ device, event: STANDUP })

    // No Maps key, so the number came off the ladder. A colleague's invite must never ring the
    // phone at 05:40 on the strength of a guess.
    expect(plan.travelSource).toBe('default')
    expect(plan.estimated).toBe(true)
    expect(plan.blocked).toBe('estimated')
    expect(mayArm(plan, { explicit: false, autoLeaveByAlarm: true })).toBe(false)
    expect(mayArm(plan, { explicit: true, autoLeaveByAlarm: false })).toBe(true)
  })

  it('an unasked-for plan with nothing against it still only arms when the flag is on', async () => {
    const device = makeLondonDevice()
    const plan = await computeLeaveByPlan({ device, event: STANDUP })
    const clean = { ...plan, blocked: null, estimated: false }

    expect(mayArm(clean, { explicit: false, autoLeaveByAlarm: false })).toBe(false)
    expect(mayArm(clean, { explicit: false, autoLeaveByAlarm: true })).toBe(true)
  })
})

describe('determinism: a duplicate alarm is unrepresentable, not merely avoided', () => {
  it('planning the same event twice converges on ONE alarm', async () => {
    const device = makeLondonDevice()

    const first = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const second = await planLeaveBy({ device, event: STANDUP, explicit: true })

    expect(first.armed).toBe(true)
    expect(second.alarmId).toBe(first.alarmId)
    expect(listArmed(device.deviceId)).toHaveLength(1)
    // ...and one recheck, not two: the derived id is what cancelJobs keys on.
    expect(leaveByJobs()).toHaveLength(1)
  })

  it('arms at the departure time, not the event time', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })

    const alarm = getAlarm(plan.alarmId!)!
    expect(alarm.triggerAtMillis).toBe(plan.startMillis! - DEFAULT_TRAVEL_MIN * 60_000)
    expect(alarm.label).toBe('Leave now — Standup, 12:00')
  })

  it('leaves exactly one recheck, 45 minutes before departure', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })

    const [job] = leaveByJobs()
    expect(job!.runAtMillis).toBe(plan.leaveAtMillis! - 45 * 60_000)
    expect(job!.alarmId).toBe(plan.alarmId)
  })
})

describe('waking up as well', () => {
  it('arms two alarms when the get-ready gap is real', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, alsoWakeMe: true, explicit: true })

    expect(plan.mergedWithWake).toBe(false)
    expect(listArmed(device.deviceId)).toHaveLength(2)
    expect(getAlarm(plan.wakeId!)!.label).toBe('Up — leave 11:30 for Standup')
    expect(plan.wakeAtMillis).toBe(plan.leaveAtMillis! - 45 * 60_000)
  })

  it('collapses to ONE alarm when the two would land within twenty minutes', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, alsoWakeMe: true, getReadyMinutes: 15, explicit: true })

    // Two alarms twelve minutes apart is noise. The surviving one carries the leave time.
    expect(plan.mergedWithWake).toBe(true)
    expect(plan.alarmId).toBeNull()
    const armed = listArmed(device.deviceId)
    expect(armed).toHaveLength(1)
    expect(armed[0]!.alarmId).toBe(plan.wakeId)
    expect(armed[0]!.label).toContain('11:30')
  })
})

describe('a get-up alarm is never armed into the past', () => {
  const DENTIST = ev({
    id: 'evt_dentist',
    summary: 'Dentist',
    startIso: '2026-08-04T09:00:00+01:00',
    endIso: '2026-08-04T09:30:00+01:00',
  })

  it('drops the wake half and keeps the departure', async () => {
    const device = makeLondonDevice()

    // "Wake me in time for the 9am dentist", asked at 08:00. The 30-minute journey puts the
    // departure at 08:30, which is fine; 45 minutes of getting ready puts the wake alarm at 07:45,
    // three quarters of an hour ago.
    const plan = await planLeaveBy({ device, event: DENTIST, alsoWakeMe: true, explicit: true })

    expect(plan.leaveAtMillis).toBe(Date.parse('2026-08-04T08:30:00+01:00'))
    expect(plan.wakeAtMillis).toBeNull()
    expect(plan.wakeId).toBeNull()
    // The model is told, so it cannot promise a wake-up that has already been and gone.
    expect(plan.note).toContain('no time for a separate get-up alarm')

    // One row, not two: an alarm armed for a stale trigger is marked MISSED by the app, never
    // reports ARMED, and drives the arm-ack watchdog into three resends and a spurious "I couldn't
    // confirm your alarm reached your phone".
    expect(db.select().from(alarms).where(eq(alarms.deviceId, device.deviceId)).all()).toHaveLength(1)
    expect(listArmed(device.deviceId)[0]!.alarmId).toBe(plan.alarmId)
  })

  it('still arms both when there is genuinely time to get up', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: DENTIST, alsoWakeMe: true, getReadyMinutes: 20, explicit: true })

    // 08:10 is ten minutes away: near, but real. The floor is "already gone", not "soon".
    expect(plan.wakeAtMillis).toBe(Date.parse('2026-08-04T08:10:00+01:00'))
    expect(listArmed(device.deviceId)).toHaveLength(1)
    expect(plan.mergedWithWake).toBe(true)
  })
})

describe('re-planning the same event never leaves an orphan armed', () => {
  it('collapsing into the wake alarm cancels the departure alarm it replaces', async () => {
    const device = makeLondonDevice()
    const first = await planLeaveBy({ device, event: STANDUP, alsoWakeMe: true, explicit: true })
    expect(listArmed(device.deviceId)).toHaveLength(2)

    // "Actually I only need fifteen minutes" — the two alarms now land inside the merge window, so
    // this plan arms only the wake alarm. The 11:30 departure alarm from the first plan is not part
    // of this plan at all, and the tool only ever hands back the id it just armed, so if it is left
    // behind the owner has no way to reach it.
    const second = await planLeaveBy({ device, event: STANDUP, alsoWakeMe: true, getReadyMinutes: 15, explicit: true })

    expect(second.mergedWithWake).toBe(true)
    expect(getAlarm(first.alarmId!)!.state).toBe('CANCELLED')
    expect(listArmed(device.deviceId).map((a) => a.alarmId)).toEqual([second.wakeId])
    // One recheck, not two: cancelling the orphan took its chain with it.
    expect(leaveByJobs()).toHaveLength(1)
    expect(leaveByJobs()[0]!.alarmId).toBe(second.wakeId)
  })

  it('turning the wake alarm off actually turns it off', async () => {
    const device = makeLondonDevice()
    const first = await planLeaveBy({ device, event: STANDUP, alsoWakeMe: true, explicit: true })

    const second = await planLeaveBy({ device, event: STANDUP, alsoWakeMe: false, explicit: true })

    expect(second.wakeId).toBeNull()
    expect(getAlarm(first.wakeId!)!.state).toBe('CANCELLED')
    expect(listArmed(device.deviceId).map((a) => a.alarmId)).toEqual([second.alarmId])
    expect(leaveByJobs()).toHaveLength(1)
  })

  it('cancelling the alarm takes its recheck with it', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    expect(leaveByJobs()).toHaveLength(1)

    await runTool(device, 'cancel_alarm', { alarmId: plan.alarmId })

    // A chain that outlives its alarm is a chain that can re-arm it 45 minutes later.
    expect(getAlarm(plan.alarmId!)!.state).toBe('CANCELLED')
    expect(leaveByJobs()).toHaveLength(0)
  })

  it('hands the recheck to the surviving alarm instead of taking it down with the anchor', async () => {
    // A plan arms TWO alarms and leaves ONE recheck, anchored on the departure. `cancelAlarm` drops
    // `leave_by` jobs keyed on the id being cancelled, so "don't bother with the leave-now alarm,
    // just wake me" destroyed the only thing watching the 07:45 wake alarm as well. The dentist
    // then cancels the appointment overnight and the phone still rings "Up — leave 11:30 for
    // Standup" for a meeting that no longer exists.
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, alsoWakeMe: true, explicit: true })
    expect(plan.mergedWithWake).toBe(false)
    expect(leaveByJobs()[0]!.alarmId).toBe(plan.alarmId)

    await runTool(device, 'cancel_alarm', { alarmId: plan.alarmId })

    expect(getAlarm(plan.alarmId!)!.state).toBe('CANCELLED')
    expect(listArmed(device.deviceId).map((a) => a.alarmId)).toEqual([plan.wakeId])
    // One recheck, still, now anchored on the alarm that is left — which is the case `liveId` in
    // handlers/leaveBy.ts was written for and could not previously be reached from this direction.
    const jobsAfter = leaveByJobs()
    expect(jobsAfter).toHaveLength(1)
    expect(jobsAfter[0]!.alarmId).toBe(plan.wakeId)

    // …and cancelling the last one really does end the chain: nothing is left to guard.
    await runTool(device, 'cancel_alarm', { alarmId: plan.wakeId })
    expect(leaveByJobs()).toHaveLength(0)
  })
})

describe('the model is told what makes live traffic possible', () => {
  it('names the exact fact keys the planner reads by name', () => {
    const device = makeLondonDevice()
    const core = systemPrompt(device)

    // resolveOrigin reads these two keys and estimateTravelMinutes reads the third. Nothing told
    // the model they existed, and with no origin there is no Routes call at all: every plan comes
    // back source:'default', estimated:true, thirty flat minutes, and the whole live-traffic ladder
    // is dead code in production.
    expect(core).toContain('home.address')
    expect(core).toContain('work.address')
    expect(core).toContain('travel.default_buffer')
  })

  it('names them on remember_fact too, which is where the key is chosen', () => {
    const remember = buildTools().find((t) => t.name === 'remember_fact')!
    expect(JSON.stringify(remember.parameters)).toContain('home.address')
  })
})

describe('labels fit a lock screen', () => {
  const long = 'Quarterly all-hands review and roadmap alignment session with the wider platform team'

  it('truncates the summary and never the action', () => {
    const label = leaveByLabel(long, Date.parse('2026-08-04T12:00:00+01:00'), ZONE)
    expect(long.length).toBeGreaterThan(60)
    expect(label.length).toBeLessThanOrEqual(60)
    expect(label.startsWith('Leave now — ')).toBe(true)
    expect(label).toContain('12:00')
  })

  it('keeps the leave time in a long wake label too', () => {
    const label = wakeLabel(long, Date.parse('2026-08-04T07:35:00+01:00'), ZONE)
    expect(label.length).toBeLessThanOrEqual(60)
    expect(label.startsWith('Up — leave 07:35 for ')).toBe(true)
  })
})

describe('origin resolution never guesses', () => {
  const target = { device: null as unknown as Device, targetKey: 'evt_standup', targetStartMillis: Date.parse('2026-08-04T12:00:00+01:00') }

  it('a preceding event with a real location beats the home.address fact', () => {
    const device = makeLondonDevice()
    rememberFact({ deviceId: device.deviceId, key: 'home.address', value: '221B Baker Street, London' })
    const preceding = ev({
      id: 'evt_coffee',
      summary: 'Coffee',
      startIso: '2026-08-04T10:00:00+01:00',
      endIso: '2026-08-04T11:00:00+01:00',
      location: 'Monmouth, Borough Market',
    })

    const origin = resolveOrigin({ ...target, device, events: [preceding, STANDUP] })

    // The only 'high' answer is one drawn from something they actually did.
    expect(origin).toEqual({ address: 'Monmouth, Borough Market', confidence: 'high' })
  })

  it('a VIRTUAL preceding event falls through to the fact', () => {
    const device = makeLondonDevice()
    rememberFact({ deviceId: device.deviceId, key: 'home.address', value: '221B Baker Street, London' })
    const preceding = ev({
      id: 'evt_sync',
      summary: 'Sync',
      startIso: '2026-08-04T10:00:00+01:00',
      endIso: '2026-08-04T11:00:00+01:00',
      location: 'https://meet.google.com/xyz',
    })

    const origin = resolveOrigin({ ...target, device, events: [preceding, STANDUP] })

    expect(origin).toEqual({ address: '221B Baker Street, London', confidence: 'medium' })
  })

  it('an event that ended four hours ago says nothing about where they are now', () => {
    const device = makeLondonDevice()
    const stale = ev({
      id: 'evt_early',
      summary: 'Gym',
      startIso: '2026-08-04T06:00:00+01:00',
      endIso: '2026-08-04T07:00:00+01:00',
      location: 'Clapham Leisure Centre',
    })

    expect(resolveOrigin({ ...target, device, events: [stale, STANDUP] })).toBeNull()
  })

  it('neither a preceding event nor a fact means null, not a guess', () => {
    const device = makeLondonDevice()
    expect(resolveOrigin({ ...target, device, events: [STANDUP] })).toBeNull()
  })

  it('an explicit origin is used verbatim and outranks everything', async () => {
    const device = makeLondonDevice()
    rememberFact({ deviceId: device.deviceId, key: 'home.address', value: '221B Baker Street, London' })

    const plan = await computeLeaveByPlan({ device, event: STANDUP, originAddress: "my mum's in Leeds" })

    // Passed to Routes verbatim and left to geocode. A bad address yields a worse OFFER — it can
    // never produce a wrong alarm, because a failed route degrades to an estimate.
    expect(plan.origin).toEqual({ address: "my mum's in Leeds", confidence: 'high' })
  })
})

describe('isVirtualLocation', () => {
  it.each(['zoom', 'ZOOM', 'meet.google.com/x', 'Teams', 'phone call', 'virtual', 'https://x.test/a', 'tba'])(
    'rejects %s',
    (s) => expect(isVirtualLocation(s)).toBe(true),
  )
  it.each(['The Ship, Wandsworth', 'Room 3', '221B Baker Street', 'The Phone Box, Hackney'])(
    'accepts %s',
    (s) => expect(isVirtualLocation(s)).toBe(false),
  )
  it('is start-anchored, so a place NAMED after one of the words survives', () => {
    // The known cost of that: a location beginning with one of the words is rejected even when it
    // is a real place. Pinned so the trade-off is a decision, not a surprise.
    expect(isVirtualLocation('Phone Box Cafe, Hackney')).toBe(true)
  })
})

describe('the recheck 45 minutes out', () => {
  /** Point the mocked calendar at a fixed list for the next call. */
  const calendarHolds = (items: CalendarEvent[]): void => {
    listEvents.mockResolvedValue({
      data: {
        items: items.map((e) => ({
          id: e.id,
          summary: e.summary,
          location: e.location ?? undefined,
          status: e.status ?? undefined,
          start: e.isAllDay ? { date: e.startIso } : { dateTime: e.startIso },
          end: e.isAllDay ? { date: e.endIso } : { dateTime: e.endIso },
        })),
      },
    })
  }

  it('re-arms the SAME alarm when the event moves, leaving one alarm behind', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const job = leaveByJobs()[0]!

    const moved = ev({ ...STANDUP, startIso: '2026-08-04T13:00:00+01:00', endIso: '2026-08-04T14:00:00+01:00' })
    calendarHolds([moved])
    await runJob(job)

    const armed = listArmed(device.deviceId)
    expect(armed).toHaveLength(1)
    expect(armed[0]!.alarmId).toBe(plan.alarmId)
    expect(armed[0]!.triggerAtMillis).toBe(plan.leaveAtMillis! + 3_600_000)
    // One recheck is enough — the chain ends rather than polling traffic every minute.
    expect(leaveByJobs()).toHaveLength(0)
  })

  it('cancels when the event is gone, and the job goes with it', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const job = leaveByJobs()[0]!

    calendarHolds([])
    await runJob(job)

    expect(getAlarm(plan.alarmId!)!.state).toBe('CANCELLED')
    expect(listArmed(device.deviceId)).toHaveLength(0)
    expect(leaveByJobs()).toHaveLength(0)
  })

  it('cancels a cancelled event too', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const job = leaveByJobs()[0]!

    calendarHolds([ev({ ...STANDUP, status: 'cancelled' })])
    await runJob(job)

    expect(getAlarm(plan.alarmId!)!.state).toBe('CANCELLED')
  })

  it('leaves the alarm alone when the calendar is unreachable', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const job = leaveByJobs()[0]!

    listEvents.mockRejectedValue(new Error('backendError'))
    await runJob(job)

    // A stale "leave now" is an annoyance; cancelling a real departure because Google had a bad
    // minute is the owner missing the thing.
    const armed = listArmed(device.deviceId)
    expect(armed).toHaveLength(1)
    expect(armed[0]!.triggerAtMillis).toBe(plan.leaveAtMillis)
  })

  it('does nothing at all when nothing changed', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const before = getAlarm(plan.alarmId!)!
    const job = leaveByJobs()[0]!

    calendarHolds([STANDUP])
    await runJob(job)

    const after = getAlarm(plan.alarmId!)!
    expect(after.triggerAtMillis).toBe(before.triggerAtMillis)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it('cancels once the event stops being a journey', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const job = leaveByJobs()[0]!

    calendarHolds([ev({ ...STANDUP, location: 'https://meet.google.com/moved-online' })])
    await runJob(job)

    // "Leave now" for something you no longer leave for is wrong in a way a stale time is not.
    expect(getAlarm(plan.alarmId!)!.state).toBe('CANCELLED')
  })

  it('cancels a stale alarm when the meeting moves in front of its own departure', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const job = leaveByJobs()[0]!

    // The 12:00 standup is pulled forward to 08:30, so the departure is now. The alarm we armed is
    // still sitting at 11:30 and would ring three hours after the meeting started, announcing a
    // departure for "Standup, 12:00" that no longer exists.
    calendarHolds([ev({ ...STANDUP, startIso: '2026-08-04T08:30:00+01:00', endIso: '2026-08-04T09:00:00+01:00' })])
    await runJob(job)

    expect(getAlarm(plan.alarmId!)!.state).toBe('CANCELLED')
    expect(listArmed(device.deviceId)).toHaveLength(0)
  })

  it('leaves the alarm strictly alone when the recheck is merely running late', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const job = leaveByJobs()[0]!

    // Nothing moved; this recheck is running at the departure itself, after a restart or a backlog.
    // The armed alarm IS the ring, and cancelling it is the one failure this feature must never
    // produce — which is why the cancel above is gated on the alarm still being ahead of us.
    vi.setSystemTime(plan.leaveAtMillis!)
    calendarHolds([STANDUP])
    await runJob(job)

    expect(getAlarm(plan.alarmId!)!.state).toBe('ARMED')
    expect(getAlarm(plan.alarmId!)!.triggerAtMillis).toBe(plan.leaveAtMillis)
  })

  it('does not unarm a departure the owner asked for just because it is now imminent', async () => {
    // The regression this pins: `blocked: 'past'` also covers a departure merely inside
    // LEAVE_SOON_MS, and a plan armed close to its departure schedules the recheck at now+60s
    // (leaveAt − RECHECK_LEAD_MS is already behind). So the recheck arrives a minute after arming
    // with a perfectly good alarm five minutes out — and the cancel, gated only on "still ahead of
    // now", took it away silently. A real departure, unarmed sixty seconds after being asked for.
    const device = makeLondonDevice()
    // 30 minutes' default travel puts the departure 5.5 minutes out: armable now, inside the
    // soon-window by the time the recheck runs.
    const soon = ev({
      ...STANDUP,
      startIso: '2026-08-04T08:35:30+01:00',
      endIso: '2026-08-04T09:05:30+01:00',
    })
    const plan = await planLeaveBy({ device, event: soon, explicit: true })
    expect(plan.alarmId).not.toBeNull()

    const job = leaveByJobs()[0]!
    vi.setSystemTime(job.runAtMillis)
    calendarHolds([soon])
    await runJob(job)

    expect(getAlarm(plan.alarmId!)!.state).toBe('ARMED')
    expect(listArmed(device.deviceId)).toHaveLength(1)
  })

  it('refuses to resurrect the half of a plan the owner cancelled', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, alsoWakeMe: true, explicit: true })
    const job = leaveByJobs()[0]!

    // Cancel the WAKE alarm only. The recheck is anchored on the departure alarm, so the job
    // survives that cancel and still names the wake id in its payload.
    await runTool(device, 'cancel_alarm', { alarmId: plan.wakeId })

    calendarHolds([ev({ ...STANDUP, startIso: '2026-08-04T13:00:00+01:00', endIso: '2026-08-04T14:00:00+01:00' })])
    await runJob(job)

    expect(getAlarm(plan.wakeId!)!.state).toBe('CANCELLED')
    expect(listArmed(device.deviceId).map((a) => a.alarmId)).toEqual([plan.alarmId])
  })

  it('cannot re-arm a cancelled alarm even if its recheck outlives it', async () => {
    const device = makeLondonDevice()
    const plan = await planLeaveBy({ device, event: STANDUP, explicit: true })
    const job = leaveByJobs()[0]!

    await runTool(device, 'cancel_alarm', { alarmId: plan.alarmId })
    // Cancelling took the chain with it — that is the first line of defence.
    expect(leaveByJobs()).toHaveLength(0)

    // Replay the job anyway, which is what a crash between the two writes would leave behind.
    listEvents.mockClear()
    calendarHolds([ev({ ...STANDUP, startIso: '2026-08-04T13:00:00+01:00', endIso: '2026-08-04T14:00:00+01:00' })])
    await runJob(job)

    expect(getAlarm(plan.alarmId!)!.state).toBe('CANCELLED')
    expect(listArmed(device.deviceId)).toHaveLength(0)
    // ...and it worked that out before spending a calendar read and a billed Routes call on it.
    expect(listEvents).not.toHaveBeenCalled()
  })
})

describe('the create_leave_by_alarm tool', () => {
  const calendarHolds = (items: CalendarEvent[]): void => {
    listEvents.mockResolvedValue({
      data: {
        items: items.map((e) => ({
          id: e.id,
          summary: e.summary,
          location: e.location ?? undefined,
          status: e.status ?? undefined,
          start: e.isAllDay ? { date: e.startIso } : { dateTime: e.startIso },
          end: e.isAllDay ? { date: e.endIso } : { dateTime: e.endIso },
        })),
      },
    })
  }

  it('exists but refuses at CALL time when Google is not linked', async () => {
    // The tool list is a fixed literal array — never conditional on the device — so "not connected"
    // has to be an answer rather than an absence.
    const deviceId = `dev_lb_nolink${++seq}`
    makeDevice(deviceId)
    const device = getDevice(deviceId)!

    expect(await runTool(device, 'create_leave_by_alarm', { eventDescription: 'standup' })).toEqual({
      error: 'calendar not connected',
    })
  })

  it('asks rather than picks when two events could match', async () => {
    const device = makeLondonDevice()
    calendarHolds([
      STANDUP,
      ev({ id: 'evt_standup2', summary: 'Standup', startIso: '2026-08-04T16:00:00+01:00', endIso: '2026-08-04T16:15:00+01:00' }),
    ])

    const res = (await runTool(device, 'create_leave_by_alarm', { eventDescription: 'standup' })) as {
      ambiguous?: unknown[]
    }

    expect(res.ambiguous).toHaveLength(2)
    expect(listArmed(device.deviceId)).toHaveLength(0)
  })

  it('hands back candidates when nothing matches', async () => {
    const device = makeLondonDevice()
    calendarHolds([STANDUP])

    const res = (await runTool(device, 'create_leave_by_alarm', { eventDescription: 'the dentist' })) as {
      error?: string
      candidates?: unknown[]
    }

    expect(res.error).toContain('the dentist')
    expect(res.candidates).toHaveLength(1)
  })

  it('arms on a single match and reports the departure, flagged as an estimate', async () => {
    const device = makeLondonDevice()
    calendarHolds([STANDUP])

    const res = (await runTool(device, 'create_leave_by_alarm', { eventDescription: 'standup' })) as {
      armed: boolean
      estimated: boolean
      leaveAtLocal: string
    }

    expect(res.armed).toBe(true)
    // No Maps key here, so the model MUST be told the number is a fallback rather than traffic.
    expect(res.estimated).toBe(true)
    expect(res.leaveAtLocal).toBe('Tue, 4 Aug 2026, 11:30')
    expect(listArmed(device.deviceId)).toHaveLength(1)
  })
})
