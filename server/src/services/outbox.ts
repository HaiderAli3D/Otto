import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { outbox } from '../db/schema.js'
import { log } from '../lib/log.js'
import { inQuietHours, type QuietHours } from '../lib/quietHours.js'
import { budgetAllows } from './budget.js'
import { clearInboundWindow, getDevice, listDevices, markTemplateSent, type Device } from './devices.js'
import { pushOutboxRow } from './push.js'
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
 * How many proactive messages one flush pass will deliver before leaving the rest queued.
 *
 * A window that reopens after a day of silence used to dump the entire backlog inside one second:
 * unreadable, and the exact traffic shape that gets a WhatsApp business number rate-limited. The
 * remaining rows keep their TTL and go out on the next pass — the 5-minute sweep, the next inbound,
 * or the next producer's `enqueueAndTryFlush` — so a ten-message backlog drains over minutes
 * instead of arriving as a wall.
 *
 * Deliberately a CAP rather than a sleep between sends. `flushOutbox` runs inside the per-user
 * promise chain that `routes/whatsapp.ts` serialises every inbound message through, so pausing here
 * would make the owner's own reply wait behind the backlog being paced.
 */
export const MAX_SENDS_PER_FLUSH = 3

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
 * The kinds that go out inside quiet hours anyway.
 *
 * This list IS the promise `agent/promptSections.ts` (# Quiet hours) makes to the owner: a real
 * alarm, an escalating reminder, a wake-check, and the first chase at a due time they picked
 * themselves. Alarms never touch the outbox at all, and the two nudge exemptions are decided by the
 * ladder itself — `nagLadder.nextNagAt` and `nagging.runNudge` already defer every rung that is NOT
 * exempt, so a `nudge` that reaches a flush has passed its own gate and must not be held a second
 * time. `wake_check` is exempt outright: a 06:30 "you up?" inside a 22:00–07:00 window is the entire
 * feature.
 *
 * Everything else — brief, weekly, digest, system_warning, missed_alarm — waits for the window to
 * end. Before this the check lived in the nudge ladder ONLY, so the three proactive producers added
 * beside it (brief, weekly review, and the five-minute sweep) each spoke first inside a window Otto
 * had just promised to respect.
 */
export const QUIET_EXEMPT_KINDS: readonly OutboxKind[] = ['nudge', 'wake_check']

/**
 * Would delivering `kind` to this device right now break its quiet hours?
 *
 * Only ever consulted for a PROACTIVE delivery — Otto speaking first. A flush triggered by the
 * owner's own inbound message is never held: "Replying to them is never held back. Quiet hours are
 * about you speaking first."
 */
export function heldByQuietHours(device: Device, kind: OutboxKind, now: number = Date.now()): boolean {
  if (QUIET_EXEMPT_KINDS.includes(kind)) return false
  return inQuietHours(now, device.timezone, quietHoursFor(device))
}

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
 *
 * `proactiveFor` marks this flush as Otto speaking first (the sweep, or a producer delivering what
 * it just queued) and turns on the quiet-hours gate for the kinds that are not exempt. The inbound
 * path passes nothing: the owner is right there, and holding their own queue back from them is not
 * what quiet hours mean.
 */
export async function flushOutbox(
  waUserId: string,
  deviceId: string | null,
  opts: { proactiveFor?: Device } = {},
): Promise<string[]> {
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
    // Held, not retired: the row keeps its TTL and goes out on the first sweep after the window
    // ends, or sooner if the owner messages first. `continue` rather than `break` so an exempt
    // wake-check queued behind a held brief is not held behind it.
    if (opts.proactiveFor && heldByQuietHours(opts.proactiveFor, row.kind as OutboxKind, now)) {
      log.debug({ waUserId, id: row.id, kind: row.kind }, 'outbox: holding a proactive message for quiet hours')
      continue
    }
    // Same shape, same reason, for the daily ceiling — but deliberately NOT for nudges.
    //
    // `runNudge` is the primary gate and stops a nudge before it is ever queued. It is also the
    // only layer that knows whether the reminder behind the row is an escalating one, which is
    // exempt by the same argument `nagQuietHours` makes: a per-item opt-in the owner set on the one
    // thing that matters must beat a global default. A row reaching here has already been judged by
    // a gate with more information than this one has, so re-judging it with less can only overrule
    // that exemption — which is exactly the bug this comment replaced.
    //
    // What this catches is the producers that never go through `runNudge` at all: the brief, the
    // weekly review, the digest. Held, not retired — the row keeps its TTL and goes out tomorrow.
    if (opts.proactiveFor && row.kind !== 'nudge' && !budgetAllows(opts.proactiveFor, row.kind as OutboxKind, {}, now)) {
      log.info({ waUserId, id: row.id, kind: row.kind }, 'outbox: daily message budget spent; holding')
      continue
    }
    // Enough for one pass; the rest keep their place in the queue for the next one.
    if (opts.proactiveFor && delivered.length >= MAX_SENDS_PER_FLUSH) {
      log.info({ waUserId, remaining: rows.length - delivered.length }, 'outbox: pass full, leaving the tail queued')
      break
    }
    // `sentAtMillis` doubles as the claim stamp — the column is written nowhere else and read
    // nowhere at all, so it costs no migration on a branch that deliberately adds no DDL, and it is
    // what lets a claim orphaned by a crash be told apart from one that is genuinely in flight.
    //
    // Stamped with the CLAIM's own instant, never with the `now` captured before the loop: a flush
    // that has already been running longer than STALE_CLAIM_MS (five rows against a Meta that is
    // throwing 429s is ~32s each) would otherwise stamp every remaining row stale on arrival, and
    // the next sweep would take a row back mid-send and deliver it twice.
    const claimed = db
      .update(outbox)
      .set({ state: 'SENDING', sentAtMillis: Date.now() })
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
      db.update(outbox)
        .set({ state: 'SENT', sentAtMillis: Date.now(), deliveredVia: 'whatsapp' })
        .where(eq(outbox.id, row.id))
        .run()
      delivered.push(row.body)
      continue
    }
    if (res.outOfWindow) {
      if (deviceId) clearInboundWindow(deviceId)

      // A shut window is no longer a wall. Meta permits free-form text only inside 24 hours of the
      // owner's last inbound, and with no approved template configured `shouldKnock` can never fire
      // either — so before the phone could take notifications, everything here simply queued until
      // it expired. A push has no window, costs nothing, and carries the real text.
      //
      // Attempted on the CLAIMED row, so the two transports can never both deliver it: whichever
      // succeeds marks it SENT, and if push fails too the row goes back exactly where it was.
      const device = deviceId ? getDevice(deviceId) : null
      if (device && (await pushOutboxRow(device, row, Date.now()))) {
        db.update(outbox)
          .set({ state: 'SENT', sentAtMillis: Date.now(), deliveredVia: 'push' })
          .where(eq(outbox.id, row.id))
          .run()
        delivered.push(row.body)
        // Deliberately NOT `break`. The window being shut said nothing about the phone, and the
        // whole point is that the rest of the queue can still get through.
        continue
      }

      db.update(outbox).set({ state: 'PENDING', sentAtMillis: null }).where(eq(outbox.id, row.id)).run()
      log.warn({ waUserId, id: row.id }, 'outbox flush hit a shut window and the phone is unreachable; leaving queued')
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
 * Queue a proactive message and deliver it immediately when the window allows. Every proactive
 * producer goes through here — nudges, the brief, the weekly review, the wake-check — and it
 * returns whether the message went out now.
 *
 * Two things are NOT optional and both used to be missing here, which is how four features ended up
 * with one seam wired on only some of its paths:
 *
 * 1. The delivery is PROACTIVE, so it carries the quiet-hours gate. Without it the producer's own
 *    schedule was the only thing standing between the owner and a 06:30 brief inside the window Otto
 *    had just confirmed.
 * 2. What was delivered is recorded as Otto's own turns, exactly as `sweepOutbox` and
 *    routes/whatsapp.ts do. The perverse part of leaving it out was WHICH case lost the record: this
 *    path only flushes when the window is OPEN, i.e. precisely when the owner is around to reply to
 *    the message. `promptSections.ts` (# Proactive messages) promises the model those turns are
 *    there, so without this the brief at 07:00 is invisible at 07:02 and Otto restates it.
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
  const delivered = await flushOutbox(params.waUserId, params.deviceId, { proactiveFor: device })
  if (delivered.length > 0) appendAssistantTurns(params.waUserId, params.deviceId, delivered)
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
 *    message the transcript never contains. The flush is PROACTIVE — nobody asked for this pass —
 *    so quiet hours hold back everything that is not a nudge or a wake-check.
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
      const delivered = await flushOutbox(waUserId, device.deviceId, { proactiveFor: device })
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
