import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { pingData, syncData } from '../fcm/commands.js'
import { sendData } from '../fcm/sender.js'
import { newAlarmId } from '../lib/ids.js'
import { armAlarm, cancelAlarm } from '../services/alarms.js'
import { getDevice, listDevices, type Device } from '../services/devices.js'
import { listFacts } from '../services/facts.js'
import { pendingFor } from '../services/outbox.js'
import { listReminders } from '../services/reminders.js'
import { epochMillisToLocalHuman } from '../services/time.js'

/**
 * Owner-only helpers: read a device's pairing secret (to paste into the app) and fire a test
 * alarm end-to-end without WhatsApp. Guarded by the ADMIN_TOKEN header when configured.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!config.adminToken) return // open when unset (dev/local)
    if (req.headers['x-admin-token'] !== config.adminToken) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })

  // The pairing secret to paste into the app's Settings → Pair.
  app.get('/admin/devices', async () =>
    listDevices().map((d) => ({
      deviceId: d.deviceId,
      hmacSecret: d.hmacSecret,
      hasToken: Boolean(d.fcmToken),
      appVersion: d.appVersion,
      timezone: d.timezone,
      authEnforced: d.authLatched,
      whatsappNumber: d.whatsappNumber,
      lastHeartbeatAt: d.lastHeartbeatAt,
    })),
  )

  /**
   * Read-only introspection of the assistant's state: what it is chasing, what it remembers, and
   * anything queued because the WhatsApp window was shut. Debug surface only — every mutation
   * still goes through the agent so the conversation stays the single source of truth.
   */
  app.get('/admin/state', async (req) => {
    const query = req.query as { deviceId?: string }
    const device = query.deviceId ? getDevice(query.deviceId) : listDevices()[0]
    if (!device) return { error: 'no device registered yet' }
    const zone = device.timezone
    return {
      deviceId: device.deviceId,
      timezone: zone,
      whatsappNumber: device.whatsappNumber,
      lastInboundAt: device.lastInboundAt,
      windowOpenUntil:
        device.lastInboundAt === null
          ? null
          : epochMillisToLocalHuman(device.lastInboundAt + 24 * 60 * 60 * 1000, zone),
      reminders: listReminders(device.deviceId, { state: 'all' }).map((r) => ({
        reminderId: r.reminderId,
        title: r.title,
        state: r.state,
        dueLocal: r.dueAtMillis === null ? null : epochMillisToLocalHuman(r.dueAtMillis, zone),
        repeats: r.recurrence,
        nagPolicy: r.nagPolicy,
        nagCount: r.nagCount,
        nextNagLocal: r.nextNagAtMillis === null ? null : epochMillisToLocalHuman(r.nextNagAtMillis, zone),
        rings: Boolean(r.alarmId),
      })),
      facts: listFacts(device.deviceId).map((f) => ({ key: f.key, value: f.value, category: f.category })),
      queued: device.whatsappNumber
        ? pendingFor(device.whatsappNumber).map((o) => ({ kind: o.kind, body: o.body, createdAt: o.createdAt }))
        : [],
    }
  })

  // Prove the pipe: arm a real alarm on the device N seconds from now.
  app.post('/admin/test-alarm', async (req, reply) => {
    const body = z
      .object({ deviceId: z.string().optional(), inSeconds: z.number().default(60), label: z.string().default('Otto test alarm') })
      .parse(req.body ?? {})
    const devices = listDevices()
    const device = body.deviceId ? getDevice(body.deviceId) : devices[0]
    if (!device) return reply.code(404).send({ error: 'no device registered yet — open the app first' })
    const result = await armAlarm(device, {
      alarmId: newAlarmId(),
      triggerAtMillis: Date.now() + body.inSeconds * 1000,
      label: body.label,
    })
    return reply.send({ ...result, deviceId: device.deviceId, firesInSeconds: body.inSeconds })
  })

  app.post('/admin/cancel', async (req, reply) => {
    const body = z.object({ deviceId: z.string(), alarmId: z.string() }).parse(req.body)
    const device = getDevice(body.deviceId)
    if (!device) return reply.code(404).send({ error: 'unknown device' })
    const sent = await cancelAlarm(device, body.alarmId)
    return reply.send({ sent })
  })

  /** Resolve the target device for the push helpers below: explicit deviceId, else the first one. */
  function resolveDevice(deviceId: string | undefined): Device | undefined {
    return deviceId ? getDevice(deviceId) : listDevices()[0]
  }

  // Push SYNC: the app fetches the authoritative armed set and reconciles. Manual recovery tool.
  app.post('/admin/sync', async (req, reply) => {
    const body = z.object({ deviceId: z.string().optional() }).parse(req.body ?? {})
    const device = resolveDevice(body.deviceId)
    if (!device) return reply.code(404).send({ error: 'no device registered yet — open the app first' })
    if (!device.fcmToken) return reply.code(409).send({ error: 'device has no FCM token' })
    const res = await sendData(device.fcmToken, syncData(device.hmacSecret))
    return reply.send({ deviceId: device.deviceId, sent: res.ok })
  })

  // Push PING: a no-ring liveness check — the app answers with a heartbeat (watch lastHeartbeatAt).
  app.post('/admin/ping', async (req, reply) => {
    const body = z.object({ deviceId: z.string().optional() }).parse(req.body ?? {})
    const device = resolveDevice(body.deviceId)
    if (!device) return reply.code(404).send({ error: 'no device registered yet — open the app first' })
    if (!device.fcmToken) return reply.code(409).send({ error: 'device has no FCM token' })
    const res = await sendData(device.fcmToken, pingData(device.hmacSecret))
    return reply.send({ deviceId: device.deviceId, sent: res.ok, lastHeartbeatAt: device.lastHeartbeatAt })
  })
}
