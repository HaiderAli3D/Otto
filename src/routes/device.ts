import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { syncData } from '../fcm/commands.js'
import { sendData } from '../fcm/sender.js'
import { log } from '../lib/log.js'
import { advanceRecurrence, listArmed, recordEvent } from '../services/alarms.js'
import { verifyRequestSig } from '../services/deviceAuth.js'
import { getDevice, latchAuth, setHeartbeat, setTimezone, setToken } from '../services/devices.js'
import { isValidZone } from '../services/time.js'

/**
 * The four endpoints the Android app calls (OttoApi.kt). Mounted at the origin root; the app's
 * base URL carries the trailing slash. Identity is deviceId in the path/body, plus optional
 * signed-request auth (see SETUP.md "Hardening") once the device has ever authenticated. All
 * return 2xx on success; a non-2xx on GET /alarms tells the app to skip reconciliation rather
 * than wipe alarms.
 */

/** The app reports its IANA zone with register/heartbeat; a bad zone is ignored, never a 4xx. */
function applyTimezone(deviceId: string, timezone: string | undefined): void {
  if (!timezone) return
  if (!isValidZone(timezone)) {
    log.warn({ deviceId, timezone }, 'Ignoring invalid timezone from device')
    return
  }
  setTimezone(deviceId, timezone)
}

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // Signed-request gate, fail-closed once latched (mirror of the app's HmacGate). Scoped to this
  // plugin so admin/webhook/oauth routes are untouched. Runs preHandler (after body parsing) so
  // the raw bytes and the body-borne deviceId are both available.
  app.addHook('preHandler', async (req, reply) => {
    const params = req.params as { deviceId?: string }
    const deviceId = params.deviceId ?? (req.body as { deviceId?: string } | undefined)?.deviceId
    if (!deviceId) return // no identity claimed; zod will reject the body below
    const device = getDevice(deviceId)
    if (!device) return // bootstrap: first-ever call mints the row via ensureDevice

    const sigHeader = req.headers['x-otto-sig']
    const tsHeader = req.headers['x-otto-ts']
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0)
    const valid = verifyRequestSig({
      secret: device.hmacSecret,
      method: req.method,
      pathWithQuery: req.url,
      tsHeader: typeof tsHeader === 'string' ? tsHeader : undefined,
      sigHeader: typeof sigHeader === 'string' ? sigHeader : undefined,
      body: rawBody,
      nowMillis: Date.now(),
    })

    if (valid) {
      if (!device.authLatched) {
        latchAuth(deviceId)
        log.info({ deviceId }, 'Device auth latched — signed requests now required')
      }
      return
    }
    if (device.authLatched) {
      log.warn({ deviceId, hadSig: Boolean(sigHeader) }, 'Rejected unsigned/invalid device request')
      return reply.code(401).send({ error: 'signature required' })
    }
    // Unlatched and unsigned/invalid: allowed (bootstrap — the app signs once the owner pairs).
  })

  app.post('/devices/:deviceId/token', async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string }
    const body = z
      .object({ token: z.string().min(1), appVersion: z.string(), timezone: z.string().min(1).max(64).optional() })
      .parse(req.body)
    setToken(deviceId, body.token, body.appVersion)
    applyTimezone(deviceId, body.timezone)
    log.info({ deviceId }, 'Registered device FCM token')

    // Re-registration recovery: if the server still holds future ARMED alarms (reinstall, data
    // clear, dead-token gap), nudge the app to reconcile. Fire-and-forget — registration must
    // succeed even when FCM is down; sendData never throws.
    const device = getDevice(deviceId)
    if (device && listArmed(deviceId).length > 0) {
      void sendData(body.token, syncData(device.hmacSecret))
    }
    return reply.code(204).send()
  })

  app.post('/alarms/:alarmId/events', async (req, reply) => {
    const { alarmId } = req.params as { alarmId: string }
    const body = z
      .object({
        deviceId: z.string(),
        event: z.string(),
        atMillis: z.number(),
        appVersion: z.string().optional(),
        triggerAtMillis: z.number().optional(),
      })
      .parse(req.body)
    recordEvent(body.deviceId, alarmId, body.event, body.atMillis, body.appVersion ?? null, body.triggerAtMillis)
    log.info({ alarmId, event: body.event }, 'Recorded alarm event')
    // A completed occurrence rolls its recurring series forward (no-op for one-shot alarms).
    // Fire-and-forget: the ack must not wait on an FCM push; the scheduler backstop covers loss.
    if (body.event === 'DISMISSED' || body.event === 'MISSED') {
      void advanceRecurrence(alarmId).catch((err) => log.error({ err, alarmId }, 'recurrence advance failed'))
    }
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
    const body = z
      .object({ appVersion: z.string(), atMillis: z.number(), timezone: z.string().min(1).max(64).optional() })
      .parse(req.body)
    setHeartbeat(deviceId, body.atMillis, body.appVersion)
    applyTimezone(deviceId, body.timezone)
    return reply.code(204).send()
  })
}
