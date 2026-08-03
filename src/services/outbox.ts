import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { outbox } from '../db/schema.js'
import { log } from '../lib/log.js'
import { inQuietHours, type QuietHours } from '../lib/quietHours.js'
import { clearInboundWindow, getDevice, listDevices, markTemplateSent, type Device } from './devices.js'
import { appendAssistantTurns } from './sessions.js'
import { quietHoursFor } from './settings.js'
import { sendTemplate, sendText, type SendResult } from './whatsapp.js'

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
 * How long a SENDING claim may stand before another flush is allowed to take it back.
 *
 * `flushOutbox` moves a row PENDING -> SENDING before it sends and out of SENDING on every outcome,
 * including a thrown one, so the only way a claim outlives its flush is a process that died
 * mid-send. Two minutes is comfortably past `sendText`'s own worst case (graphFetch: three 15s
 * attempts plus 2s of backoff, ~50s) and well inside the five-minute sweep, so a claim orphaned by
 * a crash is handed back on the very next pass instead of swallowing the message forever.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000

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
 * same flush, so for the purpose of "don't say that again" it has effectively been said. SENDING
 * counts for the same reason, only more so — it is on the wire right now.
 * SUPERSEDED, EXPIRED and FAILED rows are excluded — nobody ever read those.
 */
export function nudgeHistory(reminderId: string, limit = 6): string[] {
  return db
    .select({ body: outbox.body })
    .from(outbox)
    .where(
      and(
        eq(outbox.reminderId, reminderId),
        eq(outbox.kind, 'nudge'),
        inArray(outbox.state, ['SENT', 'SENDING', 'PENDING']),
      ),
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

/**
 * Retire rows by id. Both guard on PENDING, and that guard is what keeps them safe next to the
 * claim in `flushOutbox`: every caller reads its ids, awaits something, and only then writes
 * (services/digest.ts composes a digest in between). Unguarded, a row a flush has since claimed and
 * DELIVERED would be stamped SUPERSEDED over the top of SENT.
 */
export function markSuperseded(ids: number[]): void {
  if (ids.length === 0) return
  db.update(outbox)
    .set({ state: 'SUPERSEDED' })
    .where(and(inArray(outbox.id, ids), eq(outbox.state, 'PENDING')))
    .run()
}

/** Retire rows nobody will ever read. EXPIRED, never deleted — the audit trail is the point. */
export function markExpired(ids: number[]): void {
  if (ids.length === 0) return
  db.update(outbox)
    .set({ state: 'EXPIRED' })
    .where(and(inArray(outbox.id, ids), eq(outbox.state, 'PENDING')))
    .run()
}

/**
 * Hand back rows whose SENDING claim outlived the flush that took it — see STALE_CLAIM_MS.
 *
 * One guarded UPDATE, and every caller runs it BEFORE its first await, so it cannot race a live
 * claim: a claim held by a flush that is still in flight is at most seconds old and the
 * `< now - STALE_CLAIM_MS` guard excludes it by construction.
 */
function releaseStaleClaims(waUserId: string, now: number): void {
  const released = db
    .update(outbox)
    .set({ state: 'PENDING', sentAtMillis: null })
    .where(
      and(eq(outbox.waUserId, waUserId), eq(outbox.state, 'SENDING'), lt(outbox.sentAtMillis, now - STALE_CLAIM_MS)),
    )
    .run()
  if (released.changes > 0) log.warn({ waUserId, rows: released.changes }, 'released outbox claims left by a crash')
}

/**
 * Send everything queued for this user, oldest first. Returns the bodies actually delivered so the
 * caller can append them to the conversation — without that the model has no idea what Otto just
 * said and "yep, done" is unresolvable.
 *
 * Every row is CLAIMED before it is sent, with the same single guarded UPDATE this codebase uses
 * everywhere a read is followed by an await (see services/nagging.ts). The two callers — the
 * five-minute sweep and the Fastify webhook — are independent promise chains, and `await sendText`
 * yields between reading a PENDING row and retiring it. Without the claim both chains read the SAME
 * row and the owner gets the message twice, plus two identical assistant turns in the transcript.
 * better-sqlite3 is synchronous, so exactly one of them can win the UPDATE.
 *
 * Expired rows are retired silently. A 131047 means our window belief was wrong: clear it and
 * leave the row PENDING for real next contact rather than burning attempts against a shut door.
 */
export async function flushOutbox(waUserId: string, deviceId: string | null): Promise<string[]> {
  const now = Date.now()
  releaseStaleClaims(waUserId, now)
  const rows = pendingFor(waUserId)
  if (rows.length === 0) return []
  const delivered: string[] = []

  for (const row of rows) {
    if (row.expiresAtMillis !== null && row.expiresAtMillis < now) {
      markExpired([row.id])
      continue
    }
    // `sentAtMillis` doubles as the claim stamp — the column is written nowhere else and read
    // nowhere at all, so it costs no migration on a branch that deliberately adds no DDL, and it is
    // what lets a claim orphaned by a crash be told apart from one that is genuinely in flight.
    const claimed = db
      .update(outbox)
      .set({ state: 'SENDING', sentAtMillis: now })
      .where(and(eq(outbox.id, row.id), eq(outbox.state, 'PENDING')))
      .run()
    if (claimed.changes === 0) {
      // Someone else owns this row. The queue is strictly ordered and they are working down the
      // same list, so everything behind it is theirs too — stop rather than delivering the tail
      // out of order behind their head.
      log.debug({ waUserId, id: row.id }, 'outbox claim lost; another flush owns this queue')
      break
    }

    let res: SendResult
    try {
      res = await sendText(waUserId, row.body)
    } catch (err) {
      // sendText is documented never to throw, but a claim nobody releases is invisible to every
      // later flush — put the row back before the error propagates, exactly where it was.
      db.update(outbox).set({ state: 'PENDING', sentAtMillis: null }).where(eq(outbox.id, row.id)).run()
      throw err
    }

    if (res.ok) {
      db.update(outbox).set({ state: 'SENT', sentAtMillis: Date.now() }).where(eq(outbox.id, row.id)).run()
      delivered.push(row.body)
      continue
    }
    if (res.outOfWindow) {
      if (deviceId) clearInboundWindow(deviceId)
      db.update(outbox).set({ state: 'PENDING', sentAtMillis: null }).where(eq(outbox.id, row.id)).run()
      log.warn({ waUserId, id: row.id }, 'outbox flush hit a shut window; leaving queued')
      break // no point trying the rest
    }
    if (res.permanent) {
      db.update(outbox)
        .set({ state: 'FAILED', sentAtMillis: null, lastError: res.body.slice(0, 500), attempts: row.attempts + 1 })
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
        .set({ state: 'FAILED', sentAtMillis: null, attempts, lastError: res.body.slice(0, 500) })
        .where(eq(outbox.id, row.id))
        .run()
      log.warn({ waUserId, id: row.id, attempts }, 'outbox: giving up on a message after max attempts')
      continue
    }
    db.update(outbox).set({ state: 'PENDING', sentAtMillis: null, attempts }).where(eq(outbox.id, row.id)).run()
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

    // The queue is keyed by NUMBER and the knock cooldown by DEVICE, so two devices sharing one
    // `whatsappNumber` would knock twice for one queue. Unreachable today — routes/whatsapp.ts
    // links only a device that has no number, and `deviceForWhatsapp` returns the already-linked
    // one — but `whatsapp_number` carries no UNIQUE constraint, so whoever adds a second device
    // has to move `lastTemplateAt` off the device and onto the number.
    releaseStaleClaims(waUserId, now)
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
    // Start the cooldown on the ATTEMPT, before the send, not on its outcome.
    //
    // `sendTemplate` classifies an abort/timeout and a 5xx as transient, and a template Meta
    // ACTUALLY DELIVERED but whose response we lost looks exactly like one that never landed. So
    // stamping only on success means an hour of Meta trouble is twelve lock-screen pushes, and a
    // genuinely delivered knock is repeated every five minutes. Over-suppressing is the safe
    // direction to be wrong in: the queue is still there at the next cooldown, and at the next
    // window it goes out as itself.
    markTemplateSent(device.deviceId, now)
    // A template does NOT reopen the window — it knocks. The owner's reply reopens it and the
    // normal inbound path then flushes the real queue as free-form text.
    const res = await sendTemplate(waUserId, [knockSummary(live)])
    if (res.ok) {
      log.info({ deviceId: device.deviceId, queued: live.length }, 'knocked on a shut window with a template')
    } else {
      log.warn(
        { deviceId: device.deviceId, status: res.status, body: res.body.slice(0, 200) },
        'template knock failed; cooldown started anyway (it may still have been delivered)',
      )
    }
  }
}
