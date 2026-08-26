import { and, eq } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { composeBrief, type BriefInput } from '../agent/brief.js'
import { db } from '../db/client.js'
import { reminders } from '../db/schema.js'
import { nextBriefRunAt, slotForRunAt, type BriefSlot } from '../lib/briefSchedule.js'
import { minuteInQuietHours, type QuietHours } from '../lib/quietHours.js'
import { log } from '../lib/log.js'
import { MIN_RUNG_GAP_MS } from '../lib/nagLadder.js'
import { wakingDayEndsAt } from '../lib/routine.js'
import { listArmed } from './alarms.js'
import { getDevice, type Device } from './devices.js'
import { hasGoogle, tryListCalendarEvents } from './google.js'
import { cancelJobsForDevice, cancelNudges, enqueueJob, ensureSingletonJob } from './jobs.js'
import {
  enqueueAndTryFlush,
  heldByQuietHours,
  markSuperseded,
  pendingFor,
  supersedePending,
  windowOpen,
} from './outbox.js'
import { leadCountFor, listReminders, type Reminder } from './reminders.js'
import { getSettings, markBriefSent, schedulingRoutine } from './settings.js'
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
export const MORNING_TTL_MS = 4 * 60 * 60 * 1000
export const EVENING_TTL_MS = 3 * 60 * 60 * 1000

/**
 * Would a brief configured for this wall-clock time be retired unsent by its own TTL?
 *
 * Lives here rather than in `setPreferences` because the answer is made of the two TTLs above, and a
 * caller that had to import them in order to reason about them would be free to get the arithmetic
 * subtly different. `setPreferences` asks the question; this module owns the answer.
 *
 * Being inside the window is NOT on its own a problem: `heldByQuietHours` holds the row and
 * `flushOutbox` sends it the moment the window lifts, so a 06:30 brief under a 22:00–07:00 window
 * arrives at 07:00, half an hour late and perfectly useful. What is fatal is the row expiring first
 * — and then `markBriefSent` has already stamped the day, so `sameLocalDay` blocks the retry and the
 * brief silently never arrives again. On stock defaults an evening brief at 23:00 waits eight hours
 * against a three-hour fuse: it has never once been delivered.
 *
 * Minutes-of-day arithmetic, wrapping at midnight, because a window and a brief time are both
 * recurring wall-clock rules rather than instants — the same reasoning `QuietHours` is stored under.
 */
export function briefWouldExpireUnsent(
  hour: number,
  minute: number,
  slot: BriefSlot,
  quiet: QuietHours,
): boolean {
  if (quiet === null) return false
  const at = hour * 60 + minute
  if (!minuteInQuietHours(at, quiet)) return false
  const waitMinutes = (quiet.endMinute - at + 24 * 60) % (24 * 60)
  const ttlMinutes = (slot === 'morning' ? MORNING_TTL_MS : EVENING_TTL_MS) / 60_000
  return waitMinutes >= ttlMinutes
}

/**
 * Hard ceiling on reminders handed to the composer. The prompt already says three or four items, but
 * that is an instruction to a model; this is the guarantee. Thirty open reminders would otherwise
 * become a thirty-line fallback on the evening the API is down.
 *
 * EVENING ONLY now. The morning slot hands over counts rather than rows, so there is no list for a
 * cap to truncate — and truncating the COUNT would be a lie about the size of their day.
 */
const MAX_REMINDERS = 6

/**
 * A nudge due within this of the brief lands in the same breath as it, so the rung is held.
 *
 * The reason has CHANGED even though the number has not, and the difference matters to anyone
 * reading this next. It used to be about repetition: the brief named the item and the nudge then
 * named it again. The morning brief names nothing now, so this is about BURST — one line about the
 * shape of the day plus a chase, inside a single scheduler tick, reads as two messages at once on
 * the owner's phone.
 *
 * `lib/spread.ts` makes this rare rather than routine: rungs a quiet window releases are fanned
 * across the hours after it, and the fan-out is strictly positive precisely so nothing lands back on
 * the release edge — which for an owner whose window ends when their day starts IS the brief instant.
 * What is left is coincidence, and this catches it.
 */
const COVERED_BY_BRIEF_MS = 20 * 60 * 1000

/** A bare local wall-clock ISO with NO offset — the window shape services/google.ts requires. */
function localIso(dt: DateTime): string {
  return dt.toFormat("yyyy-MM-dd'T'HH:mm:ss")
}

/** Due first, undated last. Stable enough that MAX_REMINDERS drops the least pressing, not the last. */
function byDue(a: Reminder, b: Reminder): number {
  return (a.dueAtMillis ?? Number.MAX_SAFE_INTEGER) - (b.dueAtMillis ?? Number.MAX_SAFE_INTEGER)
}

/**
 * Calendar events, and whether the calendar could be read at all — NEVER a throw.
 *
 * A revoked Google grant, an expired refresh token, or Google being down are all ordinary states of
 * the world for a token the owner granted months ago. Any of them propagating out of here would kill
 * the job, and because the handler advances the chain in a finally-shaped path, an unsettled row
 * re-runs every 15 seconds forever. The brief is still worth sending without the calendar.
 *
 * Through `tryListCalendarEvents` — the leave-by branch's wrapper — rather than a private try/catch
 * around `listCalendarEvents`, and that matters twice over. It is the thing that queues the
 * one-per-day "your Google access has been revoked, here is the link to reconnect" warning on
 * `invalid_grant`,
 * so a private catch here meant the daily path, the ONE path guaranteed to hit a dead token every
 * morning, was also the one path that never told the owner: the calendar stayed silently dead until
 * they happened to ask for a leave-by alarm.
 *
 * And the caller must be able to tell "nothing on today" from "could not ask" — see `unreachable`.
 * A brief that flattens the second into the first states, as fact, that the day is clear.
 */
async function safeCalendarEvents(
  deviceId: string,
  fromIso: string,
  toIso: string,
): Promise<{ events: Array<{ summary: string; startIso: string }>; unreachable: boolean }> {
  if (!hasGoogle(deviceId)) return { events: [], unreachable: false }
  const events = await tryListCalendarEvents(deviceId, fromIso, toIso)
  if (events === null) {
    log.warn({ deviceId }, 'brief: calendar unreachable; saying so rather than implying an empty day')
    return { events: [], unreachable: true }
  }
  return { events, unreachable: false }
}

/**
 * The instant this waking day ends — the owner's next bedtime, not midnight.
 *
 * "The rest of today" for someone who goes to bed at two in the morning runs past midnight, so
 * `endOf('day')` would cut their evening in half and call a 01:30 rung tomorrow's problem.
 */
function dayEndsAt(device: Device, nowMillis: number): number {
  return wakingDayEndsAt(schedulingRoutine(device), device.timezone, nowMillis)
}

/**
 * Everything the brief may say for one slot, or null when there is nothing to say.
 *
 * The two slots return genuinely different things, and the union type is what forces every consumer
 * to notice:
 *
 * - MORNING is the SHAPE of the day — how many things, and the next one. Not a list. Every item it
 *   counts carries its own ladder and will reach the owner at the moment it actually matters, and
 *   `lib/spread.ts` is what stops those moments arriving together. Listing them here as well was
 *   saying everything twice, once when it was useless.
 * - EVENING is about TOMORROW and still lists, because nothing in tomorrow can announce itself
 *   before they read it.
 *
 * The window is [now, their bedtime] for a morning brief and the whole of tomorrow for an evening
 * one. Morning starts at NOW rather than at midnight because an event that already happened is not
 * news, and it ENDS at their bedtime rather than at midnight for the same reason in reverse.
 *
 * MUST NOT CONTAIN renderRecord(), and this is the sharpest call in the feature. The aggregate
 * 14-day record ("3 alarms slept through, 2 reminders dropped") is the evidence Otto is entitled to
 * cite when he is CHASING — it lands in the middle of a conversation the owner started, about a
 * thing they just failed to do. Delivering the same numbers unprompted at the start of their day is
 * a performance review before coffee, and it is exactly how a proactive feature gets muted in week
 * one.
 */
export async function collectBrief(device: Device, slot: BriefSlot, nowMillis: number): Promise<BriefInput | null> {
  const zone = device.timezone
  const nowLocal = DateTime.fromMillis(nowMillis, { zone })
  const morning = slot === 'morning'
  const from = morning ? nowLocal : nowLocal.plus({ days: 1 }).startOf('day')
  const to = morning
    ? DateTime.fromMillis(dayEndsAt(device, nowMillis), { zone })
    : nowLocal.plus({ days: 1 }).endOf('day')

  const calendar = await safeCalendarEvents(device.deviceId, localIso(from), localIso(to))
  const events = calendar.events
    // Timed events only. An all-day entry comes back as a bare date with no 'T' and is a label on
    // the day rather than a moment in it — rendering it as "00:00" would be a lie.
    .filter((e) => e.startIso.includes('T'))
    .map((e) => ({ summary: e.summary, at: DateTime.fromISO(e.startIso, { zone }) }))
    .filter((e) => e.at.isValid)
    .sort((a, b) => a.at.toMillis() - b.at.toMillis())

  const open = listReminders(device.deviceId, { state: 'open' })

  // Alarms a reminder is RENTING are already being reported as that reminder. Listing both
  // double-reports one thing — "Call the dentist" and "09:00 Call the dentist" are the same item,
  // and a brief that pads itself is a brief that gets skimmed. Built from every open reminder, not
  // just the ones that survived MAX_REMINDERS, or a truncated list would leak its alarm back in.
  const rented = new Set(open.map((r) => r.alarmId).filter((id): id is string => id !== null))
  const fromMs = from.toMillis()
  const toMs = to.toMillis()
  const armed = listArmed(device.deviceId)
    .filter((a) => !rented.has(a.alarmId) && a.triggerAtMillis >= fromMs && a.triggerAtMillis <= toMs)
    .sort((a, b) => a.triggerAtMillis - b.triggerAtMillis)

  if (morning) {
    // Today's business only. Events and alarms are already windowed; reminders never were, and that
    // asymmetry is what would otherwise let a deadline five days out be counted as part of today —
    // every day, for five days, which is the dump rebuilt one item at a time. Undated items count:
    // they have no date to fall outside the window, and they are exactly the things that go missing.
    const todays = open.filter((r) => r.dueAtMillis === null || r.dueAtMillis <= toMs)

    // An unreachable calendar on its own is NOT worth a message: `tryListCalendarEvents` has already
    // queued the reconnect-link warning for the one cause that never heals by itself, and a lone
    // "I couldn't read your calendar" is the empty proactive message this whole module is built to
    // avoid. Silence stays the rule; honesty only applies to a brief that was going out anyway.
    if (events.length === 0 && todays.length === 0 && armed.length === 0) return null

    return {
      slot: 'morning',
      zone,
      counts: { events: events.length, reminders: todays.length, alarms: armed.length },
      first: firstTimedThing(events, armed, zone),
      calendarUnreachable: calendar.unreachable,
    }
  }

  const reminders = remindersForBrief(open).map((r) => ({
    title: r.title,
    // leadCount so a deadline still in its run-up reads as "warned 3× beforehand" rather than
    // "chased 3×" — the brief is unprompted, and being sharp there about something not yet late is
    // the worst place to get it wrong.
    evidence: reminderEvidence(r, zone, nowMillis, leadCountFor(device, r)),
  }))
  const alarms = armed.map((a) => ({
    label: a.label,
    firesAtLocal: DateTime.fromMillis(a.triggerAtMillis, { zone }).toFormat('HH:mm'),
  }))
  if (events.length === 0 && reminders.length === 0 && alarms.length === 0) return null
  return {
    slot: 'evening',
    zone,
    events: events.map((e) => ({ summary: e.summary, startLocal: e.at.toFormat('HH:mm') })),
    reminders,
    alarms,
    calendarUnreachable: calendar.unreachable,
  }
}

/**
 * The next timed thing left in the day, across both calendar and alarms, or null.
 *
 * The one item a morning brief is allowed to NAME. "Three things today" on its own is a number
 * rather than a sentence, and the anchor is what makes it useful without becoming a list.
 *
 * Reminders are deliberately not eligible. A reminder's due time is when Otto will chase them about
 * it anyway, so naming it here spends the surprise and then repeats it an hour later; an event or an
 * alarm is something they have to BE somewhere for.
 */
function firstTimedThing(
  events: Array<{ summary: string; at: DateTime }>,
  alarms: Array<{ label: string; triggerAtMillis: number }>,
  zone: string,
): { what: string; atLocal: string } | null {
  const candidates: Array<{ what: string; at: number }> = [
    ...events.map((e) => ({ what: e.summary, at: e.at.toMillis() })),
    ...alarms.map((a) => ({ what: a.label, at: a.triggerAtMillis })),
  ].sort((a, b) => a.at - b.at)
  const first = candidates[0]
  if (first === undefined) return null
  return { what: first.what, atLocal: DateTime.fromMillis(first.at, { zone }).toFormat('HH:mm') }
}

/**
 * Which open reminders the EVENING brief names. Morning hands over counts, so it never comes here.
 */
function remindersForBrief(open: Reminder[]): Reminder[] {
  return [...open].sort(byDue).slice(0, MAX_REMINDERS)
}

/** Is this rung about to fire in the same breath as the brief? One predicate, two callers. */
function rungIsAboutNow(r: Reminder, nowMillis: number): boolean {
  return r.nextNagAtMillis !== null && r.nextNagAtMillis <= nowMillis + COVERED_BY_BRIEF_MS
}

/**
 * Push a rung that would land in the same scheduler tick as the brief.
 *
 * NOT about repetition any more. The morning brief names nothing, so a chase arriving alongside it
 * is not a restatement — it is two messages at once, which on a phone is one buzz that turns into
 * two and reads as the burst this whole change exists to end.
 *
 * `lib/spread.ts` does the structural half: rungs a quiet window releases are fanned out, and the
 * offset is strictly positive so nothing lands back on the release edge — which for an owner whose
 * window ends when their day begins is also the brief instant. This catches what is left, which is
 * coincidence rather than the old guaranteed collision.
 *
 * Widened from "the reminders the brief named" to every open reminder, because there is no named
 * list to scope it to any more, and a rung is either about to fire alongside the brief or it is not.
 *
 * The rung is PUSHED, not spent: `nagCount` is untouched. Spending one here would inflate the
 * "chased N×" counter the persona cites as evidence, for a message that did nothing but move.
 */
function holdNudgesCoveredByBrief(device: Device, open: Reminder[], nowMillis: number): void {
  const pushTo = nowMillis + MIN_RUNG_GAP_MS
  let held = 0
  for (const r of open) {
    const rung = r.nextNagAtMillis
    if (rung === null || !rungIsAboutNow(r, nowMillis)) continue
    // Guarded on the rung we read, exactly like the other deferral paths: better-sqlite3 is
    // synchronous, so with no await in between this cannot land on top of a rung runNudge claimed.
    const moved = db
      .update(reminders)
      .set({ nextNagAtMillis: pushTo, updatedAt: nowMillis })
      .where(and(eq(reminders.reminderId, r.reminderId), eq(reminders.nextNagAtMillis, rung)))
      .run()
    if (moved.changes === 0) continue
    cancelNudges(r.reminderId)
    supersedePending(r.reminderId)
    enqueueJob('nudge', pushTo, { reminderId: r.reminderId, deviceId: device.deviceId })
    held++
  }
  if (held > 0) log.info({ deviceId: device.deviceId, held }, 'brief: held nudges landing in its own tick')
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
  if (sameLocalDay(lastSent, runAtMillis, zone)) {
    log.debug({ deviceId: device.deviceId, slot }, 'brief: already delivered this local day')
    return false
  }

  const input = await collectBrief(device, slot, nowMillis)
  if (input === null) {
    log.debug({ deviceId: device.deviceId, slot }, 'brief: nothing to say')
    return false
  }

  const body = await composeBrief(input)

  // Hold colliding rungs ONLY when this brief is actually about to be read. A queued brief is not a
  // delivered one: with the window shut it is a row with a 3–4h fuse, and if that fuse burns out
  // `flushOutbox` drops it EXPIRED. Moving rungs for a message nobody ever saw would delay real
  // chases on behalf of silence.
  //
  // The old `supersedeStaleNudges` pass is GONE from here, and its counterpart has been removed from
  // digest.ts's SUMMARY_KINDS. It retired a stale nudge backlog on the grounds that "the brief lists
  // these same reminders" — which stopped being true the day the morning brief became one line about
  // the size of the day. Retiring a backlog on behalf of a sentence that never names it would drop
  // messages the owner had not seen. A stale backlog now collapses into a digest on next contact,
  // which is the mechanism built for exactly that.
  //
  // Re-read the device rather than trusting the snapshot the handler passed in: `composeBrief` can
  // sit on a socket for 15s, and an inbound message arriving in that window is exactly what opens
  // the window. `enqueueAndTryFlush` re-reads for the same reason. No await between this read and
  // the write it decides, so the flush below cannot race a rung we meant to move.
  //
  // "Actually about to be read" now also means "not held for quiet hours". An owner whose brief sits
  // just inside their window gets a row the delivery gate holds until the window ends, which is
  // every bit as undelivered as a shut window — while the nudges it would collide with are exempt
  // and about to go out on their own.
  const current = getDevice(device.deviceId) ?? device
  if (windowOpen(current, nowMillis) && !heldByQuietHours(current, 'brief', nowMillis)) {
    holdNudgesCoveredByBrief(current, listReminders(current.deviceId, { state: 'open' }), nowMillis)
  }

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
    // Keyed on the SLOT's own instant, not on the moment the job happened to run. The two are the
    // same day almost always and differ exactly when it matters: a brief scheduled for 23:30 that a
    // busy tick delivers at 00:02 gets tomorrow's key, and `markBriefSent` then stamps tomorrow —
    // so tomorrow's brief reads as already sent and is skipped, while today's went out twice under
    // two different keys. STALE_BRIEF_MS bounds the drift to three hours, which is plenty to cross
    // midnight for any evening slot after 21:00.
    dedupeKey: `brief:${localDateKey(runAtMillis, zone)}:${slot}`,
    ttlMs: slot === 'morning' ? MORNING_TTL_MS : EVENING_TTL_MS,
  })
  // Stamped on QUEUEING, not on sending. The row now exists and will go out on next contact if the
  // window is shut; a marker that waited for delivery would let tomorrow's run queue a second one.
  markBriefSent(device.deviceId, slot, runAtMillis)
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
