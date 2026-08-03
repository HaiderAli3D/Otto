import type Anthropic from '@anthropic-ai/sdk'
import { newAlarmId } from '../../lib/ids.js'
import { isNagPolicy, type NagPolicy } from '../../lib/nagLadder.js'
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
  listReminders,
  reopenReminder,
  snoozeReminder,
} from '../../services/reminders.js'
import { epochMillisToLocalHuman, localIsoToEpochMillis } from '../../services/time.js'
import { alarmTools } from './alarms.js'
import { factTools } from './facts.js'
import { googleTools } from './google.js'
import { createLeaveByAlarm, leaveByTools } from './leaveBy.js'
import { reminderTools } from './reminders.js'
import { settingsTools } from './settings.js'

/**
 * The tool surface the Claude agent can call.
 *
 * MUST be a deterministic literal array — tools render at position 0 of the prompt, before the
 * system blocks, so making the list conditional (e.g. on whether Google is connected) would
 * invalidate the prompt cache on every request. Google tools always exist and return
 * `{ error: '... not connected' }` at call time instead.
 *
 * That is why the definitions live in sibling modules exporting plain `const` arrays and are
 * SPREAD here: spreading imported literals is still one fixed list, byte-identical on every call,
 * while giving parallel feature branches a file each instead of one shared hunk. A new feature adds
 * a module and ONE spread — never an `if`, never a `.filter()`, never a parameter, never a
 * `buildTools(device)`. Order is part of the cached prefix, so append rather than reshuffle;
 * test/tools-order.test.ts pins the names and the order as the regression net.
 */
export function buildTools(): Anthropic.Tool[] {
  return [...alarmTools, ...reminderTools, ...factTools, ...googleTools, ...leaveByTools, ...settingsTools]
}

function reminderView(r: { reminderId: string; title: string; dueAtMillis: number | null; state: string; recurrence: string | null; nagPolicy: string; nagCount: number }, zone: string) {
  return {
    reminderId: r.reminderId,
    title: r.title,
    state: r.state,
    dueLocal: r.dueAtMillis === null ? null : epochMillisToLocalHuman(r.dueAtMillis, zone),
    overdue: r.dueAtMillis !== null && r.dueAtMillis < Date.now() && r.state === 'OPEN',
    repeats: r.recurrence ?? undefined,
    nagPolicy: r.nagPolicy,
    timesNagged: r.nagCount,
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
      const { sent } = await armAlarm(device, {
        alarmId,
        triggerAtMillis,
        label: String(a.label ?? 'Alarm'),
        allowWhileIdle: typeof a.allowWhileIdle === 'boolean' ? a.allowWhileIdle : undefined,
        recurrence,
      })
      return {
        alarmId,
        firesAtLocal: epochMillisToLocalHuman(triggerAtMillis, device.timezone),
        repeats: recurrence ?? undefined,
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
      const nagPolicy: NagPolicy = isNagPolicy(a.nagPolicy) ? a.nagPolicy : 'gentle'
      const r = await createReminder(device, {
        title: String(a.title),
        detail: a.detail === undefined ? null : String(a.detail),
        dueAtMillis,
        recurrence,
        nagPolicy,
        ring: a.ring === true,
        escalateWithAlarm: a.escalateWithAlarm === true,
      })
      return {
        reminderId: r.reminderId,
        dueLocal: dueAtMillis === null ? null : epochMillisToLocalHuman(dueAtMillis, device.timezone),
        nagPolicy,
        rings: Boolean(r.alarmId),
        repeats: recurrence ?? undefined,
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
      const ok = snoozeReminder(reminderId, until)
      supersedePending(reminderId)
      return { snoozed: ok, title: existing.title, nextNudgeLocal: epochMillisToLocalHuman(until, device.timezone) }
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
