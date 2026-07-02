import type { FastifyInstance } from 'fastify'
import { runAgentTurn } from '../agent/runner.js'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import { anyWhatsappLinked, claimWhatsappMessage, deviceForWhatsapp, linkWhatsapp } from '../services/devices.js'
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
  // Non-text (voice note, image, …): tell the owner instead of silently eating the command.
  if (text === null) {
    log.info({ from, type }, 'Ignoring non-text WhatsApp message')
    await sendText(from, "I can only read text messages right now — please type your request (e.g. “wake me at 7am”).")
    return
  }
  // Link only when the device has no number yet; never overwrite an existing owner binding.
  if (!device.whatsappNumber) linkWhatsapp(device.deviceId, from)
  const reply = await runAgentTurn({ waUserId: from, device, text })
  await sendText(from, reply)
}
