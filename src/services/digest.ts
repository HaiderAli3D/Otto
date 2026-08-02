import { DateTime } from 'luxon'
import { composeDigest, type DigestItem } from '../agent/compose.js'
import { log } from '../lib/log.js'
import { markDigestSent, type Device } from './devices.js'
import { enqueueOutbound, markSuperseded, pendingFor } from './outbox.js'
import { listReminders } from './reminders.js'
import { epochMillisToLocalHuman } from './time.js'

/** Queued nudges older than this are considered a backlog worth collapsing rather than replaying. */
const BACKLOG_AGE_MS = 2 * 60 * 60 * 1000

/** Below this, just deliver the messages normally — a digest of one is noise. */
const MIN_BACKLOG = 2

function sameLocalDay(a: number | null, b: number, zone: string): boolean {
  if (a === null) return false
  return DateTime.fromMillis(a, { zone }).toISODate() === DateTime.fromMillis(b, { zone }).toISODate()
}

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
    dedupeKey: `digest:${DateTime.fromMillis(now, { zone: device.timezone }).toISODate()}`,
  })
  markDigestSent(device.deviceId, now)
  log.info({ waUserId, collapsed: stale.length, open: items.length }, 'collapsed nudge backlog into a digest')
  return true
}
