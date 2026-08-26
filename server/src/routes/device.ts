import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { syncData } from '../fcm/commands.js'
import { sendData } from '../fcm/sender.js'
import { log } from '../lib/log.js'
import { advanceRecurrence, listArmed, recordEvent } from '../services/alarms.js'
import { rescheduleBriefChain } from '../services/brief.js'
import { verifyRequestSig } from '../services/deviceAuth.js'
import { getDevice, latchAuth, markActivity, setHeartbeat, setTimezone, setToken } from '../services/devices.js'
import { recordDeviceLocation } from '../services/location.js'
import { completeReminder, onReminderAlarmEvent, snoozeReminder } from '../services/reminders.js'
import { isValidZone } from '../services/time.js'
import { scheduleWakeCheck } from '../services/wakeCheck.js'
import { rescheduleWeeklyReviewChain } from '../services/weeklyReview.js'

/**
 * The four endpoints the Android app calls (OttoApi.kt). Mounted at the origin root; the app's
 * base URL carries the trailing slash. Identity is deviceId in the path/body, plus optional
 * signed-request auth (see SETUP.md "Hardening") once the device has ever authenticated. All
 * return 2xx on success; a non-2xx on GET /alarms tells the app to skip reconciliation rather
 * than wipe alarms.
 */

/**
 * The app reports its IANA zone with register/heartbeat; a bad zone is ignored, never a 4xx.
 *
 * A CHANGE also has to move the two standing wall-clock chains. Both the brief and the weekly review
 * store an absolute instant computed in the zone that was current when the row was written, and
 * `slotForRunAt` matches that instant back against the configured boundary by a round trip through
 * luxon — so after the owner moves timezone the pending row is no longer a boundary in the new zone,
 * reads as `null`, and the brief is skipped for the day. Silently, once per move, on the one morning
 * they are most likely to be somewhere unfamiliar and want it.
 *
 * `setPreferences` already does exactly this whenever the times change; a zone change moves the same
 * instants for a different reason and had no equivalent.
 */
function applyTimezone(deviceId: string, timezone: string | undefined): void {
  if (!timezone) return
  if (!isValidZone(timezone)) {
    log.warn({ deviceId, timezone }, 'Ignoring invalid timezone from device')
    return
  }
  const before = getDevice(deviceId)
  if (before?.timezone === timezone) return
  setTimezone(deviceId, timezone)
  const after = getDevice(deviceId)
  if (after === undefined) return
  rescheduleBriefChain(after)
  rescheduleWeeklyReviewChain(after)
  log.info({ deviceId, from: before?.timezone, to: timezone }, 'device timezone changed; standing chains moved')
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
      // If this alarm belongs to a reminder, the ring firing is NOT the task being done — start
      // the chat follow-up. (Reminder-owned alarms carry no recurrence, so advanceRecurrence
      // above hits its guard and no-ops for them.)
      const device = getDevice(body.deviceId)
      if (device) onReminderAlarmEvent(alarmId, body.event, device)
      // DISMISSED only. MISSED means they never touched it — a different problem, and the ringer
      // has already given up. Note this hook returns immediately for an alarm with no owning
      // reminder; the wake-check is keyed on the ALARM, so it works for standalone ones too.
      // Fire-and-forget like the rest of this block: the route still answers 204.
      if (device && body.event === 'DISMISSED') scheduleWakeCheck(alarmId, device, body.atMillis)
    }
    return reply.code(204).send()
  })

  /**
   * Everything the device reports that is not an alarm state change.
   *
   * One route for all of it, with `kind` saying which vocabulary `event` is drawn from, so a new
   * device-side signal is a constant on both sides rather than a new endpoint and a new drain loop.
   *
   * A nudge action is the owner acting on the reminder itself, so DONE and SNOOZE are applied to
   * the reminder here rather than merely logged — that is the whole point of putting buttons on a
   * lockscreen. `refId` for a nudge IS the reminder id (see fcm/commands.ts `nudgeData`).
   */
  app.post('/devices/:deviceId/events', async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string }
    const body = z
      .object({
        deviceId: z.string(),
        kind: z.string(),
        refId: z.string(),
        event: z.string(),
        atMillis: z.number(),
        appVersion: z.string().optional(),
        detail: z.string().optional(),
        untilMillis: z.number().optional(),
      })
      .parse(req.body)

    const device = getDevice(deviceId)
    if (!device) return reply.code(404).send({ error: 'unknown device' })

    log.info({ deviceId, kind: body.kind, event: body.event, refId: body.refId }, 'Recorded device event')

    if (body.kind === 'NUDGE') {
      // A tap is proof they are awake and engaging, but it must NOT stamp lastInboundAt: that
      // column is a Meta transport fact — the 24h free-form window — and a notification button does
      // not reopen it. Claiming otherwise would have the outbox believing it could send free-form
      // text and eating a 131047 on the next proactive message.
      markActivity(deviceId, body.atMillis)

      switch (body.event) {
        case 'DONE':
          await completeReminder(device, body.refId)
          break
        case 'SNOOZED':
          if (body.untilMillis !== undefined) snoozeReminder(body.refId, body.untilMillis)
          break
        // DEFERRED and DISMISSED are recorded and nothing more. "Not today" and "swiped it away"
        // are signals about the owner, not instructions — the ladder decides what happens next, and
        // acting on them here would give a swipe the same power as an explicit snooze.
        default:
          break
      }
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

  /**
   * The answer to one REQUEST_LOCATION — a fix, or the reason there is not one.
   *
   * Its own route rather than another `kind` on `/events`, because that outbox drains in id order
   * and stops at the first failure: a location report could queue behind a stale row and arrive long
   * after it stopped meaning anything. Freshness is the whole value here; ordering is worth nothing.
   *
   * A refusal travels the same road as a fix, and that is deliberate — Otto may be mid-plan while
   * this is in flight, so "I can't" has to arrive as fast as "here I am".
   *
   * `capturedAtMillis` is when the PHONE took the fix. Staleness is judged on it, never on arrival
   * time; judging on arrival would accept a fix delayed by a retry as current. Coordinates are
   * validated here rather than trusted, because everything downstream treats a stored fix as real.
   */
  app.post('/devices/:deviceId/location', async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string }
    const body = z
      .object({
        requestId: z.string().min(1).max(64),
        status: z.string().min(1).max(32),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        accuracyMeters: z.number().min(0).max(1_000_000).optional(),
        capturedAtMillis: z.number().int().optional(),
        atMillis: z.number().int(),
        isMock: z.boolean().optional(),
        appVersion: z.string().max(32).optional(),
        detail: z.string().max(500).optional(),
      })
      .parse(req.body)

    const hasCoords = body.latitude !== undefined && body.longitude !== undefined
    recordDeviceLocation({
      deviceId,
      requestId: body.requestId,
      // A status of OK with no coordinates is a contradiction, and treating it as OK would store a
      // "fix" that `usableFix` then has to reject on a second, unrelated ground.
      status: body.status === 'OK' && !hasCoords ? 'UNAVAILABLE' : body.status,
      latLng: hasCoords ? { lat: body.latitude!, lng: body.longitude! } : null,
      accuracyMeters: body.accuracyMeters === undefined ? null : Math.round(body.accuracyMeters),
      isMock: body.isMock ?? false,
      fixAtMillis: body.capturedAtMillis ?? null,
    })
    // Deliberately no coordinate in the log line. lib/log.ts redacts them, and this route is the one
    // place where a careless `req.body` would otherwise write the owner's home to the host's logs.
    log.info({ deviceId, requestId: body.requestId, status: body.status }, 'location: answer received')
    return reply.code(204).send()
  })
}
