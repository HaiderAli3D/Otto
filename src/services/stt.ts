import { config } from '../config.js'
import { log } from '../lib/log.js'
import { baseMime, MAX_AUDIO_BYTES } from './media.js'

/**
 * Speech-to-text for WhatsApp voice notes, against any OpenAI-compatible
 * `POST /audio/transcriptions` endpoint (the configured default is Groq's Whisper).
 *
 * Built but OFF: the owner deliberately provisioned no key, so `config.stt` is null and every call
 * here returns `unconfigured` WITHOUT touching the network. That is the guarantee this module owes
 * the rest of the system — turning voice on later is one environment variable, and until then the
 * behaviour is exactly what it was before this file existed.
 */

/** One retry only. This sits in front of an agent turn the owner is actively waiting on, so a slow
 * second attempt is felt directly; three would be worse than an honest "type it out". */
const ATTEMPTS = 2

/** Generous, because a 60-second voice note genuinely takes a while to come back. */
const TIMEOUT_MS = 20_000

export type SttFailure = 'unconfigured' | 'empty' | 'too_large' | 'provider'

export type SttResult = { ok: true; text: string } | { ok: false; reason: SttFailure; detail: string }

/**
 * Whisper-style endpoints infer the container from the FILENAME extension, not from the multipart
 * content type, and reject an unrecognised one. So the mime type has to become an extension here or
 * every voice note comes back as a 400.
 */
const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
}

/**
 * The multipart body, built with the global FormData/Blob Node 20 already ships — no dependency,
 * and `fetch` sets the boundary itself, which is the part hand-rolled multipart always gets wrong.
 *
 * Exported separately from `transcribe` so the request shape is testable with no API key and no
 * network, which is the only way it can be tested at all on this deployment.
 */
export function buildTranscriptionBody(bytes: Buffer, mimeType: string, model: string): FormData {
  const base = baseMime(mimeType)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: base || 'application/octet-stream' }), `audio.${EXTENSIONS[base] ?? 'ogg'}`)
  form.append('model', model)
  form.append('response_format', 'json')
  // Transcription, not creative writing: nothing about a voice note is improved by sampling.
  form.append('temperature', '0')
  return form
}

/**
 * Pull the transcript out of a `response_format=json` reply. Returns null for anything that isn't a
 * usable transcript — a missing field, a non-string, or whitespace — so "the provider answered 200
 * with nothing in it" is one case at the call site rather than an empty string flowing onward and
 * reaching the agent as a blank user turn.
 */
export function readTranscriptionText(raw: unknown): string | null {
  const text = (raw as { text?: unknown } | null | undefined)?.text
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Transcribe one audio clip. Never throws.
 *
 * Retry classification matches metaGraph.graphFetch deliberately — a throw (network, abort), a 429,
 * or a 5xx gets the one retry; any other non-2xx is the provider telling us something that will not
 * change, and re-sending several megabytes to hear it again is pure latency.
 */
export async function transcribe(bytes: Buffer, mimeType: string): Promise<SttResult> {
  if (config.stt === null) return { ok: false, reason: 'unconfigured', detail: 'no STT provider configured' }
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty', detail: 'no audio bytes' }
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return { ok: false, reason: 'too_large', detail: `${bytes.byteLength} bytes exceeds ${MAX_AUDIO_BYTES}` }
  }

  const { apiKey, baseUrl, model } = config.stt
  let detail = 'no attempt completed'
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        // Rebuilt per attempt: a FormData that has already been streamed cannot be sent again.
        body: buildTranscriptionBody(bytes, mimeType, model),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) {
        const text = readTranscriptionText(await res.json().catch(() => null))
        if (text === null) return { ok: false, reason: 'empty', detail: 'provider returned no transcript' }
        return { ok: true, text }
      }
      const body = await res.text().catch(() => '')
      detail = `${res.status}: ${body.slice(0, 200)}`
      if (res.status !== 429 && res.status < 500) return { ok: false, reason: 'provider', detail }
      log.warn({ status: res.status, attempt }, 'transcription failed; retrying')
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err)
      log.warn({ err, attempt }, 'transcription threw; retrying')
    }
  }
  return { ok: false, reason: 'provider', detail }
}
