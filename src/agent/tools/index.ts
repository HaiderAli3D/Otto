import type OpenAI from 'openai'
import { newAlarmId } from '../../lib/ids.js'
import { isNagPolicy, isTimingKind, previewRungs, type NagPolicy, type TimingKind } from '../../lib/nagLadder.js'
import { deferPastQuietHours } from '../../lib/quietHours.js'
import { DEFAULT_TIMING_KIND, normaliseOffsets, type NagPlanSpec } from '../../lib/rungPlan.js'
import { armAlarm, cancelAlarm, listArmed } from '../../services/alarms.js'
import type { Device } from '../../services/devices.js'
import { forgetFact, markFactsUsed, rememberFact, searchFacts } from '../../services/facts.js'
import { createCalendarEvent, createTask, hasGoogle, listCalendarEvents, type CalendarEvent } from '../../services/google.js'
import { supersedePending } from '../../services/outbox.js'
import { setPreferences } from '../../services/preferences.js'
import { parseRecurrence } from '../../services/recurrence.js'
import {
  cancelReminder,
  completeReminder,
  createReminder,
  getReminder,
  ladderParams,
  listReminders,
  reopenReminder,
  snoozeReminder,
  timingKindOf,
  updateReminder,
  type Reminder,
} from '../../services/reminders.js'
import { nagQuietHours } from '../../services/settings.js'
import { epochMillisToLocalHuman, localIsoToEpochMillis } from '../../services/time.js'
import { alarmTools } from './alarms.js'
import { factTools } from './facts.js'
import { googleTools } from './google.js'
import { createLeaveByAlarm, leaveByTools } from './leaveBy.js'
import { reminderTools } from './reminders.js'
import { settingsTools } from './settings.js'

/**
 * The tool surface the agent can call.
 *
 * MUST be a deterministic literal array — the serialized tools sit at the very front of the request,
 * so making the list conditional (e.g. on whether Google is connected) would change the cached
 * prefix and burn the prompt cache on every request. Google tools always exist and return
 * `{ error: '... not connected' }` at call time instead.
 *
 * That is why the definitions live in sibling modules exporting plain `const` arrays and are
 * SPREAD here: spreading imported literals is still one fixed list, byte-identical on every call,
 * while giving parallel feature branches a file each instead of one shared hunk. A new feature adds
 * a module and ONE spread — never an `if`, never a `.filter()`, never a parameter, never a
 * `buildTools(device)`. Order is part of the cached prefix, so append rather than reshuffle;
 * test/tools-order.test.ts pins the names and the order as the regression net.
 *
 * The `.map` is where the provider's wire envelope is added, and it exists so the 18 definitions
 * stay pure prompt content: swapping providers edits this function, not every literal.
 *
 * `strict: false` is deliberate and should NOT be flipped casually. Strict mode requires every
 * property to appear in `required`, but `runTool` below distinguishes absent from present
 * throughout — `update_reminder` is three-state (undefined leaves a field alone, which is why
 * `clearRecurrence` exists as a separate flag), `readNagPlan` reads `undefined` as "use the table",
 * `set_preferences` promises that omitted fields are untouched, and `snooze_reminder` requires
 * exactly one of two fields. Strict would collapse all of those, so it is a redesign of the
 * dispatch, not a schema annotation.
 */
export function buildTools(): OpenAI.Responses.FunctionTool[] {
  return [...alarmTools, ...reminderTools, ...factTools, ...googleTools, ...leaveByTools, ...settingsTools].map(
    (t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }),
  )
}

function reminderView(r: Reminder, zone: string) {
  return {
    reminderId: r.reminderId,
    title: r.title,
    state: r.state,
    dueLocal: r.dueAtMillis === null ? null : epochMillisToLocalHuman(r.dueAtMillis, zone),
    overdue: r.dueAtMillis !== null && r.dueAtMillis < Date.now() && r.state === 'OPEN',
    // What that due time MEANS, so "when's my dentist thing" and "have I still got time on the tax
    // return" get answered differently. Without it every listed reminder reads as a trigger.
    timing: timingKindOf(r),
    repeats: r.recurrence ?? undefined,
    nagPolicy: r.nagPolicy,
    timesNagged: r.nagCount,
  }
}

/**
 * How many upcoming rungs a create/update result shows the owner.
 *
 * Three, not the whole ladder: `relentless` has thirty and a tool result is re-sent with every
 * later turn in the conversation, so the full list would be paid for repeatedly to say something
 * nobody reads past the first line of.
 */
const SCHEDULE_PREVIEW_RUNGS = 3

/**
 * Read the explicit `leadMinutes`/`chaseMinutes`/`keepChasingDaily` triple off a tool call.
 *
 * Returns `{ spec: null }` when the model supplied none, which means "use the table" — the common
 * case, and the one that keeps a future improvement to the tables reaching every reminder that
 * never asked for anything special.
 *
 * A bad value rejects the whole call with the field named. Repairs (clamping an absurd offset,
 * dropping duplicates, capping the count) are reported as prose instead, because Otto is told to
 * confirm from what happened rather than from what was asked and can only do that if the repairs
 * come back with the answer.
 */
function readNagPlan(a: Record<string, unknown>): { error: string } | { spec: NagPlanSpec | null; issues: string[] } {
  const issues: string[] = []
  const spec: NagPlanSpec = {}

  for (const [field, order] of [
    ['leadMinutes', 'lead'],
    ['chaseMinutes', 'chase'],
  ] as const) {
    if (a[field] === undefined) continue
    const res = normaliseOffsets(field, a[field], order)
    if (!res.ok) return { error: res.error }
    if (order === 'lead') spec.leadMinutes = res.minutes
    else spec.chaseMinutes = res.minutes
    if (res.clamped > 0) issues.push(`${res.clamped} ${field} entr${res.clamped === 1 ? 'y was' : 'ies were'} over 30 days and got clamped`)
    if (res.droppedForCount > 0) issues.push(`${res.droppedForCount} of the ${field} were dropped — only the ones nearest the due time were kept`)
  }

  if (typeof a.keepChasingDaily === 'boolean') spec.keepChasingDaily = a.keepChasingDaily
  const explicit = spec.leadMinutes !== undefined || spec.chaseMinutes !== undefined
  return { spec: explicit ? spec : null, issues }
}

/**
 * When the next few chases actually land, plus anything that had to be repaired.
 *
 * Walked through `previewRungs`, which re-enters the ladder at each result the way the scheduler
 * does — a preview that held the clock still would show times the system will never produce.
 */
function scheduleReport(device: Device, r: Reminder, issues: string[]) {
  const upcoming = previewRungs(ladderParams(device, r, r.nagCount, Date.now()), SCHEDULE_PREVIEW_RUNGS)
  return {
    nextChasesLocal: upcoming.map((ms) => epochMillisToLocalHuman(ms, device.timezone)),
    chasesNothingScheduled: upcoming.length === 0 ? true : undefined,
    scheduleNotes: issues.length > 0 ? issues : undefined,
  }
}

/**
 * The model's view of a calendar event — deliberately narrower than the row the planner reads.
 *
 * `listCalendarEvents` grew `id`, `location` and `status` for the leave-by planner, and handing all
 * three straight to the model made this tool's result more than twice as wide for fields it cannot
 * act on. Tool results are appended to the session history and re-sent on every later turn, so a
 * twenty-event listing pays for that width for the rest of the conversation. `id` is the worst of
 * them: forty opaque characters that no tool accepts as input (create_leave_by_alarm matches on the
 * TITLE), so it is pure cost. `status` goes too, and cancelled events go with it — Google's own
 * default excludes them, and a cancelled event listed without its status reads as a live one.
 * `location` earns its place: it is what the model needs to answer "where is that?".
 */
function calendarEventView(e: CalendarEvent) {
  return {
    summary: e.summary,
    startIso: e.startIso,
    endIso: e.endIso,
    location: e.location ?? undefined,
    allDay: e.isAllDay ? true : undefined,
  }
}

/**
 * Execute one tool call. One dispatch table for all of them, deliberately NOT split alongside the
 * definitions.
 *
 * The definitions were split because they are prompt content that several branches must extend at
 * the same time. This switch is plumbing: each case is a few lines that already delegate to a
 * service. Splitting it as well would buy a little conflict-freedom and cost a registry, an extra
 * indirection, and a new way to ship a tool the model can see but nothing can run. A branch adding
 * a tool adds one `case` next to its module's other cases — a much smaller conflict surface than
 * the definitions were. Nothing type-checks a definition against a case, so the order-pinning test
 * in test/tools-order.test.ts also asserts every declared tool is reachable here.
 *
 * An unknown name returns an error object rather than throwing, so a hallucinated tool comes back
 * as a tool_result the model can recover from instead of killing the turn.
 */
export async function runTool(device: Device, name: string, input: unknown): Promise<unknown> {
  const a = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'create_alarm': {
      const triggerAtMillis = localIsoToEpochMillis(String(a.whenLocalISO), device.timezone)
      const recurrence = a.recurrence === undefined ? null : String(a.recurrence)
      if (recurrence !== null && parseRecurrence(recurrence) === null) {
        return { error: `invalid recurrence rule "${recurrence}" — use FREQ=DAILY|WEEKLY|MONTHLY with optional INTERVAL/BYDAY` }
      }
      const alarmId = newAlarmId()
      const wakeCheck = a.wakeCheck === true
      const { sent } = await armAlarm(device, {
        alarmId,
        triggerAtMillis,
        label: String(a.label ?? 'Alarm'),
        allowWhileIdle: typeof a.allowWhileIdle === 'boolean' ? a.allowWhileIdle : undefined,
        recurrence,
        wakeCheck,
      })
      return {
        alarmId,
        firesAtLocal: epochMillisToLocalHuman(triggerAtMillis, device.timezone),
        repeats: recurrence ?? undefined,
        wakeCheck,
        delivered: sent,
      }
    }
    case 'cancel_alarm': {
      const delivered = await cancelAlarm(device, String(a.alarmId))
      // delivered=false means the DB row is cancelled but the CANCEL push didn't reach the phone
      // (stale/absent token); the model should warn the owner the alarm may still ring.
      return { cancelled: true, delivered }
    }
    case 'list_alarms': {
      return {
        alarms: listArmed(device.deviceId).map((x) => ({
          alarmId: x.alarmId,
          label: x.label,
          firesAtLocal: epochMillisToLocalHuman(x.triggerAtMillis, device.timezone),
          repeats: x.recurrence ?? undefined,
        })),
      }
    }

    case 'create_reminder': {
      const recurrence = a.recurrence === undefined ? null : String(a.recurrence)
      if (recurrence !== null && parseRecurrence(recurrence) === null) {
        return { error: `invalid recurrence rule "${recurrence}" — use FREQ=DAILY|WEEKLY|MONTHLY with optional INTERVAL/BYDAY` }
      }
      const dueAtMillis =
        a.dueLocalISO === undefined ? null : localIsoToEpochMillis(String(a.dueLocalISO), device.timezone)
      if (recurrence !== null && dueAtMillis === null) {
        return { error: 'a recurring reminder needs dueLocalISO for its first occurrence' }
      }
      const nagPolicy: NagPolicy = isNagPolicy(a.nagPolicy) ? a.nagPolicy : 'persistent'
      const timing: TimingKind = isTimingKind(a.timing) ? a.timing : DEFAULT_TIMING_KIND
      const plan = readNagPlan(a)
      if ('error' in plan) return { error: plan.error }
      const r = await createReminder(device, {
        title: String(a.title),
        detail: a.detail === undefined ? null : String(a.detail),
        dueAtMillis,
        timing,
        recurrence,
        nagPolicy,
        nagPlan: plan.spec,
        ring: a.ring === true,
        escalateWithAlarm: a.escalateWithAlarm === true,
      })
      return {
        reminderId: r.reminderId,
        dueLocal: dueAtMillis === null ? null : epochMillisToLocalHuman(dueAtMillis, device.timezone),
        timing,
        nagPolicy,
        rings: Boolean(r.alarmId),
        repeats: recurrence ?? undefined,
        ...scheduleReport(device, r, plan.issues),
      }
    }
    case 'list_reminders': {
      const state = a.state === 'done' || a.state === 'all' ? a.state : 'open'
      const rows = listReminders(device.deviceId, { state, overdueOnly: a.overdueOnly === true })
      return { reminders: rows.map((r) => reminderView(r, device.timezone)) }
    }
    case 'complete_reminder': {
      const reminderId = String(a.reminderId)
      const existing = getReminder(reminderId)
      if (!existing) return { error: `no reminder with id ${reminderId} — call list_reminders first` }
      if (existing.state !== 'OPEN') return { error: `reminder "${existing.title}" is already ${existing.state}` }
      const res = await completeReminder(device, reminderId)
      supersedePending(reminderId)
      return {
        completed: res.completed,
        title: existing.title,
        rolledToLocal:
          res.rolledTo === undefined ? undefined : epochMillisToLocalHuman(res.rolledTo, device.timezone),
      }
    }
    case 'snooze_reminder': {
      const reminderId = String(a.reminderId)
      const existing = getReminder(reminderId)
      if (!existing) return { error: `no reminder with id ${reminderId} — call list_reminders first` }
      let until: number
      if (typeof a.minutes === 'number') until = Date.now() + a.minutes * 60_000
      else if (a.untilLocalISO !== undefined) until = localIsoToEpochMillis(String(a.untilLocalISO), device.timezone)
      else return { error: 'pass either minutes or untilLocalISO' }
      // `snoozeReminder` writes nextNagAtMillis directly and is the ONE path in the system that
      // bypasses `nextNagAt`, so quiet hours are applied HERE rather than inside the service —
      // which leaves `snoozeReminder(id, until)` meaning exactly what it says and keeps its tests
      // honest. Reporting the EFFECTIVE time (and that it moved) is what lets Otto say "that lands
      // in your quiet hours — I'll chase you at 07:00" without being told to.
      const effective = deferPastQuietHours(until, device.timezone, nagQuietHours(device, existing.escalateWithAlarm))
      const ok = snoozeReminder(reminderId, effective)
      supersedePending(reminderId)
      return {
        snoozed: ok,
        title: existing.title,
        nextNudgeLocal: epochMillisToLocalHuman(effective, device.timezone),
        movedForQuietHours: effective !== until,
      }
    }
    case 'cancel_reminder': {
      const reminderId = String(a.reminderId)
      const existing = getReminder(reminderId)
      if (!existing) return { error: `no reminder with id ${reminderId} — call list_reminders first` }
      const ok = await cancelReminder(device, reminderId)
      supersedePending(reminderId)
      return { cancelled: ok, title: existing.title }
    }
    case 'reopen_reminder': {
      const reminderId = String(a.reminderId)
      const existing = getReminder(reminderId)
      if (!existing) return { error: `no reminder with id ${reminderId}` }
      return { reopened: reopenReminder(device, reminderId), title: existing.title }
    }
    case 'update_reminder': {
      const reminderId = String(a.reminderId)
      const recurrence =
        a.clearRecurrence === true ? null : a.recurrence === undefined ? undefined : String(a.recurrence)
      if (typeof recurrence === 'string' && parseRecurrence(recurrence) === null) {
        return { error: `invalid recurrence rule "${recurrence}" — use FREQ=DAILY|WEEKLY|MONTHLY with optional INTERVAL/BYDAY` }
      }
      const dueAtMillis =
        a.clearDue === true
          ? null
          : a.dueLocalISO === undefined
            ? undefined
            : localIsoToEpochMillis(String(a.dueLocalISO), device.timezone)

      // `useDefaultSchedule` clears any stored plan; otherwise an absent pair of arrays leaves
      // whatever was there alone. The two are mutually exclusive in effect, and clearing wins —
      // "go back to normal, but warn me an hour before" is a contradiction, and the half that keeps
      // an explicit array is the half the owner would not have noticed.
      const plan = readNagPlan(a)
      if ('error' in plan) return { error: plan.error }
      const nagPlan = a.useDefaultSchedule === true ? null : plan.spec

      const res = await updateReminder(device, reminderId, {
        title: a.title === undefined ? undefined : String(a.title),
        detail: a.detail === undefined ? undefined : String(a.detail),
        dueAtMillis,
        timing: isTimingKind(a.timing) ? a.timing : undefined,
        nagPolicy: isNagPolicy(a.nagPolicy) ? a.nagPolicy : undefined,
        nagPlan: nagPlan ?? (a.useDefaultSchedule === true ? null : undefined),
        recurrence,
        ring: typeof a.ring === 'boolean' ? a.ring : undefined,
        escalateWithAlarm: typeof a.escalateWithAlarm === 'boolean' ? a.escalateWithAlarm : undefined,
        resetChase: a.resetChase === true,
      })
      if (!res.ok) return { error: res.error }
      const r = res.reminder
      return {
        reminderId,
        title: r.title,
        dueLocal: r.dueAtMillis === null ? null : epochMillisToLocalHuman(r.dueAtMillis, device.timezone),
        timing: timingKindOf(r),
        nagPolicy: r.nagPolicy,
        rings: Boolean(r.alarmId),
        repeats: r.recurrence ?? undefined,
        // Reported so Otto never says "that's not on your record" about a move that was.
        countedAsPushingItBack: res.deferred,
        movedBackTotal: r.deferCount,
        ...scheduleReport(device, r, plan.issues),
      }
    }

    case 'remember_fact': {
      const f = rememberFact({
        deviceId: device.deviceId,
        key: String(a.key),
        value: String(a.value),
        category: a.category === undefined ? undefined : String(a.category),
        pinned: a.pinned === true,
      })
      return { saved: true, key: f.key }
    }
    case 'recall_facts': {
      const found = searchFacts(device.deviceId, a.query === undefined ? undefined : String(a.query))
      markFactsUsed(found.map((f) => f.factId))
      return { facts: found.map((f) => ({ key: f.key, value: f.value, category: f.category })) }
    }
    case 'forget_fact': {
      return { forgotten: forgetFact(device.deviceId, String(a.key)) }
    }

    case 'list_calendar_events': {
      if (!hasGoogle(device.deviceId)) return { error: 'calendar not connected' }
      const events = await listCalendarEvents(device.deviceId, String(a.timeMinLocalISO), String(a.timeMaxLocalISO))
      return { events: events.filter((e) => e.status !== 'cancelled').map(calendarEventView) }
    }
    case 'create_calendar_event': {
      if (!hasGoogle(device.deviceId)) return { error: 'calendar not connected' }
      return await createCalendarEvent(device.deviceId, {
        title: String(a.title),
        startIso: String(a.startLocalISO),
        endIso: String(a.endLocalISO),
      })
    }
    case 'create_task': {
      if (!hasGoogle(device.deviceId)) return { error: 'tasks not connected' }
      return await createTask(device.deviceId, {
        title: String(a.title),
        dueIso: a.dueLocalISO ? String(a.dueLocalISO) : undefined,
      })
    }
    case 'create_leave_by_alarm': {
      // The whole body lives beside the definition in ./leaveBy.js: event resolution, the guardrail
      // ladder and the arming decision are a page of logic, not the few lines every other case is.
      return await createLeaveByAlarm(device, a)
    }
    case 'set_preferences': {
      // Handed straight through unvalidated ON PURPOSE: `a` is a bag of unknowns from a model, and
      // setPreferences is the trust boundary that type-checks every field. Coercing here would
      // duplicate that and lose the error messages the model needs to correct itself.
      return setPreferences(device, a)
    }

    default:
      return { error: `unknown tool ${name}` }
  }
}
