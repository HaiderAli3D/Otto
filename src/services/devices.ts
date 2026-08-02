import { randomBytes } from 'node:crypto'
import { asc, eq, isNotNull } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { devices, processedMessages } from '../db/schema.js'

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
    lastInboundAt: null,
    lastDigestAt: null,
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

/** WhatsApp's 24h free-form window. Stamped on EVERY inbound, including non-text. */
export function markInbound(deviceId: string, atMillis: number = Date.now()): void {
  db.update(devices).set({ lastInboundAt: atMillis }).where(eq(devices.deviceId, deviceId)).run()
}

/**
 * Meta just told us the window is shut (error 131047) even though we believed it was open —
 * our clock was wrong, so drop the belief rather than retrying into the same rejection.
 */
export function clearInboundWindow(deviceId: string): void {
  db.update(devices).set({ lastInboundAt: null }).where(eq(devices.deviceId, deviceId)).run()
}

export function markDigestSent(deviceId: string, atMillis: number = Date.now()): void {
  db.update(devices).set({ lastDigestAt: atMillis }).where(eq(devices.deviceId, deviceId)).run()
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

/** True iff any device has already claimed a WhatsApp number (trust-on-first-use gate). */
export function anyWhatsappLinked(): boolean {
  return db.select().from(devices).where(isNotNull(devices.whatsappNumber)).get() !== undefined
}

/**
 * Record a WhatsApp message id as processed. Returns true if it was NEW (safe to handle), false
 * if already seen — Meta redelivers at-least-once, so this makes inbound handling idempotent.
 */
export function claimWhatsappMessage(wamid: string): boolean {
  const res = db
    .insert(processedMessages)
    .values({ wamid, receivedAt: Date.now() })
    .onConflictDoNothing()
    .run()
  return res.changes > 0
}
