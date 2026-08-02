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

/** Append messages Otto sent outside a reply (flushed nudges) so the model knows what it said. */
export function appendAssistantTurns(waUserId: string, deviceId: string | null, texts: string[]): void {
  if (texts.length === 0) return
  const history = loadSession(waUserId)
  for (const text of texts) history.push({ role: 'assistant', content: text })
  saveSession(waUserId, deviceId, history)
}
