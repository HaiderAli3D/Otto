import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { log } from '../lib/log.js'

/**
 * Verify Meta's `X-Hub-Signature-256` header against the raw request bytes.
 * The header is `sha256=<hex>` where the hex is HMAC-SHA256(rawBody, appSecret).
 * Returns false when WhatsApp isn't configured, the header is missing, or the
 * digests differ (compared in constant time).
 */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (config.meta === null) return false
  if (!signatureHeader) return false
  const expected = 'sha256=' + createHmac('sha256', config.meta.appSecret).update(rawBody).digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signatureHeader, 'utf8')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

/**
 * Send a plain-text WhatsApp reply via the Cloud API. A failed send is logged, never thrown —
 * a broken reply must not crash the webhook. No-op when WhatsApp isn't configured.
 */
export async function sendText(toWaNumber: string, text: string): Promise<void> {
  if (config.meta === null) return
  const url = `https://graph.facebook.com/v22.0/${config.meta.phoneNumberId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.meta.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toWaNumber,
      type: 'text',
      text: { body: text },
    }),
  })
  if (!res.ok) {
    const responseText = await res.text().catch(() => '')
    log.warn({ status: res.status, body: responseText }, 'WhatsApp sendText failed')
  }
}

/**
 * Safely walk the WhatsApp webhook payload (`body.entry[].changes[].value.messages[]`) and
 * collect inbound text messages. Defensive against any missing/misshapen level; returns [].
 */
export function parseInboundTextMessages(body: unknown): Array<{ from: string; text: string }> {
  const out: Array<{ from: string; text: string }> = []
  const entries = (body as { entry?: unknown[] } | null | undefined)?.entry
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] } | null | undefined)?.changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } } | null | undefined)?.value?.messages
      if (!Array.isArray(messages)) continue
      for (const message of messages) {
        const msg = message as { type?: string; from?: string; text?: { body?: string } } | null | undefined
        if (msg?.type === 'text' && typeof msg.from === 'string' && typeof msg.text?.body === 'string') {
          out.push({ from: msg.from, text: msg.text.body })
        }
      }
    }
  }
  return out
}
