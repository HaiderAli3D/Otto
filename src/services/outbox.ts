import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { outbox } from '../db/schema.js'
import { log } from '../lib/log.js'
import { clearInboundWindow, getDevice, type Device } from './devices.js'
import { sendText } from './whatsapp.js'

export type OutboxRow = typeof outbox.$inferSelect
export type OutboxKind = 'nudge' | 'digest' | 'missed_alarm' | 'system_warning'

const WINDOW_MS = 24 * 60 * 60 * 1000
/** Meta's clock is authoritative; don't race the edge of the window and eat a 131047. */
const WINDOW_SAFETY_MS = 30 * 60 * 1000

/** Default lifetime of a queued message — a nudge nobody saw for 18h is stale, not useful. */
export const DEFAULT_TTL_MS = 18 * 60 * 60 * 1000

/**
 * Is the WhatsApp free-form window open? The owner chose not to register message templates, so
 * this gates every proactive send: outside it, Meta rejects free-form text with error 131047.
 */
export function windowOpen(device: Device, now: number = Date.now()): boolean {
  return device.lastInboundAt !== null && now - device.lastInboundAt < WINDOW_MS - WINDOW_SAFETY_MS
}

export function enqueueOutbound(params: {
  waUserId: string
  deviceId?: string | null
  kind: OutboxKind
  body: string
  reminderId?: string | null
  dedupeKey?: string | null
  ttlMs?: number
}): void {
  const now = Date.now()
  try {
    db.insert(outbox)
      .values({
        waUserId: params.waUserId,
        deviceId: params.deviceId ?? null,
        kind: params.kind,
        body: params.body,
        reminderId: params.reminderId ?? null,
        dedupeKey: params.dedupeKey ?? null,
        state: 'PENDING',
        expiresAtMillis: now + (params.ttlMs ?? DEFAULT_TTL_MS),
        attempts: 0,
        createdAt: now,
      })
      .run()
  } catch (err) {
    // The partial unique index on (dedupe_key) WHERE state='PENDING' rejects a duplicate. That is
    // the double-nudge guard doing its job, not an error.
    log.debug({ err, dedupeKey: params.dedupeKey }, 'outbox enqueue skipped (already pending)')
  }
}

export function pendingFor(waUserId: string): OutboxRow[] {
  return db
    .select()
    .from(outbox)
    .where(and(eq(outbox.waUserId, waUserId), eq(outbox.state, 'PENDING')))
    .orderBy(asc(outbox.createdAt))
    .all()
}

/**
 * Nudges already written for this reminder, oldest first — what the owner has seen, or is about to.
 *
 * PENDING counts alongside SENT: a queued nudge goes out immediately before the next one in the
 * same flush, so for the purpose of "don't say that again" it has effectively been said.
 * SUPERSEDED, EXPIRED and FAILED rows are excluded — nobody ever read those.
 */
export function nudgeHistory(reminderId: string, limit = 6): string[] {
  return db
    .select({ body: outbox.body })
    .from(outbox)
    .where(
      and(eq(outbox.reminderId, reminderId), eq(outbox.kind, 'nudge'), inArray(outbox.state, ['SENT', 'PENDING'])),
    )
    .orderBy(asc(outbox.createdAt))
    .all()
    .slice(-limit)
    .map((r) => r.body)
}

/** Drop queued messages for a reminder — it was completed or cancelled before they went out. */
export function supersedePending(reminderId: string): void {
  db.update(outbox)
    .set({ state: 'SUPERSEDED' })
    .where(and(eq(outbox.reminderId, reminderId), eq(outbox.state, 'PENDING')))
    .run()
}

export function markSuperseded(ids: number[]): void {
  if (ids.length === 0) return
  db.update(outbox).set({ state: 'SUPERSEDED' }).where(inArray(outbox.id, ids)).run()
}

/**
 * Send everything queued for this user, oldest first. Returns the bodies actually delivered so the
 * caller can append them to the conversation — without that the model has no idea what Otto just
 * said and "yep, done" is unresolvable.
 *
 * Expired rows are retired silently. A 131047 means our window belief was wrong: clear it and
 * leave the row PENDING for real next contact rather than burning attempts against a shut door.
 */
export async function flushOutbox(waUserId: string, deviceId: string | null): Promise<string[]> {
  const rows = pendingFor(waUserId)
  if (rows.length === 0) return []
  const now = Date.now()
  const delivered: string[] = []

  for (const row of rows) {
    if (row.expiresAtMillis !== null && row.expiresAtMillis < now) {
      db.update(outbox).set({ state: 'EXPIRED' }).where(eq(outbox.id, row.id)).run()
      continue
    }
    const res = await sendText(waUserId, row.body)
    if (res.ok) {
      db.update(outbox).set({ state: 'SENT', sentAtMillis: Date.now() }).where(eq(outbox.id, row.id)).run()
      delivered.push(row.body)
      continue
    }
    if (res.outOfWindow) {
      if (deviceId) clearInboundWindow(deviceId)
      log.warn({ waUserId, id: row.id }, 'outbox flush hit a shut window; leaving queued')
      break // no point trying the rest
    }
    if (res.permanent) {
      db.update(outbox)
        .set({ state: 'FAILED', lastError: res.body.slice(0, 500), attempts: row.attempts + 1 })
        .where(eq(outbox.id, row.id))
        .run()
      continue
    }
    // Transient — leave PENDING, count the attempt, stop this pass.
    db.update(outbox).set({ attempts: row.attempts + 1 }).where(eq(outbox.id, row.id)).run()
    break
  }
  return delivered
}

/**
 * Queue a proactive message and deliver it immediately when the window allows. Used by the nudge
 * path; returns whether it went out now.
 */
export async function enqueueAndTryFlush(params: {
  waUserId: string
  deviceId: string
  kind: OutboxKind
  body: string
  reminderId?: string | null
  dedupeKey?: string | null
  ttlMs?: number
}): Promise<boolean> {
  enqueueOutbound(params)
  const device = getDevice(params.deviceId)
  if (!device || !windowOpen(device)) return false
  const delivered = await flushOutbox(params.waUserId, params.deviceId)
  return delivered.length > 0
}
