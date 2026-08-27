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
import { ingestFailureMessage, ingestInbound } from '../services/ingest.js'
import { enqueueAndFlushRow, flushOutbox } from '../services/outbox.js'
import { listReminders } from '../services/reminders.js'
import { appendAssistantTurns, maybeResetIdleSession } from '../services/sessions.js'
import type { Device } from '../services/devices.js'
import { cancelWakeChecks } from '../services/wakeCheck.js'
import {
  normalizeWaNumber,
  parseInboundMessages,
  sendText,
  verifySignature,
  type InboundMessage,
} from '../services/whatsapp.js'

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
      enqueueForUser(msg.from, () => handleInbound(msg))
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

/**
 * The "and if that was about a reminder, here's how to resolve it" tail.
 *
 * Appended to EVERY degraded reply, and that is the entire intent of this code: answering a nudge
 * with something Otto cannot read must never leave the reminder open and Otto nagging forever. A
 * dead end mid-chase is the worst failure mode the inbound path has.
 */
function reminderHint(device: Device): string {
  const open = listReminders(device.deviceId, { state: 'open' })
  if (open.length === 1 && open[0]) return ` If that was about "${open[0].title}", just send "done".`
  if (open.length > 1) return ' If that was about a reminder, send "done" and tell me which one.'
  return ''
}

async function handleInbound(msg: InboundMessage): Promise<void> {
  const from = msg.from
  if (!isAuthorizedSender(from)) {
    log.warn({ from }, 'Dropping WhatsApp message from a non-owner sender')
    return
  }
  const device = deviceForWhatsapp(from)
  if (!device) {
    await sendText(from, 'Open the Otto app on your phone first so it can pair.')
    return
  }
  // Stamp the 24h window FIRST, for every inbound including ones we end up unable to read: an
  // unreadable message still reopens the window, and everything proactive depends on this clock.
  markInbound(device.deviceId)
  // They are demonstrably awake, so stop asking. Here — right after markInbound and BEFORE the
  // non-text return below — because a voice note answers "you up?" just as well as typing does.
  cancelWakeChecks(device.deviceId)

  // Download, transcribe, narrow — all of it in services/ingest.ts, so what reaches the agent is
  // either content or a reason. A photo becomes content blocks and a voice note becomes a plain
  // string; from here on both are just "the user turn" and follow the identical path.
  const ingested = await ingestInbound(msg)
  if (!ingested.ok) {
    log.info({ from, type: msg.type, reason: ingested.reason }, 'inbound message could not be ingested')
    await sendText(from, ingestFailureMessage(ingested.reason, ingested.noun) + reminderHint(device))
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

  const reply = await runAgentTurn({ waUserId: from, device: fresh, content: ingested.content })

  // The reply goes out like everything else Otto says, rather than through a bare `sendText`.
  //
  // This was the one outbound message in the system with no outbox row and no retry:
  // a Meta 5xx or a timeout meant the owner asked a
  // question, Otto composed an answer, spent whatever it cost, wrote it into the transcript as
  // though it had been said — and they simply never got it. Every other kind of message has a
  // durable row behind it, and the reply is the one they are actively waiting for.
  //
  // `enqueueAndFlushRow` sends it immediately when the window is open, which for an inbound reply
  // it always is, so the ordinary path is unchanged. What is new is what happens when that fails:
  // the row survives, the five-minute sweep retries it, and if the window has shut in the meantime
  // it goes to the phone as a notification.
  //
  // No dedupeKey: two identical replies to two identical questions are two different messages, and
  // the partial unique index spans the whole table.
  await enqueueAndFlushRow({
    waUserId: from,
    deviceId: device.deviceId,
    kind: 'reply',
    body: reply,
    // The owner is right here and just spoke. Matching the flush at the top of this handler, which
    // passes no `proactiveFor` for the same reason.
    proactive: false,
  })
}
