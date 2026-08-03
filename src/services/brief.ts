import { DateTime } from 'luxon'
import { composeBrief, type BriefInput } from '../agent/brief.js'
import { nextBriefRunAt, slotForRunAt, type BriefSlot } from '../lib/briefSchedule.js'
import { log } from '../lib/log.js'
import { listArmed } from './alarms.js'
import { getDevice, type Device } from './devices.js'
import { BACKLOG_AGE_MS } from './digest.js'
import { hasGoogle, listCalendarEvents } from './google.js'
import { cancelJobsForDevice, ensureSingletonJob } from './jobs.js'
import { enqueueAndTryFlush, markSuperseded, pendingFor, windowOpen } from './outbox.js'
import { listReminders, type Reminder } from './reminders.js'
import { getSettings, markBriefSent } from './settings.js'
import { reminderEvidence } from './signals.js'
import { localDateKey, sameLocalDay } from './time.js'

/**
 * A run this far past its scheduled instant is wrong, not late. The machine was down, and a 07:00
 * brief delivered at 14:00 describes a morning that already happened. Same reasoning as
 * STALE_NUDGE_MS in services/nagging.ts: the worst failure mode of a durable queue is firing the
 * whole backlog at boot.
 */
const STALE_BRIEF_MS = 3 * 60 * 60 * 1000

/**
 * How long a queued brief stays worth delivering. LOAD-BEARING, not a formality: the window may be
 * shut at 07:00 and open again at 22:00, and a morning brief arriving then — next to an evening one
 * that opens with "tomorrow starts with…" — is worse than no brief at all. flushOutbox retires an
 * expired row without sending it, so the TTL is the whole mechanism.
 */
const MORNING_TTL_MS = 4 * 60 * 60 * 1000
const EVENING_TTL_MS = 3 * 60 * 60 * 1000

/**
 * Hard ceiling on reminders handed to the composer. The prompt already says three or four items, but
 * that is an instruction to a model; this is the guarantee. Thirty open reminders would otherwise
 * become a thirty-line fallback on the morning the API is down.
 */
const MAX_REMINDERS = 6

/** A bare local wall-clock ISO with NO offset — the window shape services/google.ts requires. */
function localIso(dt: DateTime): string {
  return dt.toFormat("yyyy-MM-dd'T'HH:mm:ss")
}

/** Due first, undated last. Stable enough that MAX_REMINDERS drops the least pressing, not the last. */
function byDue(a: Reminder, b: Reminder): number {
  return (a.dueAtMillis ?? Number.MAX_SAFE_INTEGER) - (b.dueAtMillis ?? Number.MAX_SAFE_INTEGER)
}

/**
 * Calendar events, or null — NEVER a throw.
 *
 * A revoked Google grant, an expired refresh token, or Google being down are all ordinary states of
 * the world for a token the owner granted months ago. Any of them propagating out of here would kill
 * the job, and because the handler advances the chain in a finally-shaped path, an unsettled row
 * re-runs every 15 seconds forever. The brief is still worth sending without the calendar.
 */
async function safeCalendarEvents(
  deviceId: string,
  fromIso: string,
  toIso: string,
): Promise<Array<{ summary: string; startIso: string }> | null> {
  if (!hasGoogle(deviceId)) return null
  try {
    return await listCalendarEvents(deviceId, fromIso, toIso)
  } catch (err) {
    log.warn({ err, deviceId }, 'brief: calendar read failed; carrying on without it')
    return null
  }
}

/**
 * Everything the brief may mention for one slot, or null when there is nothing to say.
 *
 * The window is [now, end of today] for a morning brief and the whole of tomorrow for an evening
 * one. Morning starts at NOW rather than at midnight because an event that already happened is not
 * news at 07:00.
 *
 * MUST NOT CONTAIN renderRecord(), and this is the sharpest call in the feature. The aggregate
 * 14-day record ("3 alarms slept through, 2 reminders dropped") is the evidence Otto is entitled to
 * cite when he is CHASING — it lands in the middle of a conversation the owner started, about a
 * thing they just failed to do. Delivering the same numbers unprompted at 07:00 is a performance
 * review before coffee, and it is exactly how a proactive feature gets muted in week one. The
 * per-item `reminderEvidence` on the specific thing being mentioned is IN — "chased 4×" about the
 * dentist call is a fact about the item. The aggregate about THEM is OUT.
 */
export async function collectBrief(device: Device, slot: BriefSlot, nowMillis: number): Promise<BriefInput | null> {
  const zone = device.timezone
  const nowLocal = DateTime.fromMillis(nowMillis, { zone })
  const day = slot === 'morning' ? nowLocal : nowLocal.plus({ days: 1 })
  const from = slot === 'morning' ? nowLocal : day.startOf('day')
  const to = day.endOf('day')

  const raw = (await safeCalendarEvents(device.deviceId, localIso(from), localIso(to))) ?? []
  const events = raw
    // Timed events only. An all-day entry comes back as a bare date with no 'T' and is a label on
    // the day rather than a moment in it — rendering it as "00:00" would be a lie.
    .filter((e) => e.startIso.includes('T'))
    .map((e) => ({ summary: e.summary, at: DateTime.fromISO(e.startIso, { zone }) }))
    .filter((e) => e.at.isValid)
    .map((e) => ({ summary: e.summary, startLocal: e.at.toFormat('HH:mm') }))

  const open = listReminders(device.deviceId, { state: 'open' })
  const reminders = [...open]
    .sort(byDue)
    .slice(0, MAX_REMINDERS)
    .map((r) => ({ title: r.title, evidence: reminderEvidence(r, zone, nowMillis) }))

  // Alarms a reminder is RENTING are already being reported as that reminder. Listing both
  // double-reports one thing — "Call the dentist" and "09:00 Call the dentist" are the same item,
  // and a brief that pads itself is a brief that gets skimmed. Built from every open reminder, not
  // just the ones that survived MAX_REMINDERS, or a truncated list would leak its alarm back in.
  const rented = new Set(open.map((r) => r.alarmId).filter((id): id is string => id !== null))
  const fromMs = from.toMillis()
  const toMs = to.toMillis()
  const alarms = listArmed(device.deviceId)
    .filter((a) => !rented.has(a.alarmId) && a.triggerAtMillis >= fromMs && a.triggerAtMillis <= toMs)
    .sort((a, b) => a.triggerAtMillis - b.triggerAtMillis)
    .map((a) => ({ label: a.label, firesAtLocal: DateTime.fromMillis(a.triggerAtMillis, { zone }).toFormat('HH:mm') }))

  if (events.length === 0 && reminders.length === 0 && alarms.length === 0) return null
  return { slot, zone, events, reminders, alarms }
}

/**
 * Retire a stale nudge backlog the brief is about to cover anyway.
 *
 * Half of the two-way handshake with services/digest.ts (the other half is there, for when the brief
 * lands first). The brief lists these same reminders, so replaying six nudges the owner never saw
 * AND a brief about them is the double-up. Same age threshold as the digest, imported rather than
 * copied so the two can never disagree about what "stale" means.
 *
 * ONLY call this when the brief is genuinely about to go out — see the window check at the call
 * site. Retiring the backlog for a brief that then expires unseen is not a double-up avoided, it is
 * every message lost.
 */
function supersedeStaleNudges(waUserId: string, nowMillis: number): void {
  const stale = pendingFor(waUserId).filter((r) => r.kind === 'nudge' && nowMillis - r.createdAt > BACKLOG_AGE_MS)
  if (stale.length === 0) return
  markSuperseded(stale.map((r) => r.id))
  log.info({ waUserId, superseded: stale.length }, 'brief: retired a stale nudge backlog it already covers')
}

/**
 * Deliver one brief, or stay quiet. Returns whether anything was queued.
 *
 * Silence is the common case and every reason for it is a deliberate rule, not a guard clause:
 * nothing to say, the slot is off, nobody to say it to, already said today, or too late to be true.
 *
 * THREE independent idempotency guards, because a proactive message sent twice is the failure the
 * owner remembers: the singleton job row (only one chain exists), `lastBriefAt` + `sameLocalDay`
 * (only one per slot per local day), and the dedupeKey against the partial unique index on the
 * outbox (only one PENDING row per key, enforced by SQLite). Any one of them can fail without the
 * owner seeing a duplicate.
 */
export async function runBrief(device: Device, runAtMillis: number, nowMillis: number = Date.now()): Promise<boolean> {
  const zone = device.timezone
  const settings = getSettings(device.deviceId)

  const slot = slotForRunAt(settings, zone, runAtMillis)
  if (slot === null) {
    log.debug({ deviceId: device.deviceId, runAtMillis }, 'brief: no enabled slot at this instant')
    return false
  }
  if (nowMillis - runAtMillis > STALE_BRIEF_MS) {
    log.info({ deviceId: device.deviceId, slot, lateBy: nowMillis - runAtMillis }, 'brief: too stale to be true')
    return false
  }
  const waUserId = device.whatsappNumber
  if (waUserId === null) {
    log.debug({ deviceId: device.deviceId }, 'brief: no WhatsApp number linked')
    return false
  }
  const lastSent = slot === 'morning' ? settings.lastBriefAt : settings.lastEveningBriefAt
  if (sameLocalDay(lastSent, nowMillis, zone)) {
    log.debug({ deviceId: device.deviceId, slot }, 'brief: already delivered this local day')
    return false
  }

  const input = await collectBrief(device, slot, nowMillis)
  if (input === null) {
    log.debug({ deviceId: device.deviceId, slot }, 'brief: nothing to say')
    return false
  }

  const body = await composeBrief(input)

  // Retire the backlog ONLY when this brief is actually about to be read. A queued brief is not a
  // delivered one: with the window shut it is a row with a 3–4h fuse, and if that fuse burns out
  // `flushOutbox` drops it EXPIRED. Superseding first would spend three real nudges on a message
  // nobody ever saw and leave the owner with nothing — the same silence as the expired-brief case in
  // digest.ts, reached from the other side. Left queued instead, the nudges survive to next contact,
  // where `maybeCollapseBacklog` decides between them and a still-live brief.
  //
  // Re-read the device rather than trusting the snapshot the handler passed in: `composeBrief` can
  // sit on a socket for 15s, and an inbound message arriving in that window is exactly what opens
  // the window. `enqueueAndTryFlush` re-reads for the same reason. No await between this read and
  // the write it decides, so the flush below cannot deliver a nudge we meant to retire.
  const current = getDevice(device.deviceId) ?? device
  if (windowOpen(current, nowMillis)) supersedeStaleNudges(waUserId, nowMillis)

  await enqueueAndTryFlush({
    waUserId,
    deviceId: device.deviceId,
    kind: 'brief',
    body,
    // NOTE: the partial unique index behind this key is on `dedupe_key` ALONE, across the whole
    // outbox — not per user. That is fine for the single-user system this is (see the `devices`
    // table comment) and matches the existing `digest:<date>` key exactly, but the day a second
    // device pairs, its brief would be silently rejected as a duplicate of the first device's.
    // Add the deviceId here at the same time as multi-device support, not after.
    dedupeKey: `brief:${localDateKey(nowMillis, zone)}:${slot}`,
    ttlMs: slot === 'morning' ? MORNING_TTL_MS : EVENING_TTL_MS,
  })
  // Stamped on QUEUEING, not on sending. The row now exists and will go out on next contact if the
  // window is shut; a marker that waited for delivery would let tomorrow's run queue a second one.
  markBriefSent(device.deviceId, slot, nowMillis)
  log.info({ deviceId: device.deviceId, slot }, 'brief queued')
  return true
}

/** The seeder body, kept here so services/handlers/brief.ts stays a thin seam. Idempotent. */
export function scheduleBriefChain(device: Device, nowMillis: number): void {
  ensureSingletonJob('brief', nextBriefRunAt(getSettings(device.deviceId), device.timezone, nowMillis), {
    deviceId: device.deviceId,
  })
}

/**
 * Move the chain NOW, because the owner just changed when they want their brief.
 *
 * `ensureSingletonJob` deliberately leaves an existing row alone, so seeding alone would keep the
 * old instant until it next fired — "move my brief to 6:30" would silently do nothing tomorrow and
 * only take effect the day after. Cancel-then-ensure with no await between the two is atomic against
 * the scheduler within this process; if a tick settles the row it is deleting, `settle` updates an
 * id that no longer exists (a no-op) and the row this created is the only one left.
 */
export function rescheduleBriefChain(device: Device, nowMillis: number = Date.now()): void {
  cancelJobsForDevice('brief', device.deviceId)
  scheduleBriefChain(device, nowMillis)
}
