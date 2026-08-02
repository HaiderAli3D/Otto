import type Anthropic from '@anthropic-ai/sdk'

/**
 * Reminder tools: things the owner has to DO, which Otto chases until they say it is done.
 *
 * The descriptions are load-bearing. They are where the alarm-vs-reminder decision is actually
 * made — the model chooses a tool from this text, which renders before the system prompt — so they
 * repeat that distinction on purpose rather than deferring to the prompt.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const reminderTools: Anthropic.Tool[] = [
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
]
