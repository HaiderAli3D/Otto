import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { sessions } from '../db/schema.js'
import { stripAttachments, stripReasoning, trimToValidStart, type Item } from '../lib/history.js'

export type { Item }
export { trimToValidStart }

/**
 * Does this row predate the move to the Responses API?
 *
 * Rows written by the Anthropic build hold `{ role, content: [{ type: 'tool_use' | 'tool_result' |
 * 'image' | 'text' }] }`. None of those are legal Responses content parts, so replaying one is a
 * 400 — which is classified non-transient, which bumps the failure counter, which trims the
 * conversation at 2 and wipes it at 4. The owner would see "Sorry — I hit a snag" up to three times
 * before it self-healed.
 *
 * Discarding is safe for exactly the reason `maybeResetIdleSession` already relies on: durable
 * knowledge (facts, open reminders, the record) is injected into the system prompt from the
 * database on every turn, so what is lost is at most a few hours of chit-chat — something this
 * system already throws away every 8 idle hours.
 *
 * Kept rather than run once as a migration: this is idempotent, needs no migration machinery
 * (`ensureSchema` runs on every boot AND in every test's beforeEach, so an unguarded UPDATE there
 * would wipe sessions forever), and it also covers a rollback-then-roll-forward, a restored volume
 * snapshot, and a developer's stale local database. A false positive is not reachable — the types
 * it looks for are not legal in the new shape at all, so anything matching would 400 anyway.
 */
const LEGACY_PART_TYPES = new Set(['tool_use', 'tool_result', 'image', 'text'])

function isLegacyShaped(items: unknown[]): boolean {
  return items.some((item) => {
    if (typeof item !== 'object' || item === null) return false
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) return false
    return content.some(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { type?: unknown }).type === 'string' &&
        LEGACY_PART_TYPES.has((part as { type: string }).type),
    )
  })
}

export function loadSession(waUserId: string): Item[] {
  const row = db.select().from(sessions).where(eq(sessions.waUserId, waUserId)).get()
  if (!row) return []
  try {
    const parsed = JSON.parse(row.messages) as unknown[]
    if (!Array.isArray(parsed)) return []
    if (isLegacyShaped(parsed)) return []
    return parsed as Item[]
  } catch {
    return []
  }
}

export function saveSession(waUserId: string, deviceId: string | null, messages: Item[], max?: number): void {
  // Order matters. Reasoning first: it is the cheapest filter and removes the most bytes, so the
  // attachment strip and the byte cap both measure what actually gets stored.
  //
  // Then attachments BEFORE trimming, never after: stripping rewrites an item's shape (an image
  // array becomes a plain string), and the leading-shape check has to see that final form.
  const json = JSON.stringify(trimToValidStart(stripAttachments(stripReasoning(messages)), max))
  const now = Date.now()
  db.insert(sessions)
    .values({ waUserId, deviceId, messages: json, updatedAt: now })
    .onConflictDoUpdate({ target: sessions.waUserId, set: { deviceId, messages: json, updatedAt: now } })
    .run()
}

/**
 * Count one non-transient failure and return the new total. Drives graduated repair in the agent
 * runner: trim at 2, clear at 4 — rather than destroying a whole conversation on a single 400.
 */
export function bumpSessionFailures(waUserId: string): number {
  const row = db.select().from(sessions).where(eq(sessions.waUserId, waUserId)).get()
  const next = (row?.failCount ?? 0) + 1
  const now = Date.now()
  db.insert(sessions)
    .values({ waUserId, deviceId: null, messages: '[]', failCount: next, updatedAt: now })
    .onConflictDoUpdate({ target: sessions.waUserId, set: { failCount: next, updatedAt: now } })
    .run()
  return next
}

export function clearSessionFailures(waUserId: string): void {
  db.update(sessions).set({ failCount: 0 }).where(eq(sessions.waUserId, waUserId)).run()
}

/**
 * Start a fresh conversation after a long silence.
 *
 * The transcript is otherwise one unbroken thread forever — a 60-message sliding window with no
 * session boundary, so yesterday's tool calls are still in context this morning, get re-sent every
 * turn, and can be referenced as if current.
 *
 * Clearing is safe because durable knowledge lives in `facts`, which is injected separately: Otto
 * forgets the chit-chat, not the owner. Open reminders are likewise injected from the database, so
 * a reset never loses track of what it is chasing.
 *
 * 8 hours: an overnight gap starts fresh, a conversation spanning lunch does not. Must run BEFORE
 * the outbox flush on inbound, so any nudge delivered on this contact lands in the NEW session and
 * a bare "done" is still resolvable.
 */
export const IDLE_RESET_MS = 8 * 60 * 60 * 1000

export function maybeResetIdleSession(waUserId: string, nowMillis: number = Date.now()): boolean {
  const row = db.select().from(sessions).where(eq(sessions.waUserId, waUserId)).get()
  if (!row) return false
  if (nowMillis - row.updatedAt < IDLE_RESET_MS) return false
  if (row.messages === '[]') return false
  db.update(sessions)
    .set({ messages: '[]', failCount: 0, updatedAt: nowMillis })
    .where(eq(sessions.waUserId, waUserId))
    .run()
  return true
}

/**
 * Append messages Otto sent outside a reply (flushed nudges) so it doesn't repeat itself.
 *
 * Skipped when the transcript is empty — a conversation may not START with an assistant turn, and
 * `trimToValidStart` would drop these on save, so persisting them would be a silent no-op that
 * merely looked like it worked. That is not a loss: what the model needs in order to resolve a
 * bare "done" is the list of open reminders, and that is injected into the system prompt from the
 * database on every turn (see agent/prompt.ts), independent of any transcript.
 */
export function appendAssistantTurns(waUserId: string, deviceId: string | null, texts: string[]): void {
  if (texts.length === 0) return
  const history = loadSession(waUserId)
  if (history.length === 0) return
  for (const text of texts) history.push({ role: 'assistant', content: text })
  saveSession(waUserId, deviceId, history)
}

/**
 * Turns appended to the stored transcript since a snapshot was taken, in order.
 *
 * There are two writers of one session row and only one of them is serialised. `runAgentTurn` reads
 * the history, spends up to a minute in model and tool calls, and writes it back — while the
 * scheduler is free to flush a nudge in that window and `appendAssistantTurns` it onto the row.
 * Whoever writes last wins, and it is almost always the turn: the nudge vanishes from the
 * transcript, and the owner's "done" a minute later answers a message the model cannot see.
 *
 * `routes/whatsapp.ts` serialises inbound messages against each other with a per-user chain, but the
 * scheduler is not on it and cannot be — a flush called from inside the chain would await itself.
 *
 * So instead of locking, the turn REPLAYS what it missed. Compared by identity on the tail rather
 * than by content: assistant turns repeat themselves legitimately ("Nudge: the report is still
 * open" twice is a real thing that happens), so anything content-addressed would drop the second.
 * The snapshot length is the only reliable cut, and both writers only ever append.
 */
export function turnsAppendedSince(waUserId: string, snapshotLength: number): Item[] {
  const stored = loadSession(waUserId)
  if (stored.length <= snapshotLength) return []
  return stored.slice(snapshotLength)
}
