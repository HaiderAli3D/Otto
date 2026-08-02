import type { FastifyInstance } from 'fastify'
import { runAgentTurn } from '../agent/runner.js'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import {
  anyWhatsappLinked,
  claimWhatsappMessage,
  deviceForWhatsapp,
  getDevice,
  linkWhatsapp,
  markInbound,
} from '../services/devices.js'
import { maybeCollapseBacklog } from '../services/digest.js'
import { flushOutbox } from '../services/outbox.js'
import { listReminders } from '../services/reminders.js'
import { appendAssistantTurns, maybeResetIdleSession } from '../services/sessions.js'
import { normalizeWaNumber, parseInboundMessages, sendText, verifySignature } from '../services/whatsapp.js'

/**
 * WhatsApp Cloud API webhook. Meta verifies the subscription with a GET challenge, then delivers
 * inbound messages via signed POSTs. We must ack the POST with a fast 200 and process afterwards.
 */
export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  // Subscription verification handshake (Meta echoes hub.challenge back on success).
  app.get('/whatsapp/webhook', async (req, reply) => {
    const query = req.query as Record<string, string>
    const mode = query['hub.mode']
    const verifyToken = query['hub.verify_token']
    const challenge = query['hub.challenge']
    if (mode === 'subscribe' && verifyToken === config.meta?.verifyToken) {
      return reply.code(200).send(challenge)
    }
    return reply.code(403).send()
  })

  // Inbound messages. Verify Meta's signature over the raw bytes, ack immediately, then reply async.
  app.post('/whatsapp/webhook', async (req, reply) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
    const sig = req.headers['x-hub-signature-256']
    if (!verifySignature(rawBody ?? Buffer.alloc(0), typeof sig === 'string' ? sig : undefined)) {
      return reply.code(401).send()
    }

    // Ack first — Meta retries aggressively if the 200 is slow.
    reply.code(200).send()

    for (const msg of parseInboundMessages(req.body)) {
      // Idempotency: Meta redelivers at-least-once; skip a wamid we've already handled.
      if (!claimWhatsappMessage(msg.id)) continue
      // Serialize per sender so two quick messages can't race the session read-modify-write.
      enqueueForUser(msg.from, () => handleInbound(msg.from, msg.type, msg.text))
    }

    return reply
  })
}

// One in-flight chain per WhatsApp user: each inbound awaits the previous, so runAgentTurn's
// loadSession→saveSession can't interleave and drop a turn (lost-update race).
const userChains = new Map<string, Promise<void>>()

function enqueueForUser(from: string, task: () => Promise<void>): void {
  const prev = userChains.get(from) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(task)
    .catch((err) => log.error({ err, from }, 'WhatsApp inbound handling failed'))
    .finally(() => {
      if (userChains.get(from) === next) userChains.delete(from)
    })
  userChains.set(from, next)
}

/** True if this sender is allowed to drive the owner's device (allowlist or trust-on-first-use). */
function isAuthorizedSender(from: string): boolean {
  const fromDigits = normalizeWaNumber(from)
  if (config.ownerWaNumbers.length > 0) return config.ownerWaNumbers.includes(fromDigits)
  // No allowlist configured: the first number to ever message becomes the owner; a device already
  // linked to a DIFFERENT number rejects strangers (prevents the earliest-device takeover).
  const device = deviceForWhatsapp(from)
  if (device?.whatsappNumber && normalizeWaNumber(device.whatsappNumber) !== fromDigits) return false
  if (config.ownerWaNumbers.length === 0 && anyWhatsappLinked()) {
    // Some device is linked, but not to this sender and deviceForWhatsapp fell back to it — reject.
    const linkedIsThisSender = device && normalizeWaNumber(device.whatsappNumber ?? '') === fromDigits
    if (!linkedIsThisSender) return false
  }
  return true
}

async function handleInbound(from: string, type: string, text: string | null): Promise<void> {
  if (!isAuthorizedSender(from)) {
    log.warn({ from }, 'Dropping WhatsApp message from a non-owner sender')
    return
  }
  const device = deviceForWhatsapp(from)
  if (!device) {
    await sendText(from, 'Open the Otto app on your phone first so it can pair.')
    return
  }
  // Stamp the 24h window FIRST, for every inbound including non-text: a voice note still reopens
  // the window even though Otto can't read it, and everything proactive depends on this clock.
  markInbound(device.deviceId)

  // Non-text (voice note, image, …): tell the owner instead of silently eating the command. Make
  // it reminder-aware — answering a nudge with a voice note would otherwise leave the reminder
  // unresolved and Otto nagging forever, which is the worst failure mode of the whole feature.
  if (text === null) {
    log.info({ from, type }, 'Ignoring non-text WhatsApp message')
    const open = listReminders(device.deviceId, { state: 'open' })
    const hint =
      open.length === 1 && open[0]
        ? ` If that was about "${open[0].title}", just send "done".`
        : open.length > 1
          ? ' If that was about a reminder, send "done" and tell me which one.'
          : ''
    await sendText(from, `I can only read text messages right now — please type your request.${hint}`)
    return
  }
  // Link only when the device has no number yet; never overwrite an existing owner binding.
  if (!device.whatsappNumber) linkWhatsapp(device.deviceId, from)

  // Start a fresh thread after a long silence — BEFORE the flush below, so anything delivered on
  // this contact lands in the new session and "done" stays resolvable. Durable knowledge (facts)
  // and the open-reminder list are injected from the database, so nothing is actually lost.
  if (maybeResetIdleSession(from)) {
    log.info({ from }, 'conversation idle; starting a fresh thread')
  }

  // Deliver anything queued while we couldn't reach them, BEFORE the agent turn, and record it as
  // Otto's own earlier turns — otherwise the model has no idea what it just said and a bare
  // "yep, done" is unresolvable.
  const fresh = getDevice(device.deviceId) ?? device
  await maybeCollapseBacklog(fresh, from)
  const delivered = await flushOutbox(from, device.deviceId)
  if (delivered.length > 0) appendAssistantTurns(from, device.deviceId, delivered)

  const reply = await runAgentTurn({ waUserId: from, device: fresh, text })
  await sendText(from, reply)
}
