import type OpenAI from 'openai'
import { log } from './log.js'

/**
 * One persisted conversation ITEM — deliberately not "message".
 *
 * The Responses API's unit of conversation is an item, and only some items have a role: a
 * `function_call`, a `function_call_output` and a `reasoning` item are PEERS of a message, not
 * blocks nested inside one. That is the single biggest shape change in this file, and the reason
 * the type is no longer called `Msg`: the old name invites `push({ role, content: results })`,
 * which is exactly the construction that no longer exists.
 */
export type Item = OpenAI.Responses.ResponseInputItem

/**
 * Keep the recent conversation only — enough for coherent threads without unbounded growth.
 *
 * Counted in ITEMS, not turns, and one tool step is no longer worth 2. A step with three tool calls
 * appends one assistant message, three `function_call`s and three `function_call_output`s — seven
 * items where the old batched shape cost two. 120 is the old 60 re-scaled so a single tool-heavy
 * turn still cannot evaporate the previous one. Prompt caching keeps the cost of the wider window
 * near zero.
 */
export const MAX_ITEMS = 120

/**
 * Hard ceiling on the serialized transcript, independent of the item count.
 *
 * MAX_ITEMS bounds how MANY items persist, not how BIG they are: one attachment or one pathological
 * tool result is megabytes on its own. `sessions.messages` is JSON.parse'd on every turn and
 * re-sent to the API, so an unbounded column is a per-turn tax that never expires.
 */
export const MAX_SESSION_BYTES = 256 * 1024

/**
 * The discriminant. `EasyInputMessage` — the `{ role, content }` shorthand this codebase writes by
 * hand — omits `type` entirely; every other member of the union carries one.
 */
function itemType(item: Item): string {
  return 'type' in item && typeof item.type === 'string' ? item.type : 'message'
}

/** The content of a message-shaped item, or null for calls, outputs and reasoning items. */
function messageContent(item: Item): string | unknown[] | null {
  if (!('content' in item)) return null
  const content = (item as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content
  return null
}

function partType(part: unknown): string | null {
  if (typeof part !== 'object' || part === null) return null
  const type = (part as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

/**
 * Can this item legally START a conversation sent to the API?
 *
 * Two rules, and the second is the one that carries the weight:
 *
 * 1. It must be a user message. The API itself would now accept a leading assistant turn, but
 *    keeping the stricter rule preserves today's behaviour exactly — and `appendAssistantTurns`
 *    still documents its early return in terms of it. Relaxing it is a behaviour change, not part
 *    of a provider migration.
 * 2. A bare `function_call` and a `function_call_output` are BOTH invalid openers, and that
 *    cascades on purpose. Tool results used to be blocks inside one user message, so a coarse trim
 *    orphaned them together. Now they are individual items, so dropping a `function_call` must also
 *    drop the outputs that followed it — otherwise the request 400s on an output whose call is not
 *    in the input. Making the call itself an invalid start gets that for free from the
 *    front-advancing scan below: drop the call, the next item is an orphaned output, also invalid,
 *    also dropped, until a real message is reached. `advanceToValidStart` needs no special case.
 *
 * Content must also be non-empty: the API rejects an empty content array outright.
 */
function isValidStart(item: Item | undefined): boolean {
  if (!item) return false
  if (itemType(item) !== 'message') return false
  if ((item as { role?: unknown }).role !== 'user') return false
  const content = messageContent(item)
  if (content === null) return false
  if (typeof content === 'string') return content.trim().length > 0
  return content.length > 0
}

/** Advance past every item that cannot legally open a conversation. */
function advanceToValidStart(items: Item[]): Item[] {
  let start = 0
  while (start < items.length && !isValidStart(items[start])) start++
  return items.slice(start)
}

/**
 * Trim history to the most recent items, then advance the start to the first item that can legally
 * open a conversation (see `isValidStart`), then enforce the byte cap.
 *
 * Returning a normalized array keeps a long, tool-heavy conversation from ever persisting an
 * invalid leading shape that the API would reject on the next call. Pure (no DB) so it is
 * unit-tested.
 */
export function trimToValidStart(items: Item[], max: number = MAX_ITEMS): Item[] {
  let result = advanceToValidStart(items.slice(-max))
  if (serializedBytes(result) <= MAX_SESSION_BYTES) return result

  // Over the cap: drop from the FRONT (oldest first) and re-run the valid-start scan after each
  // drop, so whatever survives is still a legal opening rather than a bare tool output.
  //
  // `> 1`, NOT `> 0`, is load-bearing. One oversized item — a photo, or a pathological tool
  // result — can never be brought under the cap by deleting the items around it, so a `> 0` loop
  // runs until the array is empty and silently wipes the whole conversation. Keeping the last item
  // is strictly better: an over-cap column is a cost problem, a vanished transcript is a
  // correctness one.
  const before = result.length
  while (result.length > 1 && serializedBytes(result) > MAX_SESSION_BYTES) {
    result = advanceToValidStart(result.slice(1))
  }
  const bytes = serializedBytes(result)
  log.warn(
    { cap: MAX_SESSION_BYTES, bytes, dropped: before - result.length, kept: result.length },
    bytes > MAX_SESSION_BYTES
      ? 'session history is over the byte cap in a SINGLE item; keeping it rather than wiping the thread'
      : 'session history exceeded the byte cap; dropped the oldest items',
  )
  return result
}

/**
 * Serialized size in real UTF-8 bytes, which is what the SQLite TEXT column actually stores.
 *
 * `String.length` counts UTF-16 code units, so an emoji-heavy or CJK transcript measures at half
 * to a third of its true size and slips past a cap named in bytes.
 */
function serializedBytes(items: Item[]): number {
  return Buffer.byteLength(JSON.stringify(items), 'utf8')
}

/**
 * Drop reasoning items. Returns a COPY; the input is untouched.
 *
 * Reasoning items MUST be replayed within a turn — that is what makes `effort: 'low'` worth
 * anything across the steps of one tool loop — so this runs only on the way to the database, never
 * inside the loop.
 *
 * They must not be PERSISTED, for three reasons, in increasing order of severity:
 *
 * 1. Size. `encrypted_content` is an opaque blob, several KB each, and one turn can produce a
 *    dozen. `trimToValidStart` drops from the front, so blobs the model cannot even use next turn
 *    would evict the owner's actual words. Same argument as `stripAttachments`, one layer down.
 * 2. Cost. Everything persisted is re-parsed on every turn and re-uploaded on every step.
 * 3. Correctness, and this is the decisive one. Encrypted reasoning is bound to the response that
 *    produced it AND to the model, with a limited decryptable lifetime. Otto's turns are routinely
 *    hours apart (IDLE_RESET_MS is 8h). A stale blob is a 400 on input that is otherwise perfectly
 *    good, and a 400 is classified non-transient, which bumps the failure counter, which trims at 2
 *    and WIPES at 4. Persisting reasoning would mean that changing OPENAI_MODEL invalidates every
 *    blob in the database at once and destroys every conversation over the next four turns, logging
 *    only "session cleared after repeated failures".
 *
 * What is given up is cross-turn reasoning reuse. That is a deliberate trade: the durable state
 * (facts, open reminders, the record) is re-injected into the system prompt every turn anyway,
 * which is the same property `maybeResetIdleSession` already relies on.
 */
export function stripReasoning(items: Item[]): Item[] {
  return items.filter((item) => itemType(item) !== 'reasoning')
}

/**
 * Replace persisted attachments with a short text stand-in. Returns a COPY; the input is untouched.
 *
 * A WhatsApp photo is ~250KB of base64. `sessions.messages` has no size cap of its own and is
 * JSON.parse'd on every single turn, so persisting one would re-read it and re-send it to the API
 * for up to MAX_ITEMS items afterwards. The model already described the photo in its reply, and
 * that description — not the pixels — is what the rest of the thread actually needs.
 *
 * The stand-in collapses the whole item to a plain STRING rather than a one-element array: it is
 * the smallest persisted form, and it keeps stripped turns on the string fast path in
 * `isValidStart`.
 *
 * The old KNOWN LIMIT here (an image nested inside a tool result would survive) is now
 * unrepresentable: a `function_call_output` carries a flat string, so there is nowhere to nest one.
 * Assistant messages carry `output_text` parts and never `input_image`, so they are untouched by
 * construction.
 */
export function stripAttachments(items: Item[]): Item[] {
  return items.map((item) => {
    const content = messageContent(item)
    if (content === null || typeof content === 'string') return item
    if (!content.some((part) => partType(part) === 'input_image')) return item

    const caption = content
      .filter((part) => partType(part) === 'input_text')
      .map((part) => String((part as { text?: unknown }).text ?? '').trim())
      .filter((text) => text.length > 0)
      .join(' ')

    return {
      ...(item as object),
      content: caption ? `[photo the owner sent: "${caption}"]` : '[photo the owner sent]',
    } as Item
  })
}
