import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { ensureSchema } from '../src/db/client.js'
import { armAlarm, getAlarm, recordEvent } from '../src/services/alarms.js'
import { dueJobs } from '../src/services/jobs.js'
import { makeDevice } from './helpers.js'

beforeEach(() => ensureSchema())

describe('recordEvent ordering + dedupe', () => {
  it('a replayed ARMED does not resurrect a CANCELLED alarm', async () => {
    const device = makeDevice('dev_ev1')
    await armAlarm(device, { alarmId: 'alm_e1', triggerAtMillis: Date.now() + 3_600_000, label: 'T' })
    recordEvent(device.deviceId, 'alm_e1', 'ARMED', 1000, '1.0.0')
    recordEvent(device.deviceId, 'alm_e1', 'CANCELLED', 2000, '1.0.0')
    expect(getAlarm('alm_e1')?.state).toBe('CANCELLED')

    // Exact-duplicate re-delivery of the old ARMED must be ignored (dedupe), not re-applied.
    recordEvent(device.deviceId, 'alm_e1', 'ARMED', 1000, '1.0.0')
    expect(getAlarm('alm_e1')?.state).toBe('CANCELLED')
  })

  it('a stale (older atMillis) event never regresses newer state', async () => {
    const device = makeDevice('dev_ev2')
    await armAlarm(device, { alarmId: 'alm_e2', triggerAtMillis: Date.now() + 3_600_000, label: 'T' })
    recordEvent(device.deviceId, 'alm_e2', 'DISMISSED', 5000, '1.0.0')
    // A distinct but older ARMED report arriving late must not flip it back to ARMED.
    recordEvent(device.deviceId, 'alm_e2', 'ARMED', 3000, '1.0.0')
    expect(getAlarm('alm_e2')?.state).toBe('DISMISSED')
  })

  it('a duplicate ARMED does not cancel the watchdog for a newer re-arm', async () => {
    const device = makeDevice('dev_ev3')
    // First arm + its ARMED ack (cancels the first watchdog).
    await armAlarm(device, { alarmId: 'alm_e3', triggerAtMillis: Date.now() + 3_600_000, label: 'T' })
    recordEvent(device.deviceId, 'alm_e3', 'ARMED', 1000, '1.0.0')
    // Re-arm (new watchdog enqueued) then a REPLAY of the old ARMED@1000.
    await armAlarm(device, { alarmId: 'alm_e3', triggerAtMillis: Date.now() + 7_200_000, label: 'T' })
    recordEvent(device.deviceId, 'alm_e3', 'ARMED', 1000, '1.0.0') // duplicate → ignored
    const watchdogs = dueJobs(Date.now() + 10 * 60_000).filter((j) => j.kind === 'arm_ack' && j.alarmId === 'alm_e3')
    expect(watchdogs.length).toBe(1) // the newer watchdog survives
  })

  it('adopts the phone-reported trigger from an ARMED event (snooze)', async () => {
    const device = makeDevice('dev_ev4')
    const original = Date.now() + 3_600_000
    await armAlarm(device, { alarmId: 'alm_e4', triggerAtMillis: original, label: 'T' })
    const snoozed = original + 9 * 60_000
    recordEvent(device.deviceId, 'alm_e4', 'ARMED', Date.now(), '1.0.0', snoozed)
    expect(getAlarm('alm_e4')?.triggerAtMillis).toBe(snoozed)
  })
})
