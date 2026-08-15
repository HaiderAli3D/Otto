import { buildApp } from '../src/app.js'
import { ensureSchema } from '../src/db/client.js'
import { ensureDevice, getDevice, setToken, type Device } from '../src/services/devices.js'

export const ADMIN_HEADERS = { 'x-admin-token': 'test-admin-token' }

/** Fresh app over this worker's in-memory DB. */
export async function makeApp() {
  ensureSchema()
  return buildApp()
}

/** Create (or fetch) a device row, optionally with an FCM token registered. */
export function makeDevice(deviceId = 'dev_test', token: string | null = 'fcm-token-1'): Device {
  ensureDevice(deviceId)
  if (token) setToken(deviceId, token, '1.0.0')
  const device = getDevice(deviceId)
  if (!device) throw new Error('device row missing after ensureDevice')
  return device
}
