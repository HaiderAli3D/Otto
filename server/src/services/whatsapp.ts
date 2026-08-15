import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import { GRAPH_ATTEMPTS, GRAPH_BASE, graphFetch } from './metaGraph.js'

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
 * Meta's "you are outside the 24-hour customer service window" error — the expected failure for any
 * free-form proactive send while the window is shut, so it must be visible and actionable rather
 * than swallowed as a generic 4xx.
 *
 * A registered message template (`config.meta.template`) is the only legal way through a shut
 * window. It is optional: with none configured this error is simply terminal for that send and the
 * row waits in the outbox for the owner to make contact.
 */
export const META_ERROR_REENGAGEMENT = 131047

/**
 * Meta errors that mean the TEMPLATE ITSELF is wrong, not this one send: it doesn't exist, it is
 * pending/rejected, the language doesn't match, or the parameter count doesn't match the body.
 *
 * All four are permanent AND self-diagnosing, so the sender latches off after the first one. Without
 * that latch a mis-registered template burns a Graph call on every sweep, forever, to be told the
 * same thing — and a knock is attempted precisely when nobody is watching the logs.
 */
const TEMPLATE_FATAL_CODES = new Set([132000, 132001, 132005, 132007])

export type SendResult =
  | { ok: true }
  | { ok: false; permanent: boolean; status: number; metaCode?: number; outOfWindow: boolean; body: string }

const failed = (body: string): SendResult => ({ ok: false, permanent: true, status: 0, outOfWindow: false, body })

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
 * Send a plain-text WhatsApp message via the Cloud API. Transient failures (network throw, abort,
 * 429, 5xx) are retried up to 3 attempts; a permanent failure (other 4xx) is not. Logged, never
 * thrown — a broken reply must not crash the webhook.
 *
 * The retry envelope now lives in metaGraph.graphFetch, shared with the other Graph callers; what
 * stays here is the only part that is about WhatsApp text specifically — reading Meta's error code
 * out of the body so the outbox can tell "the window is shut, keep this queued" apart from "this
 * message is bad, give up". No-op when WhatsApp isn't configured.
 */
export async function sendText(toWaNumber: string, text: string): Promise<SendResult> {
  if (config.meta === null) return failed('whatsapp not configured')
  const result = await graphFetch(`${GRAPH_BASE}/${config.meta.phoneNumberId}/messages`, {
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
  if (result.ok) return { ok: true }

  if (!result.permanent) {
    log.error({ attempts: GRAPH_ATTEMPTS }, 'WhatsApp sendText failed after all retries — message dropped')
    return { ok: false, permanent: false, status: 0, outOfWindow: false, body: 'retries exhausted' }
  }

  const metaCode = metaErrorCode(result.body)
  const outOfWindow = metaCode === META_ERROR_REENGAGEMENT
  if (outOfWindow) {
    log.warn({ metaCode, toWaNumber }, 'WhatsApp send rejected: outside the 24h window')
  } else {
    log.error(
      { status: result.status, metaCode, body: result.body, attempts: result.attempts },
      'WhatsApp sendText failed (permanent)',
    )
  }
  return { ok: false, permanent: true, status: result.status, metaCode, outOfWindow, body: result.body }
}

/**
 * Latched off once Meta says the template is mis-registered. Module-level, so it survives for the
 * life of the process and every later knock short-circuits before spending a Graph call. Cleared
 * only by a restart, which is also when a fixed registration would be picked up.
 */
let templateDisabled = false

/**
 * Knock on a shut 24h window with the owner's APPROVED message template.
 *
 * This is the one send that is legal outside the window, and it is deliberately dumb: the template
 * body is fixed at registration time and all we supply are its {{n}} variables, so nothing Otto
 * composes goes out here. It does NOT reopen the window — the owner's reply does, and the normal
 * outbox flush then delivers the real queue.
 *
 * Never throws; returns the same SendResult shape as sendText so a caller can treat both alike.
 */
export async function sendTemplate(toWaNumber: string, params: string[]): Promise<SendResult> {
  if (config.meta === null) return failed('whatsapp not configured')
  const template = config.meta.template
  if (template === null) return failed('no message template configured')
  if (templateDisabled) return failed('template disabled after a permanent Meta rejection')

  const result = await graphFetch(`${GRAPH_BASE}/${config.meta.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.meta.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toWaNumber,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.lang },
        // Omit `components` entirely for a template with no variables: Meta rejects an empty
        // parameters array as a mismatch against a zero-variable body.
        components:
          params.length === 0
            ? []
            : [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
      },
    }),
  })
  if (result.ok) return { ok: true }

  if (!result.permanent) {
    log.error({ attempts: GRAPH_ATTEMPTS }, 'WhatsApp sendTemplate failed after all retries')
    return { ok: false, permanent: false, status: 0, outOfWindow: false, body: 'retries exhausted' }
  }

  const metaCode = metaErrorCode(result.body)
  if (metaCode !== undefined && TEMPLATE_FATAL_CODES.has(metaCode)) {
    templateDisabled = true
    log.error(
      { metaCode, template: template.name, lang: template.lang, body: result.body },
      'WhatsApp template is mis-registered; disabling template sends until restart',
    )
  } else {
    log.error({ status: result.status, metaCode, body: result.body }, 'WhatsApp sendTemplate failed (permanent)')
  }
  return {
    ok: false,
    permanent: true,
    status: result.status,
    metaCode,
    outOfWindow: metaCode === META_ERROR_REENGAGEMENT,
    body: result.body,
  }
}

/** Digits-only form of a WhatsApp number, for allowlist comparison across "+44 …" vs "44…". */
export function normalizeWaNumber(n: string): string {
  return n.replace(/\D/g, '')
}

/**
 * The attachment on an inbound message, as far as the webhook payload knows it.
 *
 * `mediaId` is an OPAQUE HANDLE, not a URL: the bytes need a two-hop authenticated download (see
 * services/media.ts). `mimeType` is what Meta claims here and is only a hint — the download re-reads
 * it from the media metadata, which is authoritative.
 *
 * `voice` distinguishes a recorded voice note from an attached audio FILE. Both transcribe the same
 * way; the difference is only what Otto calls it when he has to apologise for one.
 */
export type InboundMedia = {
  mediaId: string
  mimeType: string
  voice: boolean
  sha256?: string
  filename?: string
}

/**
 * One inbound message. `text` carries a text message's body and is null for everything else, which
 * is what the ingest pipeline keys on to decide whether a download is needed at all.
 *
 * `caption` and `media` are OMITTED rather than set to null when absent. That is deliberate: it
 * keeps a plain text message's shape byte-identical to what it was before attachments existed, so
 * neither a caller nor a `toEqual` assertion has to grow a branch for a key that is never useful.
 */
export type InboundMessage = {
  id: string
  from: string
  type: string
  text: string | null
  caption?: string
  media?: InboundMedia
}

/**
 * Message types that carry a media handle. `location` and `contacts` are absent on purpose: they
 * have inline payloads rather than a media id, and ingest rejects them by type anyway.
 */
const MEDIA_TYPES = new Set(['audio', 'image', 'document', 'video', 'sticker'])

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/**
 * Safely walk the WhatsApp webhook payload (`body.entry[].changes[].value.messages[]`) and
 * collect inbound messages (with their wamid for dedupe). Text messages carry their body; a media
 * message carries its handle so the caller can download and ingest it. Status/read receipts have no
 * `messages[]` and are naturally skipped. Defensive against any missing/misshapen level; returns [].
 *
 * A media block WITHOUT a string `id` degrades to a message with no `media` — ingest then reports it
 * as unsupported and the owner gets a friendly reply, which is strictly better than a download of
 * `undefined`. `context` (quoted replies) is deliberately NOT parsed: outbound wamids are recorded
 * nowhere, so there is nothing to resolve a quote against, and a field nothing can consume reads as
 * a capability that does not exist.
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
        const msg = message as Record<string, unknown> | null | undefined
        if (!msg || typeof msg.from !== 'string' || typeof msg.type !== 'string' || typeof msg.id !== 'string') continue
        const text =
          msg.type === 'text' && typeof (msg.text as { body?: unknown } | undefined)?.body === 'string'
            ? ((msg.text as { body: string }).body)
            : null
        const parsed: InboundMessage = { id: msg.id, from: msg.from, type: msg.type, text }

        if (MEDIA_TYPES.has(msg.type)) {
          const blob = msg[msg.type] as Record<string, unknown> | undefined
          const mediaId = str(blob?.id)
          if (mediaId) {
            const media: InboundMedia = {
              mediaId,
              mimeType: typeof blob?.mime_type === 'string' ? blob.mime_type : '',
              voice: blob?.voice === true,
            }
            const sha256 = str(blob?.sha256)
            if (sha256) media.sha256 = sha256
            const filename = str(blob?.filename)
            if (filename) media.filename = filename
            parsed.media = media
          }
          // The caption lives INSIDE the media block (image/video/document), never beside it.
          const caption = str(blob?.caption)
          if (caption) parsed.caption = caption
        }
        out.push(parsed)
      }
    }
  }
  return out
}
