import type Anthropic from '@anthropic-ai/sdk'
import { log } from './log.js'

export type Msg = Anthropic.MessageParam

/**
 * Keep the recent conversation only — enough for coherent threads without unbounded growth.
 *
 * Counted in *messages*, not turns: each tool step appends 2 (assistant tool_use + user
 * tool_result), so a 10-step turn eats 20 on its own. 60 leaves room for a tool-heavy turn without
 * evaporating the previous one. Prompt caching keeps the cost of the wider window near zero.
 */
export const MAX_MESSAGES = 60

/**
 * Hard ceiling on the serialized transcript, independent of the message count.
 *
 * MAX_MESSAGES bounds how MANY messages persist, not how BIG they are: one attachment or one
 * pathological tool_result is megabytes on its own. `sessions.messages` is JSON.parse'd on every
 * turn and re-sent to the API, so an unbounded column is a per-turn tax that never expires.
 */
export const MAX_SESSION_BYTES = 256 * 1024

/**
 * Can this message legally START a conversation sent to the API?
 *
 * Anthropic requires a leading USER turn and rejects a leading `tool_result` (whose paired
 * `tool_use` was trimmed away). It does NOT require the content to be a string — a photo turn is a
 * content-block ARRAY, and the old `typeof content === 'string'` test silently discarded every one
 * of them, so an image the owner sent could vanish from the transcript with no error anywhere.
 */
function isValidStart(m: Msg | undefined): boolean {
  if (!m || m.role !== 'user') return false
  if (typeof m.content === 'string') return true
  // The API rejects empty content outright, so an empty array can never open a conversation.
  if (!Array.isArray(m.content) || m.content.length === 0) return false
  // The runner packs ALL results for one assistant turn into a SINGLE user message, so a surviving
  // tool_result means its paired tool_use was trimmed away — the whole message is an orphan.
  return !m.content.some((b) => b.type === 'tool_result')
}

/** Advance past every message that cannot legally open a conversation. */
function advanceToValidStart(messages: Msg[]): Msg[] {
  let start = 0
  while (start < messages.length && !isValidStart(messages[start])) start++
  return messages.slice(start)
}

/**
 * Trim history to the most recent turns, then advance the start to the first message that can
 * legally open a conversation (see `isValidStart`), then enforce the byte cap.
 *
 * Returning a normalized array keeps a long, tool-heavy conversation from ever persisting an
 * invalid leading shape that the API would reject on the next call. Pure (no DB) so it is
 * unit-tested.
 */
export function trimToValidStart(messages: Msg[], max: number = MAX_MESSAGES): Msg[] {
  let result = advanceToValidStart(messages.slice(-max))
  if (serializedBytes(result) <= MAX_SESSION_BYTES) return result

  // Over the cap: drop from the FRONT (oldest first) and re-run the valid-start scan after each
  // drop, so whatever survives is still a legal opening rather than a bare tool_result.
  //
  // `> 1`, NOT `> 0`, is load-bearing. One oversized message — a photo, or a pathological
  // tool_result — can never be brought under the cap by deleting the messages around it, so a
  // `> 0` loop runs until the array is empty and silently wipes the whole conversation. Keeping
  // the last message is strictly better: an over-cap column is a cost problem, a vanished
  // transcript is a correctness one.
  const before = result.length
  while (result.length > 1 && serializedBytes(result) > MAX_SESSION_BYTES) {
    result = advanceToValidStart(result.slice(1))
  }
  const bytes = serializedBytes(result)
  log.warn(
    { cap: MAX_SESSION_BYTES, bytes, dropped: before - result.length, kept: result.length },
    bytes > MAX_SESSION_BYTES
      ? 'session history is over the byte cap in a SINGLE message; keeping it rather than wiping the thread'
      : 'session history exceeded the byte cap; dropped the oldest messages',
  )
  return result
}

/**
 * Serialized size in real UTF-8 bytes, which is what the SQLite TEXT column actually stores.
 *
 * `String.length` counts UTF-16 code units, so an emoji-heavy or CJK transcript measures at half
 * to a third of its true size and slips past a cap named in bytes.
 */
function serializedBytes(messages: Msg[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8')
}

/**
 * Replace persisted attachments with a short text stand-in. Returns a COPY; the input is untouched.
 *
 * A WhatsApp photo is ~250KB of base64. `sessions.messages` has no size cap of its own and is
 * JSON.parse'd on every single turn, so persisting one would re-read it and re-send it to the API
 * for up to MAX_MESSAGES messages afterwards. The model already described the photo in its reply,
 * and that description — not the pixels — is what the rest of the thread actually needs.
 *
 * The stand-in collapses the whole message to a plain STRING rather than a one-element array: it is
 * the smallest persisted form, and it keeps stripped turns on the string fast path in
 * `isValidStart`. Text, tool_use and tool_result blocks are left exactly as they were.
 *
 * KNOWN LIMIT: only TOP-LEVEL image blocks are stripped. An image nested inside a
 * `tool_result.content` array would survive with its base64 intact. Unreachable today — inbound
 * photos arrive as a top-level user turn and no tool returns image content — but anything that
 * later makes a tool return an image must extend this, or it reintroduces exactly the per-turn
 * cost this function exists to remove.
 */
export function stripAttachments(messages: Msg[]): Msg[] {
  return messages.map((m) => {
    if (typeof m.content === 'string' || !Array.isArray(m.content)) return m
    if (!m.content.some((b) => b.type === 'image')) return m
    const caption = m.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
      .map((b) => b.text.trim())
      .filter((t) => t.length > 0)
      .join(' ')
    return { ...m, content: caption ? `[photo the owner sent: "${caption}"]` : '[photo the owner sent]' }
  })
}
