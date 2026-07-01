import type Anthropic from '@anthropic-ai/sdk'
import { newAlarmId } from '../lib/ids.js'
import { armAlarm, cancelAlarm, listArmed } from '../services/alarms.js'
import type { Device } from '../services/devices.js'
import { createCalendarEvent, createTask, hasGoogle, listCalendarEvents } from '../services/google.js'
import { epochMillisToLocalHuman, localIsoToEpochMillis } from '../services/time.js'

/** The tool surface the Claude agent can call. Calendar/Tasks tools no-op gracefully if unconnected. */
export function buildTools(): Anthropic.Tool[] {
  return [
    {
      name: 'create_alarm',
      description: 'Set a real alarm that rings loudly on the phone at a local wall-clock time.',
      input_schema: {
        type: 'object',
        properties: {
          whenLocalISO: {
            type: 'string',
            description: 'Local ISO 8601 with NO offset, in the device timezone, e.g. 2026-07-02T18:00:00',
          },
          label: { type: 'string', description: 'Short label shown on the alarm screen' },
          allowWhileIdle: { type: 'boolean', description: 'Defaults true' },
        },
        required: ['whenLocalISO', 'label'],
      },
    },
    {
      name: 'cancel_alarm',
      description: 'Cancel a previously set alarm by its alarmId (from list_alarms).',
      input_schema: { type: 'object', properties: { alarmId: { type: 'string' } }, required: ['alarmId'] },
    },
    {
      name: 'list_alarms',
      description: 'List the alarms currently set (armed) on the phone.',
      input_schema: { type: 'object', properties: {} },
    },
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
      description: 'Create a Google Calendar event. This does NOT ring; use create_alarm for a ring.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, startLocalISO: { type: 'string' }, endLocalISO: { type: 'string' } },
        required: ['title', 'startLocalISO', 'endLocalISO'],
      },
    },
    {
      name: 'create_task',
      description: 'Create a Google Task, optionally due at a local ISO time.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, dueLocalISO: { type: 'string' } },
        required: ['title'],
      },
    },
  ]
}

export async function runTool(device: Device, name: string, input: unknown): Promise<unknown> {
  const a = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'create_alarm': {
      const triggerAtMillis = localIsoToEpochMillis(String(a.whenLocalISO), device.timezone)
      const alarmId = newAlarmId()
      const { sent } = await armAlarm(device, {
        alarmId,
        triggerAtMillis,
        label: String(a.label ?? 'Alarm'),
        allowWhileIdle: typeof a.allowWhileIdle === 'boolean' ? a.allowWhileIdle : undefined,
      })
      return { alarmId, firesAtLocal: epochMillisToLocalHuman(triggerAtMillis, device.timezone), delivered: sent }
    }
    case 'cancel_alarm': {
      await cancelAlarm(device, String(a.alarmId))
      return { cancelled: true }
    }
    case 'list_alarms': {
      return {
        alarms: listArmed(device.deviceId).map((x) => ({
          alarmId: x.alarmId,
          label: x.label,
          firesAtLocal: epochMillisToLocalHuman(x.triggerAtMillis, device.timezone),
        })),
      }
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
