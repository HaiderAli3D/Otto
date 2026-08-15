import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendData = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })))
vi.mock('../src/fcm/sender.js', () => ({ sendData }))

import { requestLocationData } from '../src/fcm/commands.js'
import { ensureSchema } from '../src/db/client.js'
import { setHeartbeat, setToken, type Device } from '../src/services/devices.js'
import {
  GPS_USEFUL_WINDOW_MS,
  MAX_FIX_ACCURACY_M,
  MAX_FIX_AGE_MS,
  describeMiss,
  getDeviceLocation,
  recordDeviceLocation,
  requestLocation,
  shouldPull,
  usableFix,
} from '../src/services/location.js'
import { locationCapable, versionAtLeast } from '../src/services/push.js'
import { makeDevice } from './helpers.js'

beforeEach(() => {
  ensureSchema()
  sendData.mockClear()
})

const now = Date.now()

/** A device new enough, and awake enough, to be asked. */
function capableDevice(id: string): Device {
  const device = makeDevice(id)
  setToken(id, 'fcm-token-1', '1.2.0')
  setHeartbeat(id, Date.now(), '1.2.0')
  return { ...device, appVersion: '1.2.0', lastHeartbeatAt: Date.now() }
}

describe('the version gate', () => {
  it('refuses a phone that predates REQUEST_LOCATION', () => {
    // An older parser drops an unrecognised type silently. Unlike a nudge — which falls back to
    // WhatsApp — a location request has NO second transport, so an ungated send would leave the
    // agent waiting on an answer that was never coming.
    const device = { ...capableDevice('dev_loc_old'), appVersion: '1.1.0' }
    expect(locationCapable(device)).toBe(false)
    expect(versionAtLeast('1.1.0', '1.2.0')).toBe(false)
    expect(versionAtLeast('1.2.0', '1.2.0')).toBe(true)
  })

  it('refuses a phone that has not been heard from in days', () => {
    const device = { ...capableDevice('dev_loc_quiet'), lastHeartbeatAt: Date.now() - 5 * 24 * 3_600_000 }
    expect(locationCapable(device)).toBe(false)
  })

  it('refuses an unpaired phone', () => {
    const device = { ...capableDevice('dev_loc_unpaired'), fcmToken: null }
    expect(locationCapable(device)).toBe(false)
  })
})

describe('a fix is discarded, not downgraded', () => {
  it('accepts one that is fresh and precise', () => {
    const device = capableDevice('dev_fix_ok')
    recordDeviceLocation({
      deviceId: device.deviceId,
      requestId: 'loc_1',
      status: 'OK',
      latLng: { lat: 51.5, lng: -0.12 },
      accuracyMeters: 20,
      fixAtMillis: now - 30_000,
    })
    expect(usableFix(device.deviceId, now)?.latLng).toEqual({ lat: 51.5, lng: -0.12 })
  })

  it('rejects one taken while they were underground', () => {
    // A stale fix is where they WERE. The origin ladder degrades honestly to home; a fix that
    // silently replaced it would look like an observation rather than an assumption.
    const device = capableDevice('dev_fix_stale')
    recordDeviceLocation({
      deviceId: device.deviceId,
      requestId: 'loc_1',
      status: 'OK',
      latLng: { lat: 51.5, lng: -0.12 },
      accuracyMeters: 20,
      fixAtMillis: now - MAX_FIX_AGE_MS - 1,
    })
    expect(usableFix(device.deviceId, now)).toBeNull()
  })

  it('rejects one too vague to tell which tube station', () => {
    const device = capableDevice('dev_fix_vague')
    recordDeviceLocation({
      deviceId: device.deviceId,
      requestId: 'loc_1',
      status: 'OK',
      latLng: { lat: 51.5, lng: -0.12 },
      accuracyMeters: MAX_FIX_ACCURACY_M + 1,
      fixAtMillis: now,
    })
    expect(usableFix(device.deviceId, now)).toBeNull()
  })

  it('refuses a spoofed origin outright', () => {
    const device = capableDevice('dev_fix_mock')
    recordDeviceLocation({
      deviceId: device.deviceId,
      requestId: 'loc_1',
      status: 'OK',
      latLng: { lat: 51.5, lng: -0.12 },
      accuracyMeters: 5,
      isMock: true,
      fixAtMillis: now,
    })
    expect(usableFix(device.deviceId, now)).toBeNull()
  })

  it('keeps a refusal without pretending it is a position', () => {
    const device = capableDevice('dev_fix_denied')
    recordDeviceLocation({ deviceId: device.deviceId, requestId: 'loc_1', status: 'PERMISSION_DENIED' })
    expect(usableFix(device.deviceId, now)).toBeNull()
    expect(getDeviceLocation(device.deviceId)!.status).toBe('PERMISSION_DENIED')
  })

  it('keeps one row per device rather than a movement history', () => {
    // The primary key IS the privacy promise. An append-only table would accumulate exactly the
    // thing this feature says it does not build.
    const device = capableDevice('dev_fix_one')
    for (let i = 0; i < 5; i++) {
      recordDeviceLocation({
        deviceId: device.deviceId,
        requestId: `loc_${i}`,
        status: 'OK',
        latLng: { lat: 51.5 + i / 1000, lng: -0.12 },
        fixAtMillis: now,
      })
    }
    expect(getDeviceLocation(device.deviceId)!.requestId).toBe('loc_4')
  })
})

describe('when a pull is worth making at all', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    device: capableDevice(`dev_pull_${Math.abs(JSON.stringify(over).length)}`),
    leaveAtMillis: now + 30 * 60_000,
    originConfidence: 'medium' as const,
    explicitOrigin: false,
    nowMillis: now,
    ...over,
  })

  it('asks close to departure', () => {
    expect(shouldPull(base())).toBe(true)
  })

  it('does not ask about a journey hours away', () => {
    // At 09:00, where they are says nothing about where they will be at 14:20 — and asking would
    // have blocked the reply to learn something irrelevant.
    expect(shouldPull(base({ leaveAtMillis: now + GPS_USEFUL_WINDOW_MS + 60_000 }))).toBe(false)
  })

  it('does not ask when the calendar already says where they will be', () => {
    // A preceding event is BETTER than a live fix: it is where they WILL be, not where they are.
    expect(shouldPull(base({ originConfidence: 'high' }))).toBe(false)
  })

  it('does not ask when the owner said where they are setting off from', () => {
    expect(shouldPull(base({ explicitOrigin: true }))).toBe(false)
  })

  it('does not ask a phone that could not answer', () => {
    const device = { ...capableDevice('dev_pull_old'), appVersion: '1.1.0' }
    expect(shouldPull({ ...base(), device })).toBe(false)
  })
})

describe('requestLocation', () => {
  it('answers from a fresh stored fix without waking the phone', async () => {
    const device = capableDevice('dev_req_cached')
    recordDeviceLocation({
      deviceId: device.deviceId,
      requestId: 'loc_prev',
      status: 'OK',
      latLng: { lat: 51.5, lng: -0.12 },
      accuracyMeters: 12,
      fixAtMillis: now - 20_000,
    })

    const outcome = await requestLocation(device, { nowMillis: now })

    expect('fix' in outcome).toBe(true)
    expect(sendData).not.toHaveBeenCalled()
  })

  it('does not push to a phone that cannot parse the command', async () => {
    const device = { ...capableDevice('dev_req_old'), appVersion: '1.0.0' }
    const outcome = await requestLocation(device, { nowMillis: now })
    expect(outcome).toEqual({ miss: 'not-capable' })
    expect(sendData).not.toHaveBeenCalled()
  })

  it('gives up rather than blocking a scheduler tick forever', async () => {
    const device = capableDevice('dev_req_silent')
    const outcome = await requestLocation(device, { waitMs: 20, nowMillis: now })
    expect(outcome).toEqual({ miss: 'no-answer' })
    expect(sendData).toHaveBeenCalledTimes(1)
  })
})

describe('the command on the wire', () => {
  it('omits optional fields rather than sending them empty, and signs what it sends', () => {
    const data = requestLocationData({ requestId: 'loc_1', secret: 's3cr3t' })
    expect(data.type).toBe('REQUEST_LOCATION')
    expect(data.requestId).toBe('loc_1')
    expect(data.reason).toBeUndefined()
    expect(data.expiresAtMillis).toBeUndefined()
    expect(data.sig).toBeTruthy()
  })

  it('clamps a reason the owner would have to read on a notification', () => {
    const data = requestLocationData({ requestId: 'loc_1', reason: 'x'.repeat(500), secret: 's3cr3t' })
    expect(data.reason!.length).toBe(120)
  })
})

describe('describeMiss names the gap AND the substitute', () => {
  it('says what it used instead, every time it says anything', () => {
    for (const miss of ['denied', 'stale', 'vague', 'no-answer'] as const) {
      const sentence = describeMiss(miss, 'home')
      expect(sentence, miss).toContain('home')
    }
  })

  it('stays quiet about a non-event', () => {
    // Nothing was asked, so nothing is owed. A sentence here would be noise about something that
    // did not happen.
    expect(describeMiss('not-asked', 'home')).toBeNull()
    expect(describeMiss('not-capable', 'home')).toBeNull()
  })
})
