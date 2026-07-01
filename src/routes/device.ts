import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { log } from '../lib/log.js'
import { listArmed, recordEvent } from '../services/alarms.js'
import { getDevice, setHeartbeat, setToken } from '../services/devices.js'

/**
 * The four endpoints the Android app calls (OttoApi.kt). Mounted at the origin root; the app's
 * base URL carries the trailing slash. Identity is deviceId in the path/body (no auth header
 * today — see SETUP.md "hardening"). All return 2xx on success; a non-2xx on GET /alarms tells the
 * app to skip reconciliation rather than wipe alarms.
 */
export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/devices/:deviceId/token', async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string }
    const body = z.object({ token: z.string().min(1), appVersion: z.string() }).parse(req.body)
    setToken(deviceId, body.token, body.appVersion)
    log.info({ deviceId }, 'Registered device FCM token')
    return reply.code(204).send()
  })

  app.post('/alarms/:alarmId/events', async (req, reply) => {
    const { alarmId } = req.params as { alarmId: string }
    const body = z
      .object({ deviceId: z.string(), event: z.string(), atMillis: z.number(), appVersion: z.string().optional() })
      .parse(req.body)
    recordEvent(body.deviceId, alarmId, body.event, body.atMillis, body.appVersion ?? null)
    log.info({ alarmId, event: body.event }, 'Recorded alarm event')
    return reply.code(204).send()
  })

  app.get('/devices/:deviceId/alarms', async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string }
    const device = getDevice(deviceId)
    // Unknown device ⇒ non-2xx so the app changes nothing (never an empty 200, which pre-fix could
    // have wiped alarms).
    if (!device) return reply.code(404).send({ error: 'unknown device' })
    const armed = listArmed(deviceId).map((a) => ({
      alarmId: a.alarmId,
      triggerAtMillis: a.triggerAtMillis,
      label: a.label,
      allowWhileIdle: a.allowWhileIdle,
      state: 'ARMED' as const,
    }))
    return reply.send({ alarms: armed })
  })

  app.post('/devices/:deviceId/heartbeat', async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string }
    const body = z.object({ appVersion: z.string(), atMillis: z.number() }).parse(req.body)
    setHeartbeat(deviceId, body.atMillis, body.appVersion)
    return reply.code(204).send()
  })
}
