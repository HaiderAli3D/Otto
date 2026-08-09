import type { ToolDef } from './types.js'

/**
 * Google Calendar and Tasks.
 *
 * These are present even when the owner has never connected Google, and that is the point: a tool
 * list that changed shape per device would invalidate that device's prompt cache on every request.
 * runTool answers { error: '... not connected' } instead, which the model handles fine.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const googleTools: ToolDef[] = [
  {
    name: 'list_calendar_events',
    description: 'List Google Calendar events between two local ISO times.',
    parameters: {
      type: 'object',
      properties: { timeMinLocalISO: { type: 'string' }, timeMaxLocalISO: { type: 'string' } },
      required: ['timeMinLocalISO', 'timeMaxLocalISO'],
    },
  },
  {
    name: 'create_calendar_event',
    description:
      'Create a Google Calendar event. This does NOT ring and does NOT chase; use create_alarm ' +
      'for a ring or create_reminder for something to follow up on. Always pass location when ' +
      'the event happens somewhere — without it nothing can ever work out when they need to leave.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startLocalISO: { type: 'string' },
        endLocalISO: { type: 'string' },
        location: {
          type: 'string',
          description:
            'Where it is. A full address if you have one — this is what the travel time is worked out from.',
        },
      },
      required: ['title', 'startLocalISO', 'endLocalISO'],
    },
  },
  {
    name: 'create_task',
    description:
      'Create a Google Task, optionally due at a local ISO time. Otto cannot read these back or ' +
      'chase them — use create_reminder for anything you should follow up on.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, dueLocalISO: { type: 'string' } },
      required: ['title'],
    },
  },
]
