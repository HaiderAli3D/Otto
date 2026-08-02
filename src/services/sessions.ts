import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { sessions } from '../db/schema.js'
import { trimToValidStart, type Msg } from '../lib/history.js'

export type { Msg }
export { trimToValidStart }

export function loadSession(waUserId: string): Msg[] {
  const row = db.select().from(sessions).where(eq(sessions.waUserId, waUserId)).get()
  if (!row) return []
  try {
    return JSON.parse(row.messages) as Msg[]
  } catch {
    return []
  }
}

export function saveSession(waUserId: string, deviceId: string | null, messages: Msg[], max?: number): void {
  // Always persist a valid leading shape so a long, tool-heavy thread can't poison itself.
  const json = JSON.stringify(trimToValidStart(messages, max))
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
