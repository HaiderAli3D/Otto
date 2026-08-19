import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

// googleapis is the whole integration, so it is the whole mock — the same block google-events.test.ts
// uses, widened to the three methods the editing tools reach for. The assertions below are about
// what this repo does with Google's shapes, never about Google.
const listEvents = vi.hoisted(() => vi.fn())
const deleteEvent = vi.hoisted(() => vi.fn())
const patchEvent = vi.hoisted(() => vi.fn())
const insertEvent = vi.hoisted(() => vi.fn())
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(): void {}
      },
    },
    calendar: () => ({
      events: { list: listEvents, delete: deleteEvent, patch: patchEvent, insert: insertEvent },
    }),
    tasks: () => ({ tasks: { insert: vi.fn() } }),
  },
}))

import { runTool } from '../src/agent/tools.js'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { googleAccounts, outbox } from '../src/db/schema.js'
import { leaveByAlarmId, wakeAlarmId } from '../src/lib/ids.js'
import { armAlarm, getAlarm } from '../src/services/alarms.js'
import { linkWhatsapp, setTimezone, getDevice } from '../src/services/devices.js'
import { localDateKey } from '../src/services/time.js'
import { makeDevice } from './helpers.js'

// setup-env.ts sets no GOOGLE_OAUTH_* vars, so config.google is null and oauthClient() throws before
// googleapis is ever reached. `config` is a plain object — `as const` is compile-time only.
Object.assign(config as unknown as Record<string, unknown>, {
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:3000/oauth/google/callback' },
})

const ZONE = 'Europe/London'

function linkGoogle(deviceId: string): void {
  db.insert(googleAccounts)
    .values({ deviceId, refreshToken: 'refresh-token', updatedAt: Date.now() })
    .onConflictDoUpdate({ target: googleAccounts.deviceId, set: { refreshToken: 'refresh-token' } })
    .run()
}

/** A device with a linked Google account and a pinned zone, since every ISO here is London-local. */
function ready(id: string) {
  makeDevice(id)
  setTimezone(id, ZONE)
  linkGoogle(id)
  return getDevice(id)!
}

/** One Google events.list item. Only the fields a test actually varies are parameters. */
function item(over: Record<string, unknown> = {}) {
  return {
    id: 'evt_dentist',
    summary: 'Dentist',
    status: 'confirmed',
    location: '5 High Street',
    start: { dateTime: '2026-09-10T15:00:00+01:00' },
    end: { dateTime: '2026-09-10T15:30:00+01:00' },
    ...over,
  }
}

const ON_THE_DAY = { eventDescription: 'dentist', eventStartLocalISO: '2026-09-10T15:00:00' }

beforeEach(() => {
  ensureSchema()
  listEvents.mockReset()
  deleteEvent.mockReset()
  patchEvent.mockReset()
  insertEvent.mockReset()
  deleteEvent.mockResolvedValue({ data: {} })
})

describe('delete_calendar_event resolves before it removes', () => {
  it('deletes the single clear match and hands back enough to put it back', async () => {
    const device = ready('dev_cd1')
    listEvents.mockResolvedValue({ data: { items: [item()] } })

    const res = (await runTool(device, 'delete_calendar_event', ON_THE_DAY)) as Record<string, unknown>

    expect(deleteEvent).toHaveBeenCalledTimes(1)
    // sendUpdates is asserted, not assumed. Google's alternative is emailing every attendee a
    // cancellation notice off the back of one WhatsApp message, and it is the single consequence
    // here that cannot be taken back.
    expect(deleteEvent.mock.calls[0]![0]).toEqual({
      calendarId: 'primary',
      eventId: 'evt_dentist',
      sendUpdates: 'none',
    })
    expect(res.deleted).toBe(true)
    expect(res.summary).toBe('Dentist')
    // There is no undelete in the Calendar API, so this IS the undo: every field
    // create_calendar_event needs, handed back in the result, which is re-sent on every later turn.
    expect(res.restoreWith).toEqual({
      title: 'Dentist',
      startLocalISO: '2026-09-10T15:00:00+01:00',
      endLocalISO: '2026-09-10T15:30:00+01:00',
      location: '5 High Street',
    })
  })

  it('asks which one rather than picking, and deletes nothing while it asks', async () => {
    const device = ready('dev_cd2')
    listEvents.mockResolvedValue({
      data: {
        items: [
          item({ id: 'evt_a', summary: 'Standup', start: { dateTime: '2026-09-10T09:00:00+01:00' }, end: { dateTime: '2026-09-10T09:15:00+01:00' } }),
          item({ id: 'evt_b', summary: 'Standup with design', start: { dateTime: '2026-09-10T14:00:00+01:00' }, end: { dateTime: '2026-09-10T14:15:00+01:00' } }),
        ],
      },
    })

    // No eventStartLocalISO on purpose. Supplying one within 90 minutes of exactly one candidate
    // would SETTLE the tie, which is the matcher working as designed — the case worth pinning is the
    // one where the owner's words genuinely do not pick between two events.
    const res = (await runTool(device, 'delete_calendar_event', {
      eventDescription: 'standup',
    })) as { ambiguous?: Array<Record<string, unknown>> }

    // The whole point of the ladder: confidently cancelling the wrong standup is worse than one
    // extra question, and unlike a wrongly-armed alarm it cannot be noticed afterwards.
    expect(deleteEvent).not.toHaveBeenCalled()
    expect(res.ambiguous).toHaveLength(2)
    // Each candidate carries its id, which the leave-by candidate view deliberately omits. That tool
    // re-matches on the description next turn; here the follow-up IS "the second one", and it has to
    // land on exactly that event instead of running the same fuzzy match and tying again.
    expect(res.ambiguous!.map((c) => c.eventId)).toEqual(['evt_a', 'evt_b'])
  })

  it('refuses an event whose id never came from Google', async () => {
    const device = ready('dev_cd3')
    // `eventKeyOf` falls back to the SUMMARY when Google gave no id, and matchEvents is happy to
    // return such a row. Sending a title to events.delete earns a 404, which this code would read as
    // "already gone" — so Otto would report a meeting cancelled that is still sitting there.
    listEvents.mockResolvedValue({ data: { items: [item({ id: undefined })] } })

    const res = (await runTool(device, 'delete_calendar_event', ON_THE_DAY)) as { error?: string }

    expect(deleteEvent).not.toHaveBeenCalled()
    expect(res.error).toMatch(/no id/i)
  })

  it('will not treat an empty description as "the only thing on that day"', async () => {
    const device = ready('dev_cd4')
    // matchEvents reads an empty needle as "everything in the window". Harmless for a tool that asks
    // when it sees more than one — but on a day holding exactly one event that is a single confident
    // match and a deletion nobody asked for.
    listEvents.mockResolvedValue({ data: { items: [item()] } })

    const res = (await runTool(device, 'delete_calendar_event', { eventDescription: '   ' })) as { error?: string }

    expect(deleteEvent).not.toHaveBeenCalled()
    expect(listEvents).not.toHaveBeenCalled()
    expect(res.error).toMatch(/which event/i)
  })

  it('reports an already-deleted event as already gone, never as a cancellation it performed', async () => {
    const device = ready('dev_cd5')
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    deleteEvent.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 410 }))

    const res = (await runTool(device, 'delete_calendar_event', ON_THE_DAY)) as Record<string, unknown>

    // "I've cancelled it" and "that was already gone" are different sentences to say to someone, and
    // the race is real: resolved from a listing, written to a moment later, phone in their pocket.
    expect(res.deleted).toBe(false)
    expect(res.alreadyGone).toBe(true)
  })

  it('does not read a Google outage as an event that was already gone', async () => {
    const device = ready('dev_cd6')
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    deleteEvent.mockRejectedValue(Object.assign(new Error('backendError'), { code: 503 }))

    // The runner turns a throw into { error }. What must never happen is a 503 being reported as a
    // successful removal, or as "already off your calendar".
    await expect(runTool(device, 'delete_calendar_event', ON_THE_DAY)).rejects.toThrow(/backendError/)
  })

  it('asks which occurrence before touching a repeating event', async () => {
    const device = ready('dev_cd7')
    listEvents.mockResolvedValue({
      data: { items: [item({ id: 'base_20260910T140000Z', summary: 'Standup', recurringEventId: 'base' })] },
    })

    const res = (await runTool(device, 'delete_calendar_event', {
      eventDescription: 'standup',
      eventStartLocalISO: '2026-09-10T15:00:00',
    })) as Record<string, unknown>

    // "Cancel my standup" is as likely to mean today's as all of them, and the two are not equally
    // recoverable — one occurrence can be recreated, a deleted series cannot be put back at all.
    expect(deleteEvent).not.toHaveBeenCalled()
    expect(res.needsScope).toBe(true)
  })

  it('deletes the instance for scope "this" and the series for scope "series"', async () => {
    const device = ready('dev_cd8')
    listEvents.mockResolvedValue({
      data: { items: [item({ id: 'base_20260910T140000Z', summary: 'Standup', recurringEventId: 'base' })] },
    })
    const args = { eventDescription: 'standup', eventStartLocalISO: '2026-09-10T15:00:00' }

    const one = (await runTool(device, 'delete_calendar_event', { ...args, scope: 'this' })) as Record<string, unknown>
    expect(deleteEvent.mock.calls[0]![0].eventId).toBe('base_20260910T140000Z')
    expect(one.occurrenceOnly).toBe(true)

    const all = (await runTool(device, 'delete_calendar_event', { ...args, scope: 'series' })) as Record<string, unknown>
    expect(deleteEvent.mock.calls[1]![0].eventId).toBe('base')
    expect(all.seriesDeleted).toBe(true)
    // Nothing to restore with: re-inserting produces a standalone event, not a series member, so
    // offering an undo that cannot work is worse than admitting there is none.
    expect(all.restoreWith).toBeUndefined()
  })

  it('says when other people were on it, because their copy went too', async () => {
    const device = ready('dev_cd9')
    listEvents.mockResolvedValue({
      data: { items: [item({ summary: 'Sprint review', attendees: [{ self: true }, { email: 'sam@example.invalid' }] })] },
    })

    const res = (await runTool(device, 'delete_calendar_event', {
      eventDescription: 'sprint review',
      eventStartLocalISO: '2026-09-10T15:00:00',
    })) as Record<string, unknown>

    expect(res.deleted).toBe(true)
    expect(res.otherPeopleOnIt).toBe(true)
    expect(String(res.note)).toMatch(/nobody was emailed/i)
  })

  it('refuses an entry Google generates rather than one the owner made', async () => {
    const device = ready('dev_cd10')
    listEvents.mockResolvedValue({
      data: {
        items: [item({ summary: "Sam's birthday", eventType: 'birthday', start: { date: '2026-09-10' }, end: { date: '2026-09-11' } })],
      },
    })

    const res = (await runTool(device, 'delete_calendar_event', {
      eventDescription: 'birthday',
      eventStartLocalISO: '2026-09-10T00:00:00',
    })) as { error?: string }

    expect(deleteEvent).not.toHaveBeenCalled()
    expect(res.error).toMatch(/birthday/i)
  })

  it('queues the reconnect link when the grant was revoked mid-delete', async () => {
    const device = ready('dev_cd11')
    linkWhatsapp(device.deviceId, '447700900010')
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    deleteEvent.mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.'))

    // Until noteRevokedGrant was extracted, only READING the calendar could notice a revoked grant.
    // A delete that failed for the same reason failed silently and forever, with the one way back
    // never sent.
    await expect(runTool(device, 'delete_calendar_event', ON_THE_DAY)).rejects.toThrow(/invalid_grant/)
    const queued = db.select().from(outbox).all().filter((o) => o.deviceId === device.deviceId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.body).toContain('/oauth/google/start?deviceId=')
  })

  it('does not report "no such event" off a window it could only half see', async () => {
    const device = ready('dev_cd12')
    // maxResults is 50 and there is deliberately no pagination. A full page means there was probably
    // more, and "you have no dentist appointment" is the wrong thing to say about one we could not see.
    listEvents.mockResolvedValue({
      data: { items: Array.from({ length: 50 }, (_, i) => item({ id: `evt_${i}`, summary: `Thing ${i}` })) },
    })

    const res = (await runTool(device, 'delete_calendar_event', ON_THE_DAY)) as { error?: string }

    expect(deleteEvent).not.toHaveBeenCalled()
    expect(res.error).toMatch(/too full/i)
  })

  it('cancels the leave-by alarm rather than letting it ring for a deleted event', async () => {
    const device = ready('dev_cd13')
    const startMillis = Date.parse('2026-09-10T14:00:00Z')
    const dayKey = localDateKey(startMillis, ZONE)
    const leaveId = leaveByAlarmId(device.deviceId, 'evt_dentist', dayKey)
    const wakeId = wakeAlarmId(device.deviceId, 'evt_dentist', dayKey)
    await armAlarm(device, { alarmId: leaveId, triggerAtMillis: startMillis - 1_800_000, label: 'Leave for Dentist' })
    await armAlarm(device, { alarmId: wakeId, triggerAtMillis: startMillis - 5_400_000, label: 'Get up for Dentist' })
    listEvents.mockResolvedValue({ data: { items: [item()] } })

    const res = (await runTool(device, 'delete_calendar_event', ON_THE_DAY)) as Record<string, unknown>

    // The recheck runs exactly ONCE, 45 minutes before departure. Delete the event after that and
    // nothing else ever looks: the phone rings at full volume, over the lockscreen, to send them
    // somewhere they are no longer going. The ids are derived, so this needs no lookup table.
    expect(getAlarm(leaveId)!.state).toBe('CANCELLED')
    expect(getAlarm(wakeId)!.state).toBe('CANCELLED')
    expect(res.leaveByAlarmsCancelled).toBe(2)
  })

  it('answers "calendar not connected" without touching Google', async () => {
    const device = makeDevice('dev_cd14')

    expect(await runTool(device, 'delete_calendar_event', ON_THE_DAY)).toEqual({ error: 'calendar not connected' })
    expect(listEvents).not.toHaveBeenCalled()
  })
})

describe('update_calendar_event patches, and never replaces', () => {
  const patched = (over: Record<string, unknown> = {}) => ({ data: item(over) })

  it('sends a patch carrying only the fields that changed', async () => {
    const device = ready('dev_cu1')
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    patchEvent.mockResolvedValue(patched({ summary: 'Dental review' }))

    await runTool(device, 'update_calendar_event', { ...ON_THE_DAY, newTitle: 'Dental review' })

    const body = patchEvent.mock.calls[0]![0].requestBody
    // events.update replaces the WHOLE resource, so a rename through it would silently drop the
    // attendees, the description and the conference link — none of which appear in CalendarEvent,
    // which is exactly why nobody would ever notice.
    expect(body).toEqual({ summary: 'Dental review' })
    expect(body.start).toBeUndefined()
    expect(body.end).toBeUndefined()
  })

  it('slides the end when only the start moves, so the meeting keeps its length', async () => {
    const device = ready('dev_cu2')
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    patchEvent.mockResolvedValue(
      patched({ start: { dateTime: '2026-09-10T16:00:00+01:00' }, end: { dateTime: '2026-09-10T16:30:00+01:00' } }),
    )

    const res = (await runTool(device, 'update_calendar_event', {
      ...ON_THE_DAY,
      newStartLocalISO: '2026-09-10T16:00:00',
    })) as Record<string, unknown>

    // Not merely surprising if we did not: a 15:00-15:30 event restarted at 16:00 with its old end
    // is negative-length, which Google rejects outright.
    const body = patchEvent.mock.calls[0]![0].requestBody
    expect(body.start.dateTime).toBe('2026-09-10T16:00:00')
    expect(body.end.dateTime).toBe('2026-09-10T16:30:00')
    expect(res.durationKept).toBe(true)
    expect(res.movedFromLocal).toBeTruthy()
  })

  it('refuses to give an all-day entry a start time', async () => {
    const device = ready('dev_cu3')
    listEvents.mockResolvedValue({
      data: { items: [item({ summary: 'Annual leave', start: { date: '2026-09-10' }, end: { date: '2026-09-11' } })] },
    })

    const res = (await runTool(device, 'update_calendar_event', {
      eventDescription: 'annual leave',
      eventStartLocalISO: '2026-09-10T00:00:00',
      newStartLocalISO: '2026-09-10T09:00:00',
    })) as { error?: string }

    // Patching a dateTime in beside a live `date` is rejected by Google with a message no owner
    // should ever have to read.
    expect(patchEvent).not.toHaveBeenCalled()
    expect(res.error).toMatch(/all-day/i)
  })

  it('rejects an offset-bearing time with the field named, before any network call', async () => {
    const device = ready('dev_cu4')
    listEvents.mockResolvedValue({ data: { items: [item()] } })

    const res = (await runTool(device, 'update_calendar_event', {
      ...ON_THE_DAY,
      newStartLocalISO: '2026-09-10T16:00:00+01:00',
    })) as { error?: string }

    expect(patchEvent).not.toHaveBeenCalled()
    expect(res.error).toMatch(/offset/i)
  })

  it('needs something to change', async () => {
    const device = ready('dev_cu5')

    const res = (await runTool(device, 'update_calendar_event', ON_THE_DAY)) as { error?: string }

    expect(listEvents).not.toHaveBeenCalled()
    expect(res.error).toMatch(/at least one of/i)
  })

  it('retires the leave-by alarm when the time moves, and does not quietly re-arm one', async () => {
    const device = ready('dev_cu6')
    const startMillis = Date.parse('2026-09-10T14:00:00Z')
    const leaveId = leaveByAlarmId(device.deviceId, 'evt_dentist', localDateKey(startMillis, ZONE))
    await armAlarm(device, { alarmId: leaveId, triggerAtMillis: startMillis - 1_800_000, label: 'Leave for Dentist' })
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    patchEvent.mockResolvedValue(
      patched({ start: { dateTime: '2026-09-10T18:00:00+01:00' }, end: { dateTime: '2026-09-10T18:30:00+01:00' } }),
    )

    const res = (await runTool(device, 'update_calendar_event', {
      ...ON_THE_DAY,
      newStartLocalISO: '2026-09-10T18:00:00',
    })) as Record<string, unknown>

    // A priced journey is wrong the moment the time changes. Arming a replacement unasked would
    // break the rule that no leave-by alarm exists except on an explicit call, so the stale one goes
    // and Otto is told to offer.
    expect(getAlarm(leaveId)!.state).toBe('CANCELLED')
    expect(res.leaveByAlarmsCancelled).toBe(1)
    expect(String(res.note)).toMatch(/offer/i)
  })

  it('leaves the alarm alone for a rename, which changes nothing about the journey', async () => {
    const device = ready('dev_cu7')
    const startMillis = Date.parse('2026-09-10T14:00:00Z')
    const leaveId = leaveByAlarmId(device.deviceId, 'evt_dentist', localDateKey(startMillis, ZONE))
    await armAlarm(device, { alarmId: leaveId, triggerAtMillis: startMillis - 1_800_000, label: 'Leave for Dentist' })
    listEvents.mockResolvedValue({ data: { items: [item()] } })
    patchEvent.mockResolvedValue(patched({ summary: 'Dental review' }))

    const res = (await runTool(device, 'update_calendar_event', { ...ON_THE_DAY, newTitle: 'Dental review' })) as Record<string, unknown>

    expect(getAlarm(leaveId)!.state).toBe('ARMED')
    expect(res.leaveByAlarmsCancelled).toBeUndefined()
  })

  it('says plainly when the event belongs to whoever organised it', async () => {
    const device = ready('dev_cu8')
    listEvents.mockResolvedValue({ data: { items: [item({ summary: 'All hands', organizer: { self: false } })] } })
    patchEvent.mockRejectedValue(Object.assign(new Error('forbiddenForNonOrganizer'), { code: 403 }))

    const res = (await runTool(device, 'update_calendar_event', {
      eventDescription: 'all hands',
      eventStartLocalISO: '2026-09-10T15:00:00',
      newStartLocalISO: '2026-09-10T16:00:00',
    })) as { error?: string }

    expect(res.error).toMatch(/organised it/i)
  })
})
