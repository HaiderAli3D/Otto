import type Anthropic from '@anthropic-ai/sdk'
import { newAlarmId } from '../lib/ids.js'
import { isNagPolicy, type NagPolicy } from '../lib/nagLadder.js'
import { armAlarm, cancelAlarm, listArmed } from '../services/alarms.js'
import type { Device } from '../services/devices.js'
import { forgetFact, markFactsUsed, rememberFact, searchFacts } from '../services/facts.js'
import { createCalendarEvent, createTask, hasGoogle, listCalendarEvents } from '../services/google.js'
import { supersedePending } from '../services/outbox.js'
import { parseRecurrence } from '../services/recurrence.js'
import {
  cancelReminder,
  completeReminder,
  createReminder,
  getReminder,
  listReminders,
  reopenReminder,
  snoozeReminder,
} from '../services/reminders.js'
import { epochMillisToLocalHuman, localIsoToEpochMillis } from '../services/time.js'

/**
 * The tool surface the Claude agent can call.
 *
 * MUST be a deterministic literal array — tools render at position 0 of the prompt, before the
 * system blocks, so making the list conditional (e.g. on whether Google is connected) would
 * invalidate the prompt cache on every request. Google tools always exist and return
 * `{ error: '... not connected' }` at call time instead.
 */
export function buildTools(): Anthropic.Tool[] {
  return [
    {
      name: 'create_alarm',
      description:
        'Set a real alarm that rings loudly on the phone at an exact time. Use this ONLY for a ' +
        'moment that must interrupt the owner and is then over: waking up, leaving the house, a ' +
        'hard cutoff. An alarm has no completion state and you never follow up on it. If the owner ' +
        'needs to DO something and you should chase them until it is done, use create_reminder ' +
        'instead (with ring=true if it also needs to ring).',
      input_schema: {
        type: 'object',
        properties: {
          whenLocalISO: {
            type: 'string',
            description: 'Local ISO 8601 with NO offset, in the device timezone, e.g. 2026-07-02T18:00:00',
          },
          label: { type: 'string', description: 'Short label shown on the alarm screen' },
          allowWhileIdle: { type: 'boolean', description: 'Defaults true' },
          recurrence: {
            type: 'string',
            description:
              'Optional repeat rule; whenLocalISO is the first ring. FREQ=DAILY|WEEKLY|MONTHLY, optional INTERVAL=n, optional BYDAY=MO,..,SU (WEEKLY only). Examples: "FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO,WE,FR", "FREQ=DAILY;INTERVAL=2". Omit for a one-shot alarm.',
          },
        },
        required: ['whenLocalISO', 'label'],
      },
    },
    {
      name: 'cancel_alarm',
      description:
        'Cancel a previously set alarm by its alarmId (from list_alarms). Cancelling a recurring alarm stops the whole series.',
      input_schema: { type: 'object', properties: { alarmId: { type: 'string' } }, required: ['alarmId'] },
    },
    {
      name: 'list_alarms',
      description: 'List the alarms currently set (armed) on the phone.',
      input_schema: { type: 'object', properties: {} },
    },

    // ── Reminders ────────────────────────────────────────────────────────────
    {
      name: 'create_reminder',
      description:
        'Track something the owner needs to DO, follow up until they say it is done, then stop. ' +
        'Call this whenever the owner says "remind me to…", "make sure I…", "don\'t let me ' +
        'forget…", or mentions a task with no fixed ringing moment. Set ring=true when the due ' +
        'time is also a moment that should interrupt them — that arms an alarm AND keeps chasing ' +
        'afterwards. Never create an alarm and a reminder separately for the same thing.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative task, e.g. "take the bins out"' },
          detail: { type: 'string', description: 'Optional extra context worth repeating in a nudge' },
          dueLocalISO: {
            type: 'string',
            description:
              'Local ISO 8601 with NO offset, in the device timezone, e.g. 2026-08-03T18:00:00. Omit for an undated "someday" reminder that only appears in lists and digests.',
          },
          recurrence: {
            type: 'string',
            description:
              'Optional repeat rule; dueLocalISO is the first occurrence. FREQ=DAILY|WEEKLY|MONTHLY, optional INTERVAL=n, optional BYDAY=MO,..,SU (WEEKLY only). Completing one occurrence rolls to the next; cancel_reminder ends the series.',
          },
          nagPolicy: {
            type: 'string',
            enum: ['off', 'gentle', 'persistent'],
            description:
              'How hard to chase. off = mention at the due time only. gentle (default) = due time, +2h, next morning. persistent = due time, +30m, +2h, +6h, then daily. Use persistent only when the owner asks to be pushed or the task has real consequences.',
          },
          ring: { type: 'boolean', description: 'Also arm a ringing alarm at the due time. Default false.' },
          escalateWithAlarm: {
            type: 'boolean',
            description:
              'If WhatsApp cannot be reached (outside the 24h reply window) AND this becomes badly overdue, ring the phone as a last resort. Only for genuinely time-critical things — this WILL wake them. Default false.',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_reminders',
      description:
        'List the owner\'s reminders and get the reminderId needed for complete_reminder, ' +
        'snooze_reminder, cancel_reminder and reopen_reminder. Call this before completing ' +
        'anything unless you already have the exact id from this conversation. Also use it to ' +
        'answer "what have I got on?" and "what am I forgetting?".',
      input_schema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'done', 'all'], description: 'Defaults to open.' },
          overdueOnly: { type: 'boolean', description: 'Only reminders past their due time.' },
        },
      },
    },
    {
      name: 'complete_reminder',
      description:
        'Mark a reminder done and STOP chasing it. Call this the moment the owner indicates they ' +
        'have done the thing ("done", "sorted", "took them out", "already did it"). You must have ' +
        'the exact reminderId from list_reminders or from this conversation — never guess. If two ' +
        'or more open reminders could plausibly match, ask which one instead of picking. For a ' +
        'recurring reminder this completes the current occurrence and rolls it to the next.',
      input_schema: { type: 'object', properties: { reminderId: { type: 'string' } }, required: ['reminderId'] },
    },
    {
      name: 'snooze_reminder',
      description:
        'Push a reminder\'s next follow-up back without completing it. Use when the owner says ' +
        '"not yet", "later", "tomorrow", "give me an hour". Pass exactly one of minutes or untilLocalISO.',
      input_schema: {
        type: 'object',
        properties: {
          reminderId: { type: 'string' },
          minutes: { type: 'number', description: 'Relative delay from now.' },
          untilLocalISO: { type: 'string', description: 'Local ISO 8601 with NO offset.' },
        },
        required: ['reminderId'],
      },
    },
    {
      name: 'cancel_reminder',
      description:
        'Drop a reminder entirely — the owner no longer wants it, as opposed to having done it. ' +
        'Cancelling a recurring reminder ends the whole series. Prefer complete_reminder when they ' +
        'actually did the thing, so the history stays honest.',
      input_schema: { type: 'object', properties: { reminderId: { type: 'string' } }, required: ['reminderId'] },
    },
    {
      name: 'reopen_reminder',
      description:
        'Undo a completion. Use when the owner says you ticked off the wrong thing, or the task ' +
        'turned out not to be finished after all.',
      input_schema: { type: 'object', properties: { reminderId: { type: 'string' } }, required: ['reminderId'] },
    },

    // ── Memory ───────────────────────────────────────────────────────────────
    {
      name: 'remember_fact',
      description:
        'Save one durable fact about the owner so it is available in every future conversation. ' +
        'Call this whenever they state something about themselves that will still matter next ' +
        'month: how they commute, when they work out, who the people in their life are, standing ' +
        'preferences, how they like to be reminded. Do NOT ask permission first — just save it and ' +
        'carry on. Do NOT save tasks (use create_reminder), one-off state ("I\'m at the shops"), or ' +
        'anything you could look up. Reuse an existing key to correct or replace a fact rather than ' +
        'adding a near-duplicate — writing the same key overwrites it.',
      input_schema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'Stable dotted slug, lowercase, e.g. "work.commute", "health.gym_days", "people.sam". Check recall_facts first if you might be replacing an existing fact.',
          },
          value: { type: 'string', description: 'ONE short sentence, written in the third person.' },
          category: {
            type: 'string',
            enum: ['profile', 'preference', 'routine', 'project', 'person', 'health', 'general'],
          },
          pinned: {
            type: 'boolean',
            description: 'Always keep in context. Reserve for a handful of load-bearing facts.',
          },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: 'recall_facts',
      description:
        'Search everything Otto remembers about the owner, including facts not currently shown to ' +
        'you. The most relevant facts are already in your context; call this when the owner asks ' +
        'what you know, when you need an older detail, or before writing a fact whose key might ' +
        'already exist.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keywords or a key prefix, e.g. "work" or "gym".' } },
      },
    },
    {
      name: 'forget_fact',
      description: 'Delete a remembered fact by key. Use when the owner asks you to forget something.',
      input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },

    // ── Google ───────────────────────────────────────────────────────────────
    {
      name: 'list_calendar_events',
      description: 'List Google Calendar events between two local ISO times.',
      input_schema: {
        type: 'object',
        properties: { timeMinLocalISO: { type: 'string' }, timeMaxLocalISO: { type: 'string' } },
        required: ['timeMinLocalISO', 'timeMaxLocalISO'],
      },
    },
    {
      name: 'create_calendar_event',
      description:
        'Create a Google Calendar event. This does NOT ring and does NOT chase; use create_alarm ' +
        'for a ring or create_reminder for something to follow up on.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, startLocalISO: { type: 'string' }, endLocalISO: { type: 'string' } },
        required: ['title', 'startLocalISO', 'endLocalISO'],
      },
    },
    {
      name: 'create_task',
      description:
        'Create a Google Task, optionally due at a local ISO time. Otto cannot read these back or ' +
        'chase them — use create_reminder for anything you should follow up on.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, dueLocalISO: { type: 'string' } },
        required: ['title'],
      },
    },
  ]
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
      return { events: await listCalendarEvents(device.deviceId, String(a.timeMinLocalISO), String(a.timeMaxLocalISO)) }
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
    default:
      return { error: `unknown tool ${name}` }
  }
}
