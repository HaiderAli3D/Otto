import type { ToolDef } from './types.js'

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
export const settingsTools: ToolDef[] = [
  {
    name: 'set_preferences',
    description:
      'Change when you are allowed to message the owner, when their daily brief lands, and what ' +
      'hours they actually keep. Call this as soon as they say anything about it — "stop messaging ' +
      'me at night", "move my brief to 6:30", "not before 8", "give me an evening one too", "drop ' +
      'the weekly thing", "I sleep from about 2 till 4 and get up around lunchtime", "you are ' +
      'messaging me too much". Pass only the fields that change; everything you omit is left alone. ' +
      'Returns the settings as they now stand, so confirm using those values rather than what was ' +
      'asked for. All times are the owner\'s local wall clock.',
    parameters: {
      type: 'object',
      properties: {
        briefEnabled: { type: 'boolean', description: 'Send a morning brief at all. On by default.' },
        briefHour: { type: 'number', description: 'Local hour 0-23 the morning brief lands at.' },
        briefMinute: { type: 'number', description: 'Local minute 0-59 the morning brief lands at.' },
        eveningBriefEnabled: {
          type: 'boolean',
          description:
            'Send an evening brief about TOMORROW. Off by default. It must land at a different time ' +
            'from the morning one, or the call is rejected — only the morning brief could ever fire.',
        },
        eveningBriefHour: { type: 'number', description: 'Local hour 0-23 the evening brief lands at.' },
        eveningBriefMinute: { type: 'number', description: 'Local minute 0-59 the evening brief lands at.' },
        quietHours: {
          type: 'string',
          description:
            'Do-not-disturb window as "HH:MM-HH:MM" local, or "off". Spans midnight, e.g. ' +
            '"22:00-07:00". Briefs, reviews and follow-up chases wait for it to end. It does NOT ' +
            'hold back the four things listed under "Quiet hours" — a real alarm, an escalating ' +
            'reminder, a wake-check, or the first chase at a due time they picked themselves. ' +
            'Setting this explicitly also PINS it: once they have named a window themselves, telling ' +
            'you their sleeping hours later will not move it again.',
        },
        weeklyReview: {
          type: 'string',
          description: 'Weekly review slot as "DDD:HH:MM" local — MON to SUN, e.g. "SUN:18:00" — or "off".',
        },
        bedWindow: {
          type: 'string',
          description:
            'When the owner GOES TO BED, as a range "HH:MM-HH:MM" local (earliest to latest), or ' +
            '"off". e.g. "02:00-04:00" for someone who turns in somewhere between 2 and 4am. This ' +
            'does NOT stop you messaging them — quietHours is the only thing that holds anything ' +
            'back. It is context you judge against, and half of what sets their morning.',
        },
        wakeWindow: {
          type: 'string',
          description:
            'When the owner GETS UP, as a range "HH:MM-HH:MM" local, or "off". e.g. ' +
            '"10:00-14:00". The END of this range is what "morning" means for them: it is the hour ' +
            'any daily chase you schedule lands on, and setting it moves their brief there too ' +
            'unless you set a brief time in the same call. It also sets their quiet hours — latest ' +
            'bedtime to the point they are certainly up — unless they have named a window ' +
            'themselves, which always wins. So "I am up at noon and in bed by two" is one call and ' +
            'settles all of it. Save BOTH windows together — one on its own tells you nothing about ' +
            'when their day starts and is ignored.',
        },
        dailyMessageBudget: {
          type: 'number',
          description:
            'Safety cap on proactive messages per day, 0-500, where 0 means unlimited. A backstop ' +
            'against a runaway reminder, not a volume setting — it is deliberately high. Lower it ' +
            'if they say you are messaging too much, rather than turning their briefs or reminders ' +
            'off; a dial they can turn back up is recoverable and an off switch is not.',
        },
        autoWakeAlarm: {
          type: 'boolean',
          description:
            'When a leave-by alarm is set, add a get-up alarm ahead of it by default, without ' +
            'being asked each time. Only affects create_leave_by_alarm; alsoWakeMe on that call ' +
            'still wins for one journey.',
        },
        autoLeaveByAlarm: {
          type: 'boolean',
          description:
            'Standing consent to arm a leave-by alarm without being asked. Nothing currently plans ' +
            'journeys on its own, so this changes nothing today — never tell the owner you will ' +
            'start setting leave-by alarms for them.',
        },
      },
    },
  },
]
