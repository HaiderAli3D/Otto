import { describe, expect, it } from 'vitest'
import {
  AUTH_WINDOW_MS,
  bodySha256Hex,
  computeRequestSig,
  verifyRequestSig,
} from '../src/services/deviceAuth.js'
import { getDevice } from '../src/services/devices.js'
import { makeApp, makeDevice } from './helpers.js'

// Cross-repo contract lock: these exact vectors are also pinned in the Android app's
// RequestSignerTest.kt. If either side drifts, its test fails against these constants.
const POST_BODY = '{"appVersion":"1.0.0","atMillis":1751500000000}'
const POST_BODY_HASH = '7beb24e8b0e0d74cb8d1eba8c480b59720f90367c36eb940e7d6467816f0ee40'
const POST_SIG = '06d89492c040004727bd8167d79e5014651710488f8aa401bbd1370d862bd711'
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const GET_SIG = 'e24f5b661348e1b025493a3b75dc8031d9237963aafe25733e545657d77719ab'

describe('request signing (pinned vectors)', () => {
  it('matches the pinned POST vector', () => {
    const body = Buffer.from(POST_BODY, 'utf8')
    expect(bodySha256Hex(body)).toBe(POST_BODY_HASH)
    expect(computeRequestSig('s3cr3t', 'POST', '/devices/dev_test/heartbeat', '1751500000000', body)).toBe(POST_SIG)
  })

  it('matches the pinned GET vector (empty body)', () => {
    expect(bodySha256Hex(Buffer.alloc(0))).toBe(EMPTY_HASH)
    expect(computeRequestSig('s3cr3t', 'GET', '/devices/dev_test/alarms', '1751500000000', Buffer.alloc(0))).toBe(GET_SIG)
  })
})

describe('verifyRequestSig', () => {
  const ts = '1751500000000'
  const now = 1751500000000
  const body = Buffer.from(POST_BODY, 'utf8')
  const base = {
    secret: 's3cr3t',
    method: 'POST',
    pathWithQuery: '/devices/dev_test/heartbeat',
    tsHeader: ts,
    sigHeader: POST_SIG,
    body,
    nowMillis: now,
  }

  it('accepts a valid signature inside the window', () => {
    expect(verifyRequestSig(base)).toBe(true)
    expect(verifyRequestSig({ ...base, nowMillis: now + AUTH_WINDOW_MS })).toBe(true)
  })

  it('rejects a timestamp outside the window', () => {
    expect(verifyRequestSig({ ...base, nowMillis: now + AUTH_WINDOW_MS + 1 })).toBe(false)
  })

  it('rejects missing headers and garbage timestamps', () => {
    expect(verifyRequestSig({ ...base, sigHeader: undefined })).toBe(false)
    expect(verifyRequestSig({ ...base, tsHeader: undefined })).toBe(false)
    expect(verifyRequestSig({ ...base, tsHeader: 'yesterday' })).toBe(false)
  })

  it('rejects a tampered body and a wrong secret', () => {
    expect(verifyRequestSig({ ...base, body: Buffer.from('{}') })).toBe(false)
    expect(verifyRequestSig({ ...base, secret: 'other' })).toBe(false)
  })
})

describe('device route auth latch', () => {
  function signed(secret: string, method: string, path: string, bodyStr?: string) {
    const raw = bodyStr === undefined ? Buffer.alloc(0) : Buffer.from(bodyStr, 'utf8')
    const ts = String(Date.now())
    return {
      'x-otto-ts': ts,
      'x-otto-sig': computeRequestSig(secret, method, path, ts, raw),
    }
  }
  const HEARTBEAT = '{"appVersion":"1.0.0","atMillis":5}'
  const JSON_CT = { 'content-type': 'application/json' }

  it('bootstrap → latch → fail closed', async () => {
    const app = await makeApp()
    const device = makeDevice('dev_auth1')
    const path = '/devices/dev_auth1/heartbeat'

    // 1. Unsigned works before any pairing (bootstrap).
    const boot = await app.inject({ method: 'POST', url: path, headers: JSON_CT, payload: HEARTBEAT })
    expect(boot.statusCode).toBe(204)
    expect(getDevice('dev_auth1')?.authLatched).toBe(false)

    // 2. First valid signature latches the device.
    const latch = await app.inject({
      method: 'POST',
      url: path,
      headers: { ...JSON_CT, ...signed(device.hmacSecret, 'POST', path, HEARTBEAT) },
      payload: HEARTBEAT,
    })
    expect(latch.statusCode).toBe(204)
    expect(getDevice('dev_auth1')?.authLatched).toBe(true)

    // 3. Unsigned is now rejected, on every device endpoint.
    const unsigned = await app.inject({ method: 'POST', url: path, headers: JSON_CT, payload: HEARTBEAT })
    expect(unsigned.statusCode).toBe(401)
    const getUnsigned = await app.inject({ method: 'GET', url: '/devices/dev_auth1/alarms' })
    expect(getUnsigned.statusCode).toBe(401)

    // 4. A bad signature is rejected too.
    const forged = await app.inject({
      method: 'POST',
      url: path,
      headers: { ...JSON_CT, 'x-otto-ts': String(Date.now()), 'x-otto-sig': 'f'.repeat(64) },
      payload: HEARTBEAT,
    })
    expect(forged.statusCode).toBe(401)

    // 5. Valid signatures keep working (GET signs the empty body).
    const getSigned = await app.inject({
      method: 'GET',
      url: '/devices/dev_auth1/alarms',
      headers: signed(device.hmacSecret, 'GET', '/devices/dev_auth1/alarms'),
    })
    expect(getSigned.statusCode).toBe(200)
  })

  it('the events route authenticates via the body deviceId', async () => {
    const app = await makeApp()
    const device = makeDevice('dev_auth2')
    // Latch via a signed heartbeat first.
    const hbPath = '/devices/dev_auth2/heartbeat'
    await app.inject({
      method: 'POST',
      url: hbPath,
      headers: { ...JSON_CT, ...signed(device.hmacSecret, 'POST', hbPath, HEARTBEAT) },
      payload: HEARTBEAT,
    })
    expect(getDevice('dev_auth2')?.authLatched).toBe(true)

    const evPath = '/alarms/alm_x/events'
    const evBody = '{"deviceId":"dev_auth2","event":"RANG","atMillis":9,"appVersion":"1.0.0"}'
    const unsigned = await app.inject({ method: 'POST', url: evPath, headers: JSON_CT, payload: evBody })
    expect(unsigned.statusCode).toBe(401)

    const signedRes = await app.inject({
      method: 'POST',
      url: evPath,
      headers: { ...JSON_CT, ...signed(device.hmacSecret, 'POST', evPath, evBody) },
      payload: evBody,
    })
    expect(signedRes.statusCode).toBe(204)
  })

  it('an unknown device is still allowed through to registration (bootstrap)', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev_brand_new/token',
      payload: { token: 't', appVersion: '1.0.0' },
    })
    expect(res.statusCode).toBe(204)
  })
})
