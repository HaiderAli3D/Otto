import { and, asc, eq, isNotNull, lte, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { reminders } from '../db/schema.js'
import { newAlarmId, newReminderId } from '../lib/ids.js'
import { nextNagAt, type NagPolicy } from '../lib/nagLadder.js'
import { log } from '../lib/log.js'
import {
  DEFAULT_TIMING_KIND,
  isTimingKind,
  parseNagPlan,
  planRungs,
  serializeNagPlan,
  type NagPlanSpec,
  type ResolvedPlan,
  type TimingKind,
} from '../lib/rungPlan.js'
import { armAlarm, cancelAlarm } from './alarms.js'
import type { Device } from './devices.js'
import { cancelNudges, enqueueJob } from './jobs.js'
import { withdrawNudge } from './push.js'
import { nextOccurrence } from './recurrence.js'
import { nagQuietHours, schedulingRoutine } from './settings.js'

export type Reminder = typeof reminders.$inferSelect

/** The stored kind, falling back for a row written before the column existed or hand-edited. */
export function timingKindOf(r: Reminder): TimingKind {
  return isTimingKind(r.timingKind) ? r.timingKind : DEFAULT_TIMING_KIND
}

/**
 * Everything `nextNagAt` needs about one reminder on one device, in one place.
 *
 * Assembled centrally because there are now five call sites and the parameter set has grown past
 * the point where each of them getting it right independently is plausible. A site that forgot
 * `plannedAtMillis` would silently re-prune the lead rungs against the current clock and start
 * skipping rungs; one that forgot `routine` would put every daily chase back at 09:00.
 */
export function ladderParams(
  device: Device,
  r: Reminder,
  nagCount: number,
  nowMillis: number,
): Parameters<typeof nextNagAt>[0] {
  return {
    policy: r.nagPolicy as NagPolicy,
    nagCount,
    dueAtMillis: r.dueAtMillis,
    zone: device.timezone,
    nowMillis,
    quiet: nagQuietHours(device, r.escalateWithAlarm),
    kind: timingKindOf(r),
    plannedAtMillis: r.plannedAtMillis ?? r.createdAt,
    routine: schedulingRoutine(device),
    plan: parseNagPlan(r.nagPlan),
  }
}

/** This reminder's resolved ladder — used for the lead/chase split in evidence and wording. */
export function resolvedPlanFor(device: Device, r: Reminder): ResolvedPlan | null {
  if (r.dueAtMillis === null) return null
  return planRungs({
    kind: timingKindOf(r),
    policy: r.nagPolicy as NagPolicy,
    dueAtMillis: r.dueAtMillis,
    plannedAtMillis: r.plannedAtMillis ?? r.createdAt,
    zone: device.timezone,
    override: parseNagPlan(r.nagPlan),
    // Must match what `nextNagAt` sees, or the lead count reported to the evidence layer would
    // disagree with the rungs actually scheduled.
    quiet: nagQuietHours(device, r.escalateWithAlarm),
  })
}

/** How many of this reminder's rungs land BEFORE its due time. Zero for triggers and undated rows. */
export function leadCountFor(device: Device, r: Reminder): number {
  return resolvedPlanFor(device, r)?.leadAt.length ?? 0
}

export function getReminder(reminderId: string): Reminder | undefined {
  return db.select().from(reminders).where(eq(reminders.reminderId, reminderId)).get()
}

export function listReminders(
  deviceId: string,
  opts: { state?: 'open' | 'done' | 'all'; overdueOnly?: boolean } = {},
): Reminder[] {
  const state = opts.state ?? 'open'
  const rows = db
    .select()
    .from(reminders)
    .where(
      state === 'all'
        ? eq(reminders.deviceId, deviceId)
        : and(eq(reminders.deviceId, deviceId), eq(reminders.state, state === 'open' ? 'OPEN' : 'DONE')),
    )
    .orderBy(asc(reminders.dueAtMillis))
    .all()
  if (!opts.overdueOnly) return rows
  const now = Date.now()
  return rows.filter((r) => r.dueAtMillis !== null && r.dueAtMillis <= now)
}

/** Every OPEN reminder whose next nudge is due — the scheduler's work list. */
export function dueNags(nowMillis: number): Reminder[] {
  return db
    .select()
    .from(reminders)
    .where(
      and(eq(reminders.state, 'OPEN'), isNotNull(reminders.nextNagAtMillis), lte(reminders.nextNagAtMillis, nowMillis)),
    )
    .orderBy(asc(reminders.nextNagAtMillis))
    .all()
}

/**
 * Create a reminder, schedule its first nudge, and optionally arm a ringing alarm for the due time.
 *
 * The alarm is ALWAYS armed with `recurrence: null` even for a recurring reminder. The reminder
 * owns the recurrence. This is what stops `advanceRecurrence` — which fires on any DISMISSED or
 * MISSED event — from silently rolling a nagging series forward when the owner just swipes the
 * ring away. With no rule on the alarm it hits its existing guard and no-ops.
 */
export async function createReminder(
  device: Device,
  params: {
    title: string
    detail?: string | null
    dueAtMillis?: number | null
    timing?: TimingKind
    recurrence?: string | null
    nagPolicy?: NagPolicy
    nagPlan?: NagPlanSpec | null
    ring?: boolean
    escalateWithAlarm?: boolean
    waUserId?: string | null
  },
): Promise<Reminder> {
  const now = Date.now()
  const reminderId = newReminderId()
  const dueAtMillis = params.dueAtMillis ?? null
  // A time the owner gave and did not explain means "have it done BY then", not "start telling me
  // then". `trigger` has zero lead rungs at every intensity, so defaulting a dated reminder to it
  // meant the first word Otto ever said about it arrived once the moment had already gone.
  //
  // Set HERE and not on the column. `db/schema.ts` must keep defaulting to `trigger`, because that
  // is what every row written before the column existed actually behaves like, and moving it would
  // silently rewrite their ladders. This only decides what a NEW reminder gets when the model did
  // not say — and `trigger` is still exactly one word away, which is what "remind me at 4" picks.
  //
  // Undated "someday" reminders keep DEFAULT_TIMING_KIND: with no due time there is nothing to lead.
  const timingKind = params.timing ?? (dueAtMillis === null ? DEFAULT_TIMING_KIND : 'deadline')
  // `persistent` rather than `gentle`: the owner asked to be chased properly by default, and rung 0
  // is the due instant either way, so nothing about the first message changes.
  const nagPolicy = params.nagPolicy ?? 'persistent'
  const nagPlan = params.nagPlan ? serializeNagPlan(params.nagPlan) : null

  let alarmId: string | null = null
  if (params.ring && dueAtMillis !== null) {
    alarmId = newAlarmId()
    await armAlarm(device, {
      alarmId,
      triggerAtMillis: dueAtMillis,
      label: params.title,
      recurrence: null, // deliberate — see the doc comment above
    })
  }

  const escalateWithAlarm = params.escalateWithAlarm ?? false
  const row: Reminder = {
    reminderId,
    deviceId: device.deviceId,
    waUserId: params.waUserId ?? device.whatsappNumber,
    title: params.title,
    detail: params.detail ?? null,
    state: 'OPEN',
    dueAtMillis,
    timingKind,
    recurrence: params.recurrence ?? null,
    nagPolicy,
    plannedAtMillis: now,
    nagPlan,
    nextNagAtMillis: null,
    nagCount: 0,
    lastNaggedAtMillis: null,
    lastEscalatedAtMillis: null,
    deferCount: 0,
    escalateWithAlarm,
    alarmId,
    completedAtMillis: null,
    assumedAttendedAtMillis: null,
    completedCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  // Computed off the assembled row rather than from the params, so the one definition of "this
  // reminder's ladder" in `ladderParams` covers creation too.
  const firstNag = nextNagAt(ladderParams(device, row, 0, now))
  row.nextNagAtMillis = firstNag

  db.insert(reminders).values(row).run()
  if (firstNag !== null) enqueueJob('nudge', firstNag, { reminderId, deviceId: device.deviceId })
  log.info({ reminderId, dueAtMillis, timingKind, nagPolicy, ring: Boolean(alarmId) }, 'reminder created')
  return row
}

/**
 * Mark the current occurrence done and stop chasing it.
 *
 * For a recurring reminder this rolls forward to the next occurrence rather than ending: state
 * returns to OPEN with a fresh due time and a reset ladder. Only `cancelReminder` ends a series,
 * mirroring how cancelling a recurring alarm behaves so there is one mental model.
 */
export async function completeReminder(
  device: Device,
  reminderId: string,
): Promise<{ completed: boolean; rolledTo?: number; reminder?: Reminder }> {
  const r = getReminder(reminderId)
  if (!r || r.state !== 'OPEN') return { completed: false }
  const now = Date.now()

  await releaseAlarm(device, r)
  cancelNudges(reminderId)
  // Clear it from the phone too. A notification still asking about something they have just told
  // Otto they did is exactly what teaches an owner to ignore the channel. Fire-and-forget: a
  // completion must not wait on FCM, and the app expires an un-withdrawn nudge on its own.
  void withdrawNudge(device, reminderId)

  const next =
    r.recurrence && r.dueAtMillis !== null
      ? nextOccurrence(r.recurrence, r.dueAtMillis, device.timezone, now)
      : null

  if (next !== null) {
    let alarmId: string | null = null
    if (r.alarmId) {
      alarmId = newAlarmId()
      await armAlarm(device, { alarmId, triggerAtMillis: next, label: r.title, recurrence: null })
    }
    // Re-anchored to NOW, not left on the original createdAt. The new occurrence has a new due
    // time, so its lead rungs must be pruned against this moment — measuring them against a
    // createdAt that is weeks old leaves every warning in the plan and every one of them in the
    // past, and the ladder goes silent until the due instant.
    const rolled: Reminder = { ...r, dueAtMillis: next, plannedAtMillis: now }
    const firstNag = nextNagAt(ladderParams(device, rolled, 0, now))
    db.update(reminders)
      .set({
        state: 'OPEN',
        dueAtMillis: next,
        plannedAtMillis: now,
        nagCount: 0,
        nextNagAtMillis: firstNag,
        lastNaggedAtMillis: null,
        lastEscalatedAtMillis: null,
        alarmId,
        completedAtMillis: now,
        completedCount: r.completedCount + 1,
        updatedAt: now,
      })
      .where(eq(reminders.reminderId, reminderId))
      .run()
    if (firstNag !== null) enqueueJob('nudge', firstNag, { reminderId, deviceId: device.deviceId })
    log.info({ reminderId, next }, 'reminder occurrence completed; series rolled forward')
    return { completed: true, rolledTo: next, reminder: getReminder(reminderId) }
  }

  db.update(reminders)
    .set({
      state: 'DONE',
      nextNagAtMillis: null,
      alarmId: null,
      completedAtMillis: now,
      completedCount: r.completedCount + 1,
      updatedAt: now,
    })
    .where(eq(reminders.reminderId, reminderId))
    .run()
  log.info({ reminderId }, 'reminder completed')
  return { completed: true, reminder: getReminder(reminderId) }
}

/** Drop a reminder entirely. On a recurring reminder this ends the whole series. */
export async function cancelReminder(device: Device, reminderId: string): Promise<boolean> {
  const r = getReminder(reminderId)
  if (!r || r.state === 'CANCELLED') return false
  await releaseAlarm(device, r)
  cancelNudges(reminderId)
  void withdrawNudge(device, reminderId)
  db.update(reminders)
    .set({ state: 'CANCELLED', nextNagAtMillis: null, recurrence: null, alarmId: null, updatedAt: Date.now() })
    .where(eq(reminders.reminderId, reminderId))
    .run()
  log.info({ reminderId }, 'reminder cancelled')
  return true
}

/**
 * Push the next follow-up back without completing. "Snoozed" is just a future nextNagAtMillis.
 *
 * This is the only deferral path in the system — there is no reschedule tool — so it is the only
 * place `deferCount` moves. That counter is what lets Otto say "fourth move" and be telling the
 * truth rather than bluffing.
 */
export function snoozeReminder(reminderId: string, untilMillis: number): boolean {
  const r = getReminder(reminderId)
  if (!r || r.state !== 'OPEN') return false
  db.update(reminders)
    .set({ nextNagAtMillis: untilMillis, deferCount: r.deferCount + 1, updatedAt: Date.now() })
    .where(eq(reminders.reminderId, reminderId))
    .run()
  cancelNudges(reminderId)
  enqueueJob('nudge', untilMillis, { reminderId, deviceId: r.deviceId })
  return true
}

/** `undefined` leaves a field alone; an explicit `null` clears it. */
export type ReminderPatch = {
  title?: string
  detail?: string | null
  dueAtMillis?: number | null
  timing?: TimingKind
  nagPolicy?: NagPolicy
  nagPlan?: NagPlanSpec | null
  recurrence?: string | null
  ring?: boolean
  escalateWithAlarm?: boolean
  resetChase?: boolean
}

export type ReminderUpdateResult =
  | { ok: false; error: string }
  | { ok: true; reminder: Reminder; deferred: boolean; replanned: boolean }

/**
 * Change an open reminder in place — what it is, when it is, and how hard it gets chased.
 *
 * Anything touching the schedule re-plans from scratch: `plannedAtMillis` moves to now (so lead
 * rungs are pruned against this moment rather than against a creation time that may be weeks old),
 * the next rung is recomputed, and the pending nudge job is CANCELLED and re-enqueued. Skipping
 * that last step is the subtle failure — the row would carry the new instant while the job row
 * still held the old one, and the reminder would fire on a schedule nothing in the database
 * describes.
 *
 * Pushing the due time LATER increments `deferCount`; pulling it earlier does not. Without that
 * asymmetry this becomes the snooze-laundering path: moving a due time is indistinguishable from
 * snoozing in effect, so the one counter that is caused purely by the owner's own choices would
 * quietly read zero for someone who had dodged a task six times.
 */
export async function updateReminder(
  device: Device,
  reminderId: string,
  patch: ReminderPatch,
): Promise<ReminderUpdateResult> {
  const r = getReminder(reminderId)
  if (!r) return { ok: false, error: `no reminder with id ${reminderId}` }
  if (r.state !== 'OPEN') return { ok: false, error: `reminder "${r.title}" is ${r.state}, so there is nothing to change` }

  const now = Date.now()
  const dueAtMillis = patch.dueAtMillis === undefined ? r.dueAtMillis : patch.dueAtMillis
  const timingKind = patch.timing ?? timingKindOf(r)
  const nagPolicy = patch.nagPolicy ?? (r.nagPolicy as NagPolicy)
  const nagPlan = patch.nagPlan === undefined ? r.nagPlan : patch.nagPlan === null ? null : serializeNagPlan(patch.nagPlan)
  const escalateWithAlarm = patch.escalateWithAlarm ?? r.escalateWithAlarm

  const deferred = dueAtMillis !== null && r.dueAtMillis !== null && dueAtMillis > r.dueAtMillis
  const replanned =
    dueAtMillis !== r.dueAtMillis ||
    timingKind !== timingKindOf(r) ||
    nagPolicy !== r.nagPolicy ||
    nagPlan !== r.nagPlan ||
    escalateWithAlarm !== r.escalateWithAlarm ||
    patch.resetChase === true

  // Ring is a separate object with its own lifecycle, so settle it before the ladder: a due time
  // that moved has to move the alarm too, and `armAlarm` is idempotent on the id.
  let alarmId = r.alarmId
  const wantsRing = patch.ring ?? Boolean(r.alarmId)
  const title = patch.title ?? r.title
  if (alarmId && (!wantsRing || dueAtMillis === null)) {
    await releaseAlarm(device, r)
    alarmId = null
  } else if (wantsRing && dueAtMillis !== null && (!alarmId || replanned || patch.title !== undefined)) {
    alarmId = alarmId ?? newAlarmId()
    await armAlarm(device, { alarmId, triggerAtMillis: dueAtMillis, label: title, recurrence: null })
  }

  const next: Reminder = {
    ...r,
    title,
    detail: patch.detail === undefined ? r.detail : patch.detail,
    dueAtMillis,
    timingKind,
    recurrence: patch.recurrence === undefined ? r.recurrence : patch.recurrence,
    nagPolicy,
    nagPlan,
    escalateWithAlarm,
    alarmId,
    plannedAtMillis: replanned ? now : r.plannedAtMillis,
    nagCount: patch.resetChase === true ? 0 : r.nagCount,
    deferCount: deferred ? r.deferCount + 1 : r.deferCount,
    updatedAt: now,
  }

  if (replanned) next.nextNagAtMillis = replan(device, next, now)

  db.update(reminders)
    .set({
      title: next.title,
      detail: next.detail,
      dueAtMillis: next.dueAtMillis,
      timingKind: next.timingKind,
      recurrence: next.recurrence,
      nagPolicy: next.nagPolicy,
      nagPlan: next.nagPlan,
      escalateWithAlarm: next.escalateWithAlarm,
      alarmId: next.alarmId,
      plannedAtMillis: next.plannedAtMillis,
      nagCount: next.nagCount,
      nextNagAtMillis: next.nextNagAtMillis,
      deferCount: next.deferCount,
      updatedAt: now,
    })
    .where(eq(reminders.reminderId, reminderId))
    .run()

  if (replanned) {
    cancelNudges(reminderId)
    if (next.nextNagAtMillis !== null) {
      enqueueJob('nudge', next.nextNagAtMillis, { reminderId, deviceId: r.deviceId })
    }
  }

  log.info({ reminderId, replanned, deferred, nextNagAtMillis: next.nextNagAtMillis }, 'reminder updated')
  return { ok: true, reminder: next, deferred, replanned }
}

/**
 * The next rung under a freshly-changed schedule, never null while there is still something to say.
 *
 * The clamp matters. `nagCount` indexes into the ladder, and a new ladder can be shorter than the
 * old one — switching a reminder chased eight times down to `gentle` leaves the index past the end
 * of the table, `nextNagAt` correctly returns null, and the reminder silently stops being chased at
 * the exact moment the owner was fiddling with how it gets chased. Falling back to the first
 * post-due rung keeps an edit from ever ending a ladder by accident; ending one is what
 * `cancel_reminder` and `nagPolicy: 'off'` are for.
 */
function replan(device: Device, r: Reminder, now: number): number | null {
  const direct = nextNagAt(ladderParams(device, r, r.nagCount, now))
  if (direct !== null) return direct
  if (r.dueAtMillis === null || r.nagPolicy === 'off') return null
  const leadCount = leadCountFor(device, r)
  if (r.nagCount <= leadCount) return null
  return nextNagAt(ladderParams(device, r, leadCount, now))
}

/** Undo a completion — the owner says the wrong thing got ticked off, or it wasn't finished. */
export function reopenReminder(device: Device, reminderId: string): boolean {
  const r = getReminder(reminderId)
  if (!r || r.state === 'OPEN') return false
  const now = Date.now()
  const nag = nextNagAt(ladderParams(device, r, r.nagCount, now))
  db.update(reminders)
    // `assumedAttendedAtMillis` is cleared too. Reopening is most often the owner answering "no, I
    // wasn't there" to the assumed-attendance check-in, and leaving the stamp behind would mark
    // the eventual real completion as an assumption.
    .set({
      state: 'OPEN',
      completedAtMillis: null,
      assumedAttendedAtMillis: null,
      nextNagAtMillis: nag,
      updatedAt: now,
    })
    .where(eq(reminders.reminderId, reminderId))
    .run()
  if (nag !== null) enqueueJob('nudge', nag, { reminderId, deviceId: r.deviceId })
  return true
}

/**
 * A reminder's alarm rang and the owner dismissed it (or missed it). That is NOT completion — the
 * task still has to be done — so start the chat follow-up rather than touching state.
 *
 * Takes the whole `Device` rather than just its zone: the follow-up rung goes through `nextNagAt`
 * like every other, and that needs the device's quiet hours as well as its timezone.
 */
export function onReminderAlarmEvent(alarmId: string, event: string, device: Device): void {
  const r = db.select().from(reminders).where(eq(reminders.alarmId, alarmId)).get()
  if (!r || r.state !== 'OPEN') return
  const now = Date.now()
  // The ring IS the rung that lands on the due instant, so the chat follow-up starts at the one
  // after it. With lead rungs that is `leadCount + 1`, not 1 — a deadline whose five warnings
  // already went out must not be sent back to warning number two by its own alarm going off.
  const afterTheRing = leadCountFor(device, r) + 1
  const nag = nextNagAt(ladderParams(device, r, Math.max(r.nagCount, afterTheRing), now))
  if (nag === null) return
  db.update(reminders)
    .set({ nextNagAtMillis: nag, updatedAt: now })
    .where(and(eq(reminders.reminderId, r.reminderId), ne(reminders.state, 'DONE')))
    .run()
  cancelNudges(r.reminderId)
  enqueueJob('nudge', nag, { reminderId: r.reminderId, deviceId: r.deviceId })
  log.info({ reminderId: r.reminderId, event, nag }, 'reminder alarm fired; chat follow-up scheduled')
}

async function releaseAlarm(device: Device, r: Reminder): Promise<void> {
  if (!r.alarmId) return
  try {
    await cancelAlarm(device, r.alarmId)
  } catch (err) {
    log.warn({ err, alarmId: r.alarmId }, 'could not cancel reminder alarm')
  }
}
