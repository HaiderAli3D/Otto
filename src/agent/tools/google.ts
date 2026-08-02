import type Anthropic from '@anthropic-ai/sdk'

/**
 * Google Calendar and Tasks.
 *
 * These are present even when the owner has never connected Google, and that is the point: a tool
 * list that changed shape per device would invalidate that device's prompt cache on every request.
 * runTool answers { error: '... not connected' } instead, which the model handles fine.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const googleTools: Anthropic.Tool[] = [
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
