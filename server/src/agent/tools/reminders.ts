import type { ToolDef } from './types.js'

/**
 * Reminder tools: things the owner has to DO, which Otto chases until they say it is done.
 *
 * The descriptions are load-bearing. They are where the alarm-vs-reminder decision is actually
 * made — the model chooses a tool from this text, which renders before the system prompt — so they
 * repeat that distinction on purpose rather than deferring to the prompt.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const reminderTools: ToolDef[] = [
  {
    name: 'create_reminder',
    description:
      'Track something the owner needs to DO, follow up until they say it is done, then stop. ' +
      'Call this whenever the owner says "remind me to…", "make sure I…", "don\'t let me ' +
      'forget…", or mentions a task with no fixed ringing moment. Set ring=true when the due ' +
      'time is also a moment that should interrupt them — that arms an alarm AND keeps chasing ' +
      'afterwards. Never create an alarm and a reminder separately for the same thing.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative task, e.g. "take the bins out"' },
        detail: { type: 'string', description: 'Optional extra context worth repeating in a nudge' },
        dueLocalISO: {
          type: 'string',
          description:
            'Local ISO 8601 with NO offset, in the device timezone, e.g. 2026-08-03T18:00:00. Omit for an undated "someday" reminder that only appears in lists and digests.',
        },
        timing: {
          type: 'string',
          enum: ['deadline', 'appointment', 'trigger'],
          description:
            'What the due time MEANS. Always set this when you pass dueLocalISO — it decides ' +
            'whether you speak before that moment, after it, or both. ' +
            'deadline — the task must be FINISHED BY then ("get it done by 4", "before the shops ' +
            'shut", "by Friday"). You warn them several times in the run-up, then chase hard once ' +
            'it is past. ' +
            'appointment — the task HAPPENS AT that moment and is then over ("the dentist is at 4", ' +
            '"call mum at 6", "the meeting starts at 9"). You prompt shortly before and check ' +
            'shortly after, then stop. ' +
            'trigger — the time is when they want to be TOLD, not when the thing happens ("remind ' +
            'me at 4", "give me a shout at half six"). You say nothing beforehand and start chasing ' +
            'from that moment. ' +
            'Defaults to deadline whenever dueLocalISO is given, because a time someone states and ' +
            'does not explain is almost always the moment a thing has to be done BY. An undated ' +
            'reminder defaults to trigger, since there is nothing to lead.',
        },
        recurrence: {
          type: 'string',
          description:
            'Optional repeat rule; dueLocalISO is the first occurrence. FREQ=DAILY|WEEKLY|MONTHLY, optional INTERVAL=n, optional BYDAY=MO,..,SU (WEEKLY only). Completing one occurrence rolls to the next; cancel_reminder ends the series.',
        },
        nagPolicy: {
          type: 'string',
          enum: ['off', 'gentle', 'persistent', 'hard', 'relentless'],
          description:
            'How hard to chase, from off to relentless. off = write it down and say nothing on a ' +
            'clock. gentle = two or three messages in total. persistent (default) = a handful over ' +
            'hours, then once a day. hard = a dozen or so, tight around the time itself. ' +
            'relentless = twenty-plus, minutes apart around the moment. Pick one without asking. ' +
            'Reach for hard or relentless when they have asked to be pushed on this specific thing, ' +
            'or when missing it has real consequences. None of these ring the phone or override ' +
            'quiet hours — that is escalateWithAlarm, which is a separate decision.',
        },
        leadMinutes: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Exact minutes BEFORE the due time to give a heads-up, e.g. [1440, 60, 10] for a day ' +
            'before, an hour before, and ten minutes before. All positive — the name carries the ' +
            'direction. Use only when the owner says how much warning they want ("tell me a week ' +
            'and a day before"); otherwise omit and let timing and nagPolicy choose. Ignored for ' +
            'timing=trigger, which never speaks beforehand. Anything landing less than ten minutes ' +
            'from now is dropped, and the reply tells you how many.',
        },
        chaseMinutes: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Exact minutes AFTER the due time to chase, e.g. [0, 15, 60]. 0 means at the due ' +
            'moment itself. All positive. Replaces the automatic chase schedule for this one ' +
            'reminder; after the last entry you stop, unless keepChasingDaily is true.',
        },
        keepChasingDaily: {
          type: 'boolean',
          description: 'After the last chaseMinutes entry, keep going once a day. Default false.',
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
    parameters: {
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
    parameters: { type: 'object', properties: { reminderId: { type: 'string' } }, required: ['reminderId'] },
  },
  {
    name: 'snooze_reminder',
    description:
      'Push a reminder\'s next follow-up back without completing it. Use when the owner says ' +
      '"not yet", "later", "tomorrow", "give me an hour". Pass exactly one of minutes or untilLocalISO.',
    parameters: {
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
    parameters: { type: 'object', properties: { reminderId: { type: 'string' } }, required: ['reminderId'] },
  },
  {
    name: 'reopen_reminder',
    description:
      'Undo a completion. Use when the owner says you ticked off the wrong thing, or the task ' +
      'turned out not to be finished after all.',
    parameters: { type: 'object', properties: { reminderId: { type: 'string' } }, required: ['reminderId'] },
  },
  {
    name: 'update_reminder',
    description:
      'Change an existing open reminder — what it says, when it is due, what that time means, or ' +
      'how hard you chase it. Use for "push me harder on that one", "actually it needs doing by ' +
      'Friday", "that\'s an appointment not a deadline", "stop nagging me about the bins", "warn ' +
      'me a day before that too". Pass only what changes. ' +
      'This is NOT the tool for "later" or "not now" — that is snooze_reminder, which moves the ' +
      'next chase without touching the deadline. Moving the due time LATER counts as them pushing ' +
      'it back and goes on the record either way, so do not use it to spare them the count. ' +
      'Returns the reminder as it now stands, including the next few times you will actually ' +
      'chase, so confirm with those rather than with what was asked for.',
    parameters: {
      type: 'object',
      properties: {
        reminderId: { type: 'string' },
        title: { type: 'string' },
        detail: { type: 'string' },
        dueLocalISO: { type: 'string', description: 'New due time, local ISO 8601 with NO offset.' },
        clearDue: { type: 'boolean', description: 'Drop the due time entirely, making it an undated "someday".' },
        timing: { type: 'string', enum: ['deadline', 'appointment', 'trigger'], description: 'As on create_reminder.' },
        nagPolicy: {
          type: 'string',
          enum: ['off', 'gentle', 'persistent', 'hard', 'relentless'],
          description: 'As on create_reminder. This is the knob for "push me harder" and "ease off".',
        },
        leadMinutes: { type: 'array', items: { type: 'number' }, description: 'As on create_reminder.' },
        chaseMinutes: { type: 'array', items: { type: 'number' }, description: 'As on create_reminder.' },
        keepChasingDaily: { type: 'boolean', description: 'As on create_reminder.' },
        useDefaultSchedule: {
          type: 'boolean',
          description: 'Throw away any custom leadMinutes/chaseMinutes and go back to what timing and nagPolicy imply.',
        },
        recurrence: { type: 'string', description: 'As on create_reminder.' },
        clearRecurrence: { type: 'boolean', description: 'Stop it repeating; the current occurrence stays.' },
        ring: { type: 'boolean', description: 'Arm or drop a ringing alarm at the due time.' },
        escalateWithAlarm: { type: 'boolean', description: 'As on create_reminder.' },
        resetChase: {
          type: 'boolean',
          description:
            'Start the ladder again from its first rung. Use when the reminder has genuinely ' +
            'changed into a different task, not to wipe how many times you have already chased it.',
        },
      },
      required: ['reminderId'],
    },
  },
]
