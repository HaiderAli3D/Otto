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
import { armAlarm } from '../src/services/alarms.js'
import { scheduleBriefChain } from '../src/services/brief.js'
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
