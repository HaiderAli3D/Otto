import type Anthropic from '@anthropic-ai/sdk'

/**
 * Alarm tools: a ring at an exact moment, with no completion state and no follow-up.
 *
 * A literal array, never a function — see the contract in ./index.ts. Anything conditional here
 * (a flag, a device capability, "only if X is connected") re-renders the tool block and burns the
 * whole prompt cache on every request; refuse at call time in runTool instead.
 */
export const alarmTools: Anthropic.Tool[] = [
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
]
