import { config } from '../config.js'
import { log } from '../lib/log.js'
import { GRAPH_BASE, graphFetch } from './metaGraph.js'

/**
 * `'audio/ogg; codecs=opus'` -> `'audio/ogg'`. WhatsApp voice notes always carry the codec
 * parameter, so an allowlist compared against the raw header would reject every single one.
 */
export function baseMime(raw: string): string {
  return (raw.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * Exactly the four types Anthropic's image block accepts. Kept `as const` because ingest narrows a
 * downloaded mime type to this union — if the two lists ever drift, that narrowing stops compiling,
 * which is the point.
 */
export const IMAGE_MIME_ALLOW = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

/**
 * What WhatsApp actually sends for audio. `audio/ogg` is the voice note; the rest arrive when the
 * owner attaches a file. Nothing here is passed to Anthropic — it all goes to the STT provider,
 * which accepts far more than this, so the list is about refusing to download a video someone
 * mislabelled rather than about what can be transcribed.
 */
export const AUDIO_MIME_ALLOW = [
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/flac',
] as const

/**
 * Size caps, enforced twice (see fetchMedia). The image cap is about the Anthropic request: a photo
 * is re-encoded to base64, which is ~33% bigger again, and it is sent inline in the user turn. The
 * audio cap is the common ceiling for a hosted Whisper endpoint.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024

export type MediaFailure = 'unconfigured' | 'not_found' | 'too_large' | 'unsupported_mime' | 'network'

export type MediaResult =
  | { ok: true; bytes: Buffer; mimeType: string }
  | { ok: false; reason: MediaFailure; detail: string }

/**
 * Download one inbound attachment. Two hops, and BOTH of them are authenticated.
 *
 * Hop 1 `GET /{mediaId}` returns metadata — mime type, size, and a short-lived `url` on Meta's
 * lookaside CDN. Hop 2 fetches that url. The single most common way to get this wrong is to treat
 * the lookaside url as a public link: it is not, it 401s without the SAME `Authorization: Bearer`
 * header as hop 1, and the failure looks like an expired link rather than a missing header.
 *
 * The mime and size checks run BEFORE hop 2 whenever hop 1 gave us enough to judge, so a 40 MB
 * video never touches this process's memory. `file_size` is not guaranteed, so the real byte length
 * is checked again afterwards — the first check is an optimisation, the second is the actual rule.
 *
 * Returns raw bytes, never base64: the caller decides the block shape, and base64 here would mean
 * carrying a 33%-inflated copy through the one path (voice) that does not want it at all.
 */
export async function fetchMedia(
  mediaId: string,
  opts: { allow: readonly string[]; maxBytes: number },
): Promise<MediaResult> {
  // Same guard as sendText: with no WhatsApp credentials there is no Graph call to make, and the
  // caller gets a reason it can turn into an apology rather than an exception.
  if (config.meta === null) return { ok: false, reason: 'unconfigured', detail: 'whatsapp not configured' }
  const auth = { Authorization: `Bearer ${config.meta.accessToken}` }

  const meta = await graphFetch(`${GRAPH_BASE}/${encodeURIComponent(mediaId)}`, { headers: auth })
  if (!meta.ok) {
    return {
      ok: false,
      reason: meta.permanent ? 'not_found' : 'network',
      detail: `media metadata ${meta.status}: ${meta.body.slice(0, 200)}`,
    }
  }

  let payload: { url?: unknown; mime_type?: unknown; file_size?: unknown }
  try {
    payload = (await meta.res.json()) as typeof payload
  } catch (err) {
    log.warn({ err, mediaId }, 'media metadata was not JSON')
    return { ok: false, reason: 'network', detail: 'media metadata was not JSON' }
  }

  const url = typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : null
  if (url === null) return { ok: false, reason: 'not_found', detail: 'media metadata carried no download url' }

  // The metadata mime type wins over whatever the webhook claimed — this one came from the file.
  const mimeType = baseMime(typeof payload.mime_type === 'string' ? payload.mime_type : '')
  if (!opts.allow.includes(mimeType)) {
    return { ok: false, reason: 'unsupported_mime', detail: mimeType || 'unknown mime type' }
  }
  const declared = typeof payload.file_size === 'number' ? payload.file_size : null
  if (declared !== null && declared > opts.maxBytes) {
    return { ok: false, reason: 'too_large', detail: `${declared} bytes exceeds ${opts.maxBytes}` }
  }

  const download = await graphFetch(url, { headers: auth })
  if (!download.ok) {
    return {
      ok: false,
      reason: download.permanent ? 'not_found' : 'network',
      detail: `media download ${download.status}: ${download.body.slice(0, 200)}`,
    }
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(await download.res.arrayBuffer())
  } catch (err) {
    log.warn({ err, mediaId }, 'media download body could not be read')
    return { ok: false, reason: 'network', detail: 'media download body could not be read' }
  }
  if (bytes.byteLength === 0) return { ok: false, reason: 'not_found', detail: 'media download was empty' }
  if (bytes.byteLength > opts.maxBytes) {
    return { ok: false, reason: 'too_large', detail: `${bytes.byteLength} bytes exceeds ${opts.maxBytes}` }
  }
  return { ok: true, bytes, mimeType }
}
