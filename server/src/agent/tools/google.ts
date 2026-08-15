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

/**
 * Connecting Google, kept OUT of `googleTools` above and spread last in `buildTools`.
 *
 * Not a taste call: `googleTools` is spread fourth, so adding a fifth entry there would push every
 * tool after it down the cached prompt prefix and bill every user a full-price turn at deploy. The
 * end of the list shifts nothing — the same trade `manage_places` and the note tools took.
 */
export const googleLinkTools: ToolDef[] = [
  {
    name: 'link_google',
    description:
      'Get the link the owner taps to connect or reconnect their Google Calendar and Tasks. Use ' +
      'it whenever they ask to link, connect or reconnect Google, and whenever a calendar or ' +
      'task tool answers "not connected" — their access can be revoked at any time, and this is ' +
      'the only way back. Send them the returned url exactly as given.',
    parameters: { type: 'object', properties: {} },
  },
]
