import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_HEADERS, makeApp, makeDevice } from './helpers.js'

// Capture FCM sends instead of hitting Google. vi.hoisted so the mock factory can reference it.
const sent = vi.hoisted(() => [] as Array<{ token: string; data: Record<string, string> }>)
vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async (token: string, data: Record<string, string>) => {
    sent.push({ token, data })
    return { ok: true as const }
  }),
}))

import { computeSig } from '../src/fcm/signer.js'
import { db } from '../src/db/client.js'
import { jobs } from '../src/db/schema.js'
import { armAlarm, getAlarm } from '../src/services/alarms.js'
import { scheduleBriefChain } from '../src/services/brief.js'
import { linkWhatsapp } from '../src/services/devices.js'
import { pendingFor } from '../src/services/outbox.js'
import { getDevice, setTimezone } from '../src/services/devices.js'
import { dueJobs } from '../src/services/jobs.js'
import { and, eq } from 'drizzle-orm'

const briefJob = (deviceId: string) =>
  db.select().from(jobs).where(and(eq(jobs.kind, 'brief'), eq(jobs.deviceId, deviceId))).all()

/** Let fire-and-forget sends settle before asserting on the capture array. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

function expectValidSig(data: Record<string, string>, secret: string): void {
  const { sig, ...rest } = data
  expect(sig).toBe(computeSig(rest, secret))
}

beforeEach(() => {
  sent.length = 0
})

describe('what the phone says about its own health', () => {
  /**
   * The app has been reporting `notificationsEnabled` and `mutedChannels` on every heartbeat for two
   * releases and the route's zod schema stripped them, so it was paying to compute a signal nothing
   * read. `exactAlarmsPermitted` is the one that matters most and did not exist: `registerWithOs`
   * refuses an alarm silently when the grant is gone, and from the server an alarm the OS refused
   * looks exactly like one that is set.
   */
  const beat = async (
    app: Awaited<ReturnType<typeof makeApp>>,
    deviceId: string,
    health: Record<string, unknown>,
  ) =>
    app.inject({
      method: 'POST',
      url: `/devices/${deviceId}/heartbeat`,
      payload: { appVersion: '1.3.0', atMillis: Date.now(), ...health },
    })

  const warnings = (waUserId: string) =>
    pendingFor(waUserId).filter((r) => r.kind === 'system_warning')

  it('tells the owner when the phone can no longer set an exact alarm', async () => {
    const app = await makeApp()
    makeDevice('dev_h1')
    linkWhatsapp('dev_h1', '447700900801')

    expect((await beat(app, 'dev_h1', { exactAlarmsPermitted: false })).statusCode).toBe(204)

    const rows = warnings('447700900801')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toContain('exact alarms')
  })

  it('says it once a day, however often the heartbeat runs', async () => {
    // The heartbeat runs constantly and a broken grant does not heal on its own, so without the
    // dedupe key this would be a message every fifteen minutes about a thing they already know.
    const app = await makeApp()
    makeDevice('dev_h2')
    linkWhatsapp('dev_h2', '447700900802')

    for (let i = 0; i < 4; i++) await beat(app, 'dev_h2', { exactAlarmsPermitted: false })

    expect(warnings('447700900802')).toHaveLength(1)
  })

  it('says nothing when the app is too old to report it', async () => {
    // `undefined` is an older build, not a broken one. Warning here would reach every owner who has
    // not updated — the false alarm that teaches someone to ignore the channel.
    const app = await makeApp()
    makeDevice('dev_h3')
    linkWhatsapp('dev_h3', '447700900803')

    await beat(app, 'dev_h3', {})

    expect(warnings('447700900803')).toHaveLength(0)
  })

  it('says nothing when everything is fine', async () => {
    const app = await makeApp()
    makeDevice('dev_h4')
    linkWhatsapp('dev_h4', '447700900804')

    await beat(app, 'dev_h4', { exactAlarmsPermitted: true, notificationsEnabled: true, mutedChannels: [] })

    expect(warnings('447700900804')).toHaveLength(0)
  })

  it('says nothing about muted channels or switched-off notifications', async () => {
    // Both mattered while the phone carried chases. It does not — Otto speaks over WhatsApp and the
    // app is an alarm device — so warning about them would be Otto complaining about a setting that
    // no longer affects him. That is the false alarm that teaches someone to ignore the channel the
    // exact-alarm warning needs. Still accepted at the route and still logged; just not said.
    const app = await makeApp()
    makeDevice('dev_h5')
    linkWhatsapp('dev_h5', '447700900805')

    const res = await beat(app, 'dev_h5', { notificationsEnabled: false, mutedChannels: ['otto_nudge_low'] })

    expect(res.statusCode).toBe(204)
    expect(warnings('447700900805')).toHaveLength(0)
  })

  it('still warns about exact alarms, because the app still rings them', async () => {
    const app = await makeApp()
    makeDevice('dev_h6')
    linkWhatsapp('dev_h6', '447700900806')

    await beat(app, 'dev_h6', { exactAlarmsPermitted: false, notificationsEnabled: false })

    const bodies = warnings('447700900806').map((r) => r.body)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('exact alarms')
  })
})

describe('which device events count as the owner being awake', () => {
  /**
   * `lastActivityAt` has exactly one consumer — the wake-check stand-down — and the app's NUDGE
   * vocabulary is mostly not the owner. The sharpest form was self-inflicted: the ladder's own
   * "You up?" is delivered as a push, the phone posts it and reports SHOWN, and the next round
   * reads that as the answer. Nobody wakes them, and no record row says anything went wrong.
   */
  const postEvent = async (app: Awaited<ReturnType<typeof makeApp>>, deviceId: string, event: string) =>
    app.inject({
      method: 'POST',
      url: `/devices/${deviceId}/events`,
      payload: { deviceId, kind: 'NUDGE', refId: 'rem_x', event, atMillis: Date.now() },
    })

  it('ignores the machine-generated ones', async () => {
    const app = await makeApp()
    makeDevice('dev_ev1')
    for (const event of ['SHOWN', 'EXPIRED']) {
      const res = await postEvent(app, 'dev_ev1', event)
      expect(res.statusCode).toBe(204)
      expect(getDevice('dev_ev1')?.lastActivityAt).toBeNull()
    }
  })

  it('ignores a bare DISMISSED, which the app also sends for a withdrawal Otto asked for', async () => {
    const app = await makeApp()
    makeDevice('dev_ev2')
    expect((await postEvent(app, 'dev_ev2', 'DISMISSED')).statusCode).toBe(204)
    expect(getDevice('dev_ev2')?.lastActivityAt).toBeNull()
  })

  it('counts a tap', async () => {
    const app = await makeApp()
    makeDevice('dev_ev3')
    expect((await postEvent(app, 'dev_ev3', 'DEFERRED')).statusCode).toBe(204)
    expect(getDevice('dev_ev3')?.lastActivityAt).not.toBeNull()
  })

  it('never moves the column backwards, however late a report drains', async () => {
    // The app drains an append-only outbox with retries, so reports arrive out of order. A tap from
    // yesterday landing after one from this morning would hand the ladder a stand-down instant
    // older than the dismissal it is checking on.
    const app = await makeApp()
    makeDevice('dev_ev4')
    const now = Date.now()
    await app.inject({
      method: 'POST',
      url: '/devices/dev_ev4/events',
      payload: { deviceId: 'dev_ev4', kind: 'NUDGE', refId: 'rem_x', event: 'DONE', atMillis: now },
    })
    await app.inject({
      method: 'POST',
      url: '/devices/dev_ev4/events',
      payload: { deviceId: 'dev_ev4', kind: 'NUDGE', refId: 'rem_x', event: 'DONE', atMillis: now - 86_400_000 },
    })
    expect(getDevice('dev_ev4')?.lastActivityAt).toBe(now)
  })
})

describe('timezone ingestion', () => {
  it('token registration stores a valid IANA zone', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev_tz1/token',
      payload: { token: 't1', appVersion: '1.0.0', timezone: 'Europe/London' },
    })
    expect(res.statusCode).toBe(204)
    expect(getDevice('dev_tz1')?.timezone).toBe('Europe/London')
  })

  it('heartbeat stores a valid IANA zone', async () => {
    const app = await makeApp()
    makeDevice('dev_tz2')
    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev_tz2/heartbeat',
      payload: { appVersion: '1.0.0', atMillis: 123, timezone: 'America/New_York' },
    })
    expect(res.statusCode).toBe(204)
    expect(getDevice('dev_tz2')?.timezone).toBe('America/New_York')
  })

  it('moves the standing brief chain when the zone actually changes', async () => {
    // The pending row holds an absolute instant computed in the OLD zone, and `slotForRunAt` matches
    // it back against the configured boundary by a round trip through luxon — so left alone it stops
    // being a boundary in the new zone, reads as null, and the brief is skipped for the day.
    const app = await makeApp()
    const device = makeDevice('dev_tz4')
    scheduleBriefChain(device, Date.now())
    const before = briefJob('dev_tz4')[0]!

    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev_tz4/heartbeat',
      payload: { appVersion: '1.0.0', atMillis: 123, timezone: 'America/New_York' },
    })

    expect(res.statusCode).toBe(204)
    expect(briefJob('dev_tz4')).toHaveLength(1)
    expect(briefJob('dev_tz4')[0]!.runAtMillis).not.toBe(before.runAtMillis)
  })

  it('leaves the chain alone when the reported zone is the one already stored', async () => {
    // Every heartbeat carries the zone, so re-scheduling on each one would drag the row forward
    // constantly and hand `ensureSingletonJob` a moving target for no reason.
    const app = await makeApp()
    const device = makeDevice('dev_tz5')
    setTimezone('dev_tz5', 'Europe/London')
    scheduleBriefChain({ ...device, timezone: 'Europe/London' }, Date.now())
    const before = briefJob('dev_tz5')[0]!

    await app.inject({
      method: 'POST',
      url: '/devices/dev_tz5/heartbeat',
      payload: { appVersion: '1.0.0', atMillis: 123, timezone: 'Europe/London' },
    })

    expect(briefJob('dev_tz5')[0]!.runAtMillis).toBe(before.runAtMillis)
  })

  it('an invalid zone is ignored (204, timezone unchanged)', async () => {
    const app = await makeApp()
    makeDevice('dev_tz3')
    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev_tz3/heartbeat',
      payload: { appVersion: '1.0.0', atMillis: 123, timezone: 'Not/AZone' },
    })
    expect(res.statusCode).toBe(204)
    expect(getDevice('dev_tz3')?.timezone).toBe('UTC')
  })

  it('an absent timezone leaves the stored zone untouched', async () => {
    const app = await makeApp()
    makeDevice('dev_tz4')
    await app.inject({
      method: 'POST',
      url: '/devices/dev_tz4/heartbeat',
      payload: { appVersion: '1.0.0', atMillis: 1, timezone: 'Europe/Paris' },
    })
    await app.inject({
      method: 'POST',
      url: '/devices/dev_tz4/heartbeat',
      payload: { appVersion: '1.0.0', atMillis: 2 },
    })
    expect(getDevice('dev_tz4')?.timezone).toBe('Europe/Paris')
  })
})

describe('SYNC on re-registration', () => {
  it('pushes a signed SYNC when the server still holds armed alarms', async () => {
    const app = await makeApp()
    const device = makeDevice('dev_sync1', 'old-token')
    await armAlarm(device, { alarmId: 'alm_s1', triggerAtMillis: Date.now() + 3_600_000, label: 'T' })
    sent.length = 0 // drop the ARM push

    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev_sync1/token',
      payload: { token: 'new-token-after-reinstall', appVersion: '1.0.0' },
    })
    await flush()
    expect(res.statusCode).toBe(204)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.token).toBe('new-token-after-reinstall')
    expect(sent[0]?.data.type).toBe('SYNC')
    expectValidSig(sent[0]!.data, device.hmacSecret)
  })

  it('does not push SYNC when no alarms are armed', async () => {
    const app = await makeApp()
    makeDevice('dev_sync2')
    sent.length = 0
    await app.inject({
      method: 'POST',
      url: '/devices/dev_sync2/token',
      payload: { token: 't2', appVersion: '1.0.0' },
    })
    await flush()
    expect(sent).toHaveLength(0)
  })
})

describe('an alarm the phone accepted but the OS refused', () => {
  /**
   * `AlarmRepository.upsertArmed` writes the ARMED outbox event inside the state transaction, before
   * `registerWithOs` ever runs — so the server receives ARMED, cancels its arm-ack watchdog, and
   * believes the alarm is set even when the OS refused to schedule it. Returning a distinct
   * `FireDecision` from `arm()` did nothing about that: all three callers discard the result. The
   * phone now REPORTS it, arriving right behind the ARMED event, and this is the end that acts.
   */
  const report = async (app: Awaited<ReturnType<typeof makeApp>>, deviceId: string, alarmId: string, event: string) =>
    app.inject({
      method: 'POST',
      url: `/alarms/${alarmId}/events`,
      payload: { deviceId, event, atMillis: Date.now(), appVersion: '1.3.0' },
    })

  const warnings = (waUserId: string) => pendingFor(waUserId).filter((r) => r.kind === 'system_warning')

  it('tells the owner, naming the alarm and when it was meant to ring', async () => {
    const app = await makeApp()
    const device = makeDevice('dev_nr1')
    linkWhatsapp('dev_nr1', '447700900901')
    await armAlarm(getDevice('dev_nr1')!, {
      alarmId: 'alm_nr1',
      triggerAtMillis: Date.now() + 3_600_000,
      label: 'Get up',
    })

    // The order the phone actually drains them in.
    expect((await report(app, 'dev_nr1', 'alm_nr1', 'ARMED')).statusCode).toBe(204)
    expect((await report(app, 'dev_nr1', 'alm_nr1', 'NOT_REGISTERED')).statusCode).toBe(204)

    const bodies = warnings('447700900901').map((r) => r.body)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('Get up')
    expect(bodies[0]).toContain('will not ring')
  })

  it('leaves the alarm ARMED, because boot recovery retries it once the grant returns', async () => {
    const app = await makeApp()
    const device = makeDevice('dev_nr2')
    linkWhatsapp('dev_nr2', '447700900902')
    await armAlarm(getDevice('dev_nr2')!, {
      alarmId: 'alm_nr2',
      triggerAtMillis: Date.now() + 3_600_000,
      label: 'Get up',
    })

    await report(app, 'dev_nr2', 'alm_nr2', 'NOT_REGISTERED')

    expect(getAlarm('alm_nr2')?.state).toBe('ARMED')
  })

  it('says it once per alarm, however many times a SYNC re-attempts it', async () => {
    const app = await makeApp()
    const device = makeDevice('dev_nr3')
    linkWhatsapp('dev_nr3', '447700900903')
    await armAlarm(getDevice('dev_nr3')!, {
      alarmId: 'alm_nr3',
      triggerAtMillis: Date.now() + 3_600_000,
      label: 'Get up',
    })

    // Distinct instants, or the alarm_events dedupe index rejects the replay before this is reached.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/alarms/alm_nr3/events',
        payload: { deviceId: 'dev_nr3', event: 'NOT_REGISTERED', atMillis: Date.now() + i, appVersion: '1.3.0' },
      })
    }

    expect(warnings('447700900903')).toHaveLength(1)
  })
})

describe('the wake-check hook on POST /alarms/:id/events', () => {
  const FAR_FUTURE = Date.now() + 365 * 24 * 3_600_000
  const wakeJobs = () => dueJobs(FAR_FUTURE).filter((j) => j.kind === 'wake_check')

  /** Report one event for an alarm and hand back the response. */
  async function report(app: Awaited<ReturnType<typeof makeApp>>, deviceId: string, alarmId: string, event: string) {
    return app.inject({
      method: 'POST',
      url: `/alarms/${alarmId}/events`,
      payload: { deviceId, event, atMillis: Date.now(), appVersion: '1.0.0' },
    })
  }

  it('starts the ladder on DISMISSED for an opted-in alarm', async () => {
    const app = await makeApp()
    db.delete(jobs).run()
    const device = makeDevice('dev_wk1')
    await armAlarm(device, { alarmId: 'alm_wk1', triggerAtMillis: Date.now() + 60_000, label: 'Get up', wakeCheck: true })

    const res = await report(app, device.deviceId, 'alm_wk1', 'DISMISSED')

    expect(res.statusCode).toBe(204)
    expect(wakeJobs().map((j) => j.alarmId)).toEqual(['alm_wk1'])
  })

  it('does nothing on MISSED — they never touched it, which is a different problem', async () => {
    const app = await makeApp()
    db.delete(jobs).run()
    const device = makeDevice('dev_wk2')
    await armAlarm(device, { alarmId: 'alm_wk2', triggerAtMillis: Date.now() + 60_000, label: 'Get up', wakeCheck: true })

    expect((await report(app, device.deviceId, 'alm_wk2', 'MISSED')).statusCode).toBe(204)
    expect(wakeJobs()).toHaveLength(0)
  })

  it('does nothing for an alarm that never opted in', async () => {
    const app = await makeApp()
    db.delete(jobs).run()
    const device = makeDevice('dev_wk3')
    await armAlarm(device, { alarmId: 'alm_wk3', triggerAtMillis: Date.now() + 60_000, label: 'Leave now' })

    expect((await report(app, device.deviceId, 'alm_wk3', 'DISMISSED')).statusCode).toBe(204)
    expect(wakeJobs()).toHaveLength(0)
  })
})

describe('admin push endpoints', () => {
  it('POST /admin/sync pushes a signed SYNC to the device', async () => {
    const app = await makeApp()
    const device = makeDevice('dev_adm1')
    const res = await app.inject({
      method: 'POST',
      url: '/admin/sync',
      headers: ADMIN_HEADERS,
      payload: { deviceId: 'dev_adm1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ deviceId: 'dev_adm1', sent: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.data.type).toBe('SYNC')
    expectValidSig(sent[0]!.data, device.hmacSecret)
  })

  it('POST /admin/ping pushes a signed PING', async () => {
    const app = await makeApp()
    const device = makeDevice('dev_adm2')
    const res = await app.inject({
      method: 'POST',
      url: '/admin/ping',
      headers: ADMIN_HEADERS,
      payload: { deviceId: 'dev_adm2' },
    })
    expect(res.statusCode).toBe(200)
    expect(sent[0]?.data.type).toBe('PING')
    expectValidSig(sent[0]!.data, device.hmacSecret)
  })

  it('404 for an unknown deviceId; 409 for a device with no token', async () => {
    const app = await makeApp()
    const missing = await app.inject({
      method: 'POST',
      url: '/admin/sync',
      headers: ADMIN_HEADERS,
      payload: { deviceId: 'dev_nope' },
    })
    expect(missing.statusCode).toBe(404)
    makeDevice('dev_adm3', null)
    const noToken = await app.inject({
      method: 'POST',
      url: '/admin/sync',
      headers: ADMIN_HEADERS,
      payload: { deviceId: 'dev_adm3' },
    })
    expect(noToken.statusCode).toBe(409)
  })
})
