import type { FastifyInstance } from 'fastify'
import { runAgentTurn } from '../agent/runner.js'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import { deviceForWhatsapp, linkWhatsapp } from '../services/devices.js'
import { parseInboundTextMessages, sendText, verifySignature } from '../services/whatsapp.js'

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

    const messages = parseInboundTextMessages(req.body)
    for (const { from, text } of messages) {
      // One bad message must not stop the rest.
      void handleInbound(from, text).catch((err) => log.error({ err }, 'WhatsApp inbound handling failed'))
    }

    return reply
  })
}

async function handleInbound(from: string, text: string): Promise<void> {
  const device = deviceForWhatsapp(from)
  if (!device) {
    await sendText(from, 'Open the Otto app on your phone first so it can pair.')
    return
  }
  linkWhatsapp(device.deviceId, from)
  const reply = await runAgentTurn({ waUserId: from, device, text })
  await sendText(from, reply)
}
