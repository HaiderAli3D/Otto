import type Anthropic from '@anthropic-ai/sdk'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { sessions } from '../db/schema.js'

export type Msg = Anthropic.MessageParam

// Keep the recent conversation only — enough for coherent multi-message threads without unbounded growth.
const MAX_MESSAGES = 40

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
  const json = JSON.stringify(messages.slice(-MAX_MESSAGES))
  const now = Date.now()
  db.insert(sessions)
    .values({ waUserId, deviceId: null, messages: json, updatedAt: now })
    .onConflictDoUpdate({ target: sessions.waUserId, set: { messages: json, updatedAt: now } })
    .run()
}
