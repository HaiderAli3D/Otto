import type Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import {
  AUDIO_MIME_ALLOW,
  IMAGE_MIME_ALLOW,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  fetchMedia,
  type MediaFailure,
} from './media.js'
import { transcribe } from './stt.js'
import type { InboundMessage } from './whatsapp.js'

/**
 * The ONE place an inbound WhatsApp message becomes something the agent can be given.
 *
 * It exists so the route stays a route: everything about downloads, transcription, mime narrowing
 * and block ordering lives here, and `routes/whatsapp.ts` sees a two-case result — content, or a
 * reason it can apologise for. That split is also what makes any of this testable, since the route
 * itself can only be reached through a signed webhook.
 */

export type IngestFailure =
  | 'stt_unconfigured'
  | 'unsupported_type'
  | 'unsupported_mime'
  | 'download_failed'
  | 'too_large'
  | 'transcribe_failed'
  | 'empty_transcript'
  | 'malformed'

export type IngestResult =
  | { ok: true; source: 'text' | 'voice' | 'image'; content: string | Anthropic.ContentBlockParam[] }
  | { ok: false; reason: IngestFailure; noun: string }

/** Exactly Anthropic's image union, derived from the allowlist so the two can never drift. */
type ImageMediaType = (typeof IMAGE_MIME_ALLOW)[number]

function narrowImageMime(mime: string): ImageMediaType | null {
  return (IMAGE_MIME_ALLOW as readonly string[]).includes(mime) ? (mime as ImageMediaType) : null
}

/**
 * What Otto calls the thing he cannot read. Used only in the apology, so it is prose, not a type
 * tag — the point is that "I can't open a video" is answerable and "unsupported_type" is not.
 */
const NOUNS: Record<string, string> = {
  video: 'a video',
  document: 'a document',
  sticker: 'a sticker',
  location: 'a location',
  contacts: 'a contact card',
  contact: 'a contact card',
}

function nounFor(type: string): string {
  return NOUNS[type] ?? 'that'
}

function fromMediaFailure(reason: MediaFailure): IngestFailure {
  if (reason === 'too_large') return 'too_large'
  if (reason === 'unsupported_mime') return 'unsupported_mime'
  return 'download_failed'
}

/**
 * Turn one inbound message into agent content.
 *
 * Stickers are excluded on purpose rather than by omission: they are usually animated webp (which
 * the image block rejects outright), they carry near-zero task intent, and passing one through
 * would trade a real 400 for nothing.
 */
export async function ingestInbound(msg: InboundMessage): Promise<IngestResult> {
  if (msg.type === 'text') {
    if (msg.text === null || msg.text.trim().length === 0) {
      return { ok: false, reason: 'malformed', noun: 'that message' }
    }
    // Unchanged, not trimmed or normalised: this is the owner's message and the fast path is the
    // whole point — a text message must cost exactly what it cost before this pipeline existed.
    return { ok: true, source: 'text', content: msg.text }
  }
  if (msg.type === 'audio') return await ingestAudio(msg)
  if (msg.type === 'image') return await ingestImage(msg)
  return { ok: false, reason: 'unsupported_type', noun: nounFor(msg.type) }
}

/**
 * Voice note -> a PLAIN STRING, deliberately.
 *
 * The transcript IS the owner's own words, so it belongs in the conversation as a normal user turn:
 * it persists, it is cheap, it reads back correctly on the next turn, and voice stays entirely on
 * the existing string fast path instead of doubling every downstream shape into "string or blocks".
 */
async function ingestAudio(msg: InboundMessage): Promise<IngestResult> {
  const noun = msg.media?.voice === false ? 'an audio file' : 'a voice note'
  // Checked FIRST, before any download: with no STT provider the bytes are useless, and spending a
  // two-hop Graph download to arrive at the same apology is pure waste on the owner's own latency.
  if (config.stt === null) return { ok: false, reason: 'stt_unconfigured', noun }
  if (!msg.media) return { ok: false, reason: 'malformed', noun }

  const got = await fetchMedia(msg.media.mediaId, { allow: AUDIO_MIME_ALLOW, maxBytes: MAX_AUDIO_BYTES })
  if (!got.ok) {
    log.warn({ reason: got.reason, detail: got.detail }, 'voice note download failed')
    return { ok: false, reason: fromMediaFailure(got.reason), noun }
  }

  const said = await transcribe(got.bytes, got.mimeType)
  if (!said.ok) {
    log.warn({ reason: said.reason, detail: said.detail }, 'transcription failed')
    if (said.reason === 'empty') return { ok: false, reason: 'empty_transcript', noun }
    if (said.reason === 'unconfigured') return { ok: false, reason: 'stt_unconfigured', noun }
    return { ok: false, reason: 'transcribe_failed', noun }
  }
  return { ok: true, source: 'voice', content: said.text }
}

/**
 * Photo -> `[image, text]`, in that order, and the order is load-bearing.
 *
 * `withConversationCacheBreakpoint` in agent/runner.ts spreads `cache_control` onto the LAST block
 * of the last message. On a small text block that is free; on the image block it would ask the API
 * to cache a quarter-megabyte of base64 for a turn that is about to be answered once. Anthropic's
 * own guidance is image-then-text anyway, so this costs nothing to honour.
 *
 * No describe-the-image call is made: the model's own reply already describes the photo, for zero
 * extra cost, and `stripAttachments` replaces the bytes with that description when the session is
 * saved — so nothing here is persisted.
 */
async function ingestImage(msg: InboundMessage): Promise<IngestResult> {
  const noun = 'that photo'
  if (!msg.media) return { ok: false, reason: 'malformed', noun }

  const got = await fetchMedia(msg.media.mediaId, { allow: IMAGE_MIME_ALLOW, maxBytes: MAX_IMAGE_BYTES })
  if (!got.ok) {
    log.warn({ reason: got.reason, detail: got.detail }, 'photo download failed')
    return { ok: false, reason: fromMediaFailure(got.reason), noun }
  }
  const mediaType = narrowImageMime(got.mimeType)
  if (mediaType === null) return { ok: false, reason: 'unsupported_mime', noun }

  const caption = msg.caption?.trim()
  return {
    ok: true,
    source: 'image',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: got.bytes.toString('base64') } },
      // Never an empty string: the API rejects an empty text block, and "no caption" is itself
      // information — it tells the model the photo has to carry the whole request on its own.
      { type: 'text', text: caption && caption.length > 0 ? caption : '(photo, no caption)' },
    ],
  }
}

/**
 * What Otto says when he could not read something. Every failure gets copy that names what went
 * wrong AND tells the owner the one thing that always works, because the caller appends the
 * reminder hint to this and a dead end mid-nag is the failure mode the whole feature exists to fix.
 *
 * `stt_unconfigured` is verbatim the reply this pipeline replaced. With no STT provider that
 * sentence is still exactly true, and keeping it identical is the visible half of "voice is built
 * but off".
 */
export function ingestFailureMessage(reason: IngestFailure, noun: string): string {
  switch (reason) {
    case 'stt_unconfigured':
      return 'I can only read text messages right now — please type your request.'
    case 'unsupported_type':
      return `I can't open ${noun} — tell me what's in it and I'll take it from there.`
    case 'unsupported_mime':
      return "I couldn't open that file — send it as a photo (JPEG or PNG), or just type it."
    case 'download_failed':
      return `I couldn't fetch ${noun} from WhatsApp — send it again, or type it and I'll sort it.`
    case 'too_large':
      return `I couldn't open ${noun} — it's too big. Send a smaller one, or type it.`
    case 'transcribe_failed':
      return `I couldn't make out ${noun} — type it and I'll sort it.`
    case 'empty_transcript':
      return `I couldn't hear anything in ${noun} — type it and I'll sort it.`
    case 'malformed':
      return "Something came through that I couldn't read — type it and I'll sort it."
  }
}
