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

const SEND_ATTEMPTS = 3
const RETRY_DELAYS_MS = [500, 1500]
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Meta's "you are outside the 24-hour customer service window" error. Because the owner chose not
 * to register message templates, this is the expected failure for any proactive send while the
 * window is shut — it must be visible and actionable, not swallowed as a generic 4xx.
 */
export const META_ERROR_REENGAGEMENT = 131047

export type SendResult =
  | { ok: true }
  | { ok: false; permanent: boolean; status: number; metaCode?: number; outOfWindow: boolean; body: string }

function metaErrorCode(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } }
    const code = parsed.error?.code
    return typeof code === 'number' ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Send a plain-text WhatsApp message via the Cloud API. Transient failures (network throw, 429,
 * 5xx) are retried up to 3 attempts; a permanent failure (other 4xx) is not. Logged, never
 * thrown — a broken reply must not crash the webhook.
 *
 * Returns a structured result so the outbox can tell "the window is shut, keep this queued" apart
 * from "this message is bad, give up". No-op when WhatsApp isn't configured.
 */
export async function sendText(toWaNumber: string, text: string): Promise<SendResult> {
  if (config.meta === null) {
    return { ok: false, permanent: true, status: 0, outOfWindow: false, body: 'whatsapp not configured' }
  }
  const url = `https://graph.facebook.com/v22.0/${config.meta.phoneNumberId}/messages`
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: toWaNumber,
    type: 'text',
    text: { body: text },
  })

  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.meta.accessToken}`,
          'Content-Type': 'application/json',
        },
        body,
      })
      if (res.ok) return { ok: true }
      const responseText = await res.text().catch(() => '')
      if (res.status !== 429 && res.status < 500) {
        const metaCode = metaErrorCode(responseText)
        const outOfWindow = metaCode === META_ERROR_REENGAGEMENT
        if (outOfWindow) {
          log.warn({ metaCode, toWaNumber }, 'WhatsApp send rejected: outside the 24h window')
        } else {
          log.error({ status: res.status, metaCode, body: responseText, attempt }, 'WhatsApp sendText failed (permanent)')
        }
        return { ok: false, permanent: true, status: res.status, metaCode, outOfWindow, body: responseText }
      }
      log.warn({ status: res.status, attempt }, 'WhatsApp sendText failed; retrying')
    } catch (err) {
      log.warn({ err, attempt }, 'WhatsApp sendText threw; retrying')
    }
    if (attempt < SEND_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 1500)
  }
  log.error({ attempts: SEND_ATTEMPTS }, 'WhatsApp sendText failed after all retries — message dropped')
  return { ok: false, permanent: false, status: 0, outOfWindow: false, body: 'retries exhausted' }
}

/** Digits-only form of a WhatsApp number, for allowlist comparison across "+44 …" vs "44…". */
export function normalizeWaNumber(n: string): string {
  return n.replace(/\D/g, '')
}

/** One inbound message: text carries `text`, any other real message type carries text=null. */
export type InboundMessage = { id: string; from: string; type: string; text: string | null }

/**
 * Safely walk the WhatsApp webhook payload (`body.entry[].changes[].value.messages[]`) and
 * collect inbound messages (with their wamid for dedupe). Text messages carry their body; other
 * real message types (audio/image/…) are returned with text=null so the caller can send an
 * "only text" fallback. Status/read receipts have no `messages[]` and are naturally skipped.
 * Defensive against any missing/misshapen level; returns [].
 */
export function parseInboundMessages(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = []
  const entries = (body as { entry?: unknown[] } | null | undefined)?.entry
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] } | null | undefined)?.changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } } | null | undefined)?.value?.messages
      if (!Array.isArray(messages)) continue
      for (const message of messages) {
        const msg = message as
          | { id?: string; type?: string; from?: string; text?: { body?: string } }
          | null
          | undefined
        if (!msg || typeof msg.from !== 'string' || typeof msg.type !== 'string' || typeof msg.id !== 'string') continue
        const text = msg.type === 'text' && typeof msg.text?.body === 'string' ? msg.text.body : null
        out.push({ id: msg.id, from: msg.from, type: msg.type, text })
      }
    }
  }
  return out
}
