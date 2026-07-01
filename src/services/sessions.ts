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

export function saveSession(waUserId: string, messages: Msg[]): void {
  // Always persist a valid leading shape so a long, tool-heavy thread can't poison itself.
  const json = JSON.stringify(trimToValidStart(messages))
  const now = Date.now()
  db.insert(sessions)
    .values({ waUserId, deviceId: null, messages: json, updatedAt: now })
    .onConflictDoUpdate({ target: sessions.waUserId, set: { messages: json, updatedAt: now } })
    .run()
}
