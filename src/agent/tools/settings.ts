import type Anthropic from '@anthropic-ai/sdk'

/**
 * The owner's standing preferences: when Otto speaks first, and when he must not.
 *
 * A literal array, never a function — see the contract in ./index.ts. Nothing here is conditional on
 * whether a feature is configured, for the same reason the Google tools always exist: the tool block
 * renders at position 0 of every request and a list that changed shape would burn the prompt cache.
 *
 * One tool rather than several. "Stop messaging me at night, and push the brief back an hour" is one
 * sentence and should be one call; a `set_quiet_hours` / `set_brief_time` split would make the model
 * choose between them and then chain two round-trips for a single instruction.
 */
export const settingsTools: Anthropic.Tool[] = [
  {
    name: 'set_preferences',
    description:
      'Change when you are allowed to message the owner and when their daily brief lands. Call this ' +
      'as soon as they say anything about it — "stop messaging me at night", "move my brief to ' +
      '6:30", "not before 8", "give me an evening one too", "drop the weekly thing", "no more ' +
      'morning messages". Pass only the fields that change; everything you omit is left alone. ' +
      'Returns the settings as they now stand, so confirm using those values rather than what was ' +
      'asked for. All times are the owner\'s local wall clock.',
    input_schema: {
      type: 'object',
      properties: {
        briefEnabled: { type: 'boolean', description: 'Send a morning brief at all. On by default.' },
        briefHour: { type: 'number', description: 'Local hour 0-23 the morning brief lands at.' },
        briefMinute: { type: 'number', description: 'Local minute 0-59 the morning brief lands at.' },
        eveningBriefEnabled: {
          type: 'boolean',
          description: 'Send an evening brief about TOMORROW. Off by default.',
        },
        eveningBriefHour: { type: 'number', description: 'Local hour 0-23 the evening brief lands at.' },
        eveningBriefMinute: { type: 'number', description: 'Local minute 0-59 the evening brief lands at.' },
        quietHours: {
          type: 'string',
          description:
            'Do-not-disturb window as "HH:MM-HH:MM" local, or "off". Spans midnight, e.g. ' +
            '"22:00-07:00". Nothing proactive goes out inside it.',
        },
        weeklyReview: {
          type: 'string',
          description: 'Weekly review slot as "DDD:HH:MM" local — MON to SUN, e.g. "SUN:18:00" — or "off".',
        },
        autoWakeAlarm: {
          type: 'boolean',
          description: 'Automatically arm a wake-up alarm ahead of the first thing in the day.',
        },
        autoLeaveByAlarm: {
          type: 'boolean',
          description: 'Automatically arm a leave-by alarm ahead of an event they have to travel to.',
        },
      },
    },
  },
]
