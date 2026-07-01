import { randomBytes } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { devices } from '../db/schema.js'

export type Device = typeof devices.$inferSelect

export function getDevice(deviceId: string): Device | undefined {
  return db.select().from(devices).where(eq(devices.deviceId, deviceId)).get()
}

/** Ensure a device row exists, minting a per-device HMAC pairing secret on first sight. */
export function ensureDevice(deviceId: string): Device {
  const existing = getDevice(deviceId)
  if (existing) return existing
  const row: Device = {
    deviceId,
    fcmToken: null,
    appVersion: null,
    hmacSecret: randomBytes(32).toString('hex'),
    whatsappNumber: null,
    timezone: config.defaultTimezone,
    authLatched: false,
    lastHeartbeatAt: null,
    createdAt: Date.now(),
  }
  db.insert(devices).values(row).run()
  return row
}

/** One valid signed request latches the device: from now on its endpoints require a signature. */
export function latchAuth(deviceId: string): void {
  db.update(devices).set({ authLatched: true }).where(eq(devices.deviceId, deviceId)).run()
}

export function setToken(deviceId: string, fcmToken: string, appVersion: string | null): void {
  ensureDevice(deviceId)
  db.update(devices).set({ fcmToken, appVersion }).where(eq(devices.deviceId, deviceId)).run()
}

export function clearToken(deviceId: string): void {
  db.update(devices).set({ fcmToken: null }).where(eq(devices.deviceId, deviceId)).run()
}

export function setHeartbeat(deviceId: string, atMillis: number, appVersion: string | null): void {
  ensureDevice(deviceId)
  const set: Partial<Device> = { lastHeartbeatAt: atMillis }
  if (appVersion) set.appVersion = appVersion
  db.update(devices).set(set).where(eq(devices.deviceId, deviceId)).run()
}

export function setTimezone(deviceId: string, timezone: string): void {
  db.update(devices).set({ timezone }).where(eq(devices.deviceId, deviceId)).run()
}

export function linkWhatsapp(deviceId: string, whatsappNumber: string): void {
  db.update(devices).set({ whatsappNumber }).where(eq(devices.deviceId, deviceId)).run()
}

export function listDevices(): Device[] {
  return db.select().from(devices).orderBy(asc(devices.createdAt)).all()
}

/**
 * The owner device for single-user WhatsApp routing: the one whose linked whatsappNumber matches,
 * else the earliest-registered device. Lets a paired phone receive alarms from WhatsApp before an
 * explicit number link exists.
 */
export function deviceForWhatsapp(waNumber: string): Device | undefined {
  const linked = db.select().from(devices).where(eq(devices.whatsappNumber, waNumber)).get()
  if (linked) return linked
  return db.select().from(devices).orderBy(asc(devices.createdAt)).limit(1).get()
}
