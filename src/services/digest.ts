import { composeDigest, type DigestItem } from '../agent/compose.js'
import { log } from '../lib/log.js'
import { markDigestSent, type Device } from './devices.js'
import { enqueueOutbound, markSuperseded, pendingFor } from './outbox.js'
import { listReminders } from './reminders.js'
import { epochMillisToLocalHuman, localDateKey, sameLocalDay } from './time.js'

/**
 * Queued nudges older than this are considered a backlog worth collapsing rather than replaying.
 *
 * Exported for services/brief.ts, which retires the same rows for the same reason when a brief is
 * about to cover them. Imported rather than duplicated so the two halves of that handshake can never
 * disagree about what "stale" means and leave a nudge that only one of them would have dropped.
 */
export const BACKLOG_AGE_MS = 2 * 60 * 60 * 1000

/** Below this, just deliver the messages normally — a digest of one is noise. */
const MIN_BACKLOG = 2

/**
 * Collapse a stale queue into one catch-up message.
 *
 * Replaying six nudges the owner never saw is the single most annoying failure mode of
 * queue-and-deliver, and "in-window only" walks straight into it. So on the first contact of each
 * local day, if there is a real backlog, supersede the individual rows and queue one digest
 * instead. Later contacts the same day flush normally.
 *
 * Returns true if it replaced the queue with a digest.
 */
export async function maybeCollapseBacklog(device: Device, waUserId: string): Promise<boolean> {
  const now = Date.now()
  if (sameLocalDay(device.lastDigestAt, now, device.timezone)) return false

  const pending = pendingFor(waUserId)
  const stale = pending.filter((r) => r.kind === 'nudge' && now - r.createdAt > BACKLOG_AGE_MS)
  if (stale.length < MIN_BACKLOG) return false

  // A brief is already queued, and it lists these same reminders. A digest on top would restate them
  // in a different voice within seconds of each other — the exact double-up the brief's own
  // supersede pass exists to prevent, seen from the other side (the brief was written first, this
  // contact is what flushes it). Retire the nudges and let the brief speak.
  //
  // STILL LIVE, not merely PENDING. `pendingFor` filters on state alone, and a row's TTL is applied
  // lazily by `flushOutbox` — which runs AFTER this, on the very next line of the inbound path. So a
  // morning brief whose 4h fuse burned out while the window was shut still reads PENDING here, and
  // trusting it would retire a real backlog on behalf of a message that is about to be dropped
  // unsent: three nudges SUPERSEDED, one brief EXPIRED, nothing on the wire. Silence, in the one
  // place the feature exists to prevent a double-up.
  //
  // Deliberately NO markDigestSent: no digest went out, so the day's one digest is still available
  // if a genuine backlog builds up later. Returning false is what tells the caller to flush the
  // queue normally, which is how the brief itself gets delivered.
  if (pending.some((r) => r.kind === 'brief' && (r.expiresAtMillis === null || r.expiresAtMillis > now))) {
    markSuperseded(stale.map((r) => r.id))
    log.info({ waUserId, collapsed: stale.length }, 'brief already queued; retiring the nudge backlog without a digest')
    return false
  }

  const open = listReminders(device.deviceId, { state: 'open' })
  const items: DigestItem[] = open.map((r) => ({
    title: r.title,
    due: r.dueAtMillis === null ? null : epochMillisToLocalHuman(r.dueAtMillis, device.timezone),
    overdue: r.dueAtMillis !== null && r.dueAtMillis < now,
    chased: r.nagCount,
    moved: r.deferCount,
  }))
  if (items.length === 0) {
    markSuperseded(stale.map((r) => r.id))
    return false
  }

  const body = await composeDigest(items, device.timezone)
  markSuperseded(stale.map((r) => r.id))
  enqueueOutbound({
    waUserId,
    deviceId: device.deviceId,
    kind: 'digest',
    body,
    dedupeKey: `digest:${localDateKey(now, device.timezone)}`,
  })
  markDigestSent(device.deviceId, now)
  log.info({ waUserId, collapsed: stale.length, open: items.length }, 'collapsed nudge backlog into a digest')
  return true
}
