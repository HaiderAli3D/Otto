import { and, asc, eq, inArray } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { outbox } from '../db/schema.js'
import { log } from '../lib/log.js'
import { inQuietHours, type QuietHours } from '../lib/quietHours.js'
import { clearInboundWindow, getDevice, listDevices, markTemplateSent, type Device } from './devices.js'
import { appendAssistantTurns } from './sessions.js'
import { quietHoursFor } from './settings.js'
import { sendTemplate, sendText } from './whatsapp.js'

export type OutboxRow = typeof outbox.$inferSelect

/**
 * Every kind of proactive message. Declared in full here rather than grown per feature branch, for
 * the same reason as JobKind in services/jobs.ts: four branches must not each edit one union.
 * The column is free-form TEXT, so adding a member needs no migration.
 */
export type OutboxKind =
  | 'nudge'
  | 'digest'
  | 'missed_alarm'
  | 'system_warning'
  | 'brief'
  | 'weekly'
  | 'wake_check'

const WINDOW_MS = 24 * 60 * 60 * 1000
/** Meta's clock is authoritative; don't race the edge of the window and eat a 131047. */
const WINDOW_SAFETY_MS = 30 * 60 * 1000

/** Default lifetime of a queued message — a nudge nobody saw for 18h is stale, not useful. */
export const DEFAULT_TTL_MS = 18 * 60 * 60 * 1000

/**
 * Hard backstop for a PENDING row, enforced by gc. `expiresAtMillis` covers the normal case, but a
 * row enqueued with an explicit long TTL — or with none, if a future caller forgets — can otherwise
 * sit PENDING forever: every other sweep in gc only looks at terminal states.
 */
export const PENDING_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Give up on a message after this many delivery attempts.
 *
 * flushOutbox stops the whole pass on a transient failure, so without a cap the head-of-queue row is
 * retried on every flush forever and every message queued BEHIND it is never even attempted. Ten
 * attempts is a row that has survived ten separate flushes: whatever is wrong is not transient.
 */
export const MAX_OUTBOX_ATTEMPTS = 10

/**
 * Is the WhatsApp free-form window open? This gates every proactive send: outside it, Meta rejects
 * free-form text with error 131047.
 *
 * Closed does not mean unreachable — a registered message template can knock on a shut window —
 * but it does mean nothing Otto composes can go out as written until the owner replies.
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

/** Retire rows nobody will ever read. EXPIRED, never deleted — the audit trail is the point. */
export function markExpired(ids: number[]): void {
  if (ids.length === 0) return
  db.update(outbox).set({ state: 'EXPIRED' }).where(inArray(outbox.id, ids)).run()
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
    // Transient — count the attempt and stop this pass, EXCEPT once the row has exhausted its
    // attempts. This row is at the head of the queue and the `break` below is unconditional, so a
    // row that can never be sent used to block every message behind it for as long as it existed.
    // Retire it and carry on to the next one instead.
    const attempts = row.attempts + 1
    if (attempts >= MAX_OUTBOX_ATTEMPTS) {
      db.update(outbox)
        .set({ state: 'FAILED', attempts, lastError: res.body.slice(0, 500) })
        .where(eq(outbox.id, row.id))
        .run()
      log.warn({ waUserId, id: row.id, attempts }, 'outbox: giving up on a message after max attempts')
      continue
    }
    db.update(outbox).set({ attempts }).where(eq(outbox.id, row.id)).run()
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

/**
 * The only kinds worth spending a paid template on.
 *
 * `nudge` is excluded by definition — a nudge is gentle chasing, and knocking on a shut window with
 * a push notification is the opposite of gentle; a reminder that genuinely must break through has
 * `escalateWithAlarm` and rings the phone instead. `digest` is excluded because it is a convenience
 * summary of things the owner already didn't see. What is left is the two kinds that say something
 * went WRONG and only Otto knows: an alarm that never reached the phone, and an alarm that was
 * missed.
 */
export const KNOCK_KINDS: readonly OutboxKind[] = ['system_warning', 'missed_alarm']

/** At most four knocks a day, and only if there is still something waiting at each one. */
export const TEMPLATE_COOLDOWN_MS = 6 * 60 * 60 * 1000

/**
 * Should we knock on a shut window with a template? Every rule must hold.
 *
 * Pure with respect to config and to the sender: the template is passed IN rather than read from
 * `config.meta`, so the whole policy is unit-testable without an environment. `quietHours` is
 * optional for the same reason — production callers let it default to the device's setting, a test
 * hands it the window it wants to assert about.
 */
export function shouldKnock(params: {
  rows: OutboxRow[]
  device: Device
  template: { name: string; lang: string } | null | undefined
  now: number
  quietHours?: QuietHours
}): boolean {
  const { rows, device, template, now } = params
  if (!template) return false
  // A knock is for a window that is SHUT. While it is open the real queue goes out as itself.
  if (windowOpen(device, now)) return false

  const worthKnocking = rows.some(
    (r) =>
      r.state === 'PENDING' &&
      KNOCK_KINDS.includes(r.kind as OutboxKind) &&
      (r.expiresAtMillis === null || r.expiresAtMillis >= now),
  )
  if (!worthKnocking) return false

  if (device.lastTemplateAt !== null && now - device.lastTemplateAt < TEMPLATE_COOLDOWN_MS) return false

  // A template is a push notification on the owner's lock screen. Quiet hours mean quiet, and the
  // queue will still be there at 07:00 — nothing in KNOCK_KINDS gets better for being read at 3am.
  const quiet = params.quietHours === undefined ? quietHoursFor(device) : params.quietHours
  return !inQuietHours(now, device.timezone, quiet)
}

/** The single {{1}} body variable of `otto_catch_up`. Short, no newlines — Meta rejects both. */
function knockSummary(rows: OutboxRow[]): string {
  const n = rows.filter((r) => KNOCK_KINDS.includes(r.kind as OutboxKind)).length
  return n === 1 ? 'something' : `${n} things`
}

/**
 * One pass over every device with a WhatsApp number. Called from the outbox_flush chain.
 *
 * Three jobs, in order of how little they cost:
 *
 * 1. Retire TTL-expired PENDING rows EVEN WHEN THE WINDOW IS SHUT. Until now that only happened
 *    inside `flushOutbox`, i.e. only when the owner made contact — so a queue built up while they
 *    were away kept stale rows alive precisely in the case they were most stale.
 * 2. If the window is open, flush, AND THEN record what was delivered as Otto's own turns. That
 *    second half is NOT optional: the inbound path does exactly this (routes/whatsapp.ts), and
 *    without it the model has no idea what it said between turns, so the owner's "done" answers a
 *    message the transcript never contains.
 * 3. Otherwise knock, once, subject to every rule in `shouldKnock`.
 */
export async function sweepOutbox(now: number = Date.now()): Promise<void> {
  const template = config.meta?.template ?? null
  for (const device of listDevices()) {
    const waUserId = device.whatsappNumber
    if (waUserId === null) continue

    const rows = pendingFor(waUserId)
    const expired = rows.filter((r) => r.expiresAtMillis !== null && r.expiresAtMillis < now)
    markExpired(expired.map((r) => r.id))
    const live = rows.filter((r) => !expired.includes(r))
    if (live.length === 0) continue

    if (windowOpen(device, now)) {
      const delivered = await flushOutbox(waUserId, device.deviceId)
      if (delivered.length > 0) appendAssistantTurns(waUserId, device.deviceId, delivered)
      continue
    }

    if (!shouldKnock({ rows: live, device, template, now })) continue
    // A template does NOT reopen the window — it knocks. The owner's reply reopens it and the
    // normal inbound path then flushes the real queue as free-form text.
    const res = await sendTemplate(waUserId, [knockSummary(live)])
    if (res.ok) {
      markTemplateSent(device.deviceId, now)
      log.info({ deviceId: device.deviceId, queued: live.length }, 'knocked on a shut window with a template')
    }
  }
}
