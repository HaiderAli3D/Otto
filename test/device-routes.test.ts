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
import { armAlarm } from '../src/services/alarms.js'
import { getDevice } from '../src/services/devices.js'

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
