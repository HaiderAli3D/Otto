import type { ToolDef } from './types.js'

/**
 * Notes: what the owner SAID about a thing, as opposed to the thing itself.
 *
 * Otto can now write to four stores, and these descriptions are where three of the four boundaries
 * actually get drawn — the model picks a tool from this text, which renders ahead of the system
 * prompt. So each one states the distinction outright rather than trusting the prompt to carry it:
 *
 *   remember_fact       a standing truth about the owner; a correction REPLACES it
 *   update_reminder     `detail` — the line worth repeating every time you chase them
 *   add_note            a dated thing they said about something; appended, read only on request
 *   manage_places       somewhere on a map, which is a tuple the server joins on, not prose
 *
 * The property every one of these repeats is that notes are NEVER read out on their own. That is
 * not an implementation detail the model can be left to infer — a model that believes notes might
 * surface in a nudge will start putting things in notes that belong in `detail`, and the owner
 * finds out at the moment the nudge does not mention the thing they wrote down.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const noteTools: ToolDef[] = [
  {
    name: 'add_note',
    description:
      'Write down something the owner said ABOUT a thing, kept word for word until they ask for ' +
      'it back. Call this for "note that down", "add to that", "while you\'re there I also need…", ' +
      'and for anything they dictate after a meeting or a call. ' +
      'Attach it by passing the reminderId, alarmId or eventId it is about; pass none of them for a ' +
      'loose jotting with no subject. ' +
      'Notes are NEVER read out on their own — no nudge, brief or reminder ever includes one — so a ' +
      'note is for what they will come back and ASK for, like what to buy once they are at the shop. ' +
      'If it must be repeated every time you chase them, that is update_reminder\'s detail, not a ' +
      'note. If it is a standing truth about them that still holds next month, that is ' +
      'remember_fact. If it is somewhere on a map, that is manage_places. ' +
      'Every call APPENDS. Nothing is ever overwritten, so add a second note rather than restating ' +
      'the first with the new bit folded in.',
    parameters: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description:
            'What they said, in their words. Do not summarise a dictated note — the point of it is ' +
            'that they get back what they actually said.',
        },
        reminderId: { type: 'string', description: 'Attach to this reminder. From list_reminders.' },
        alarmId: { type: 'string', description: 'Attach to this alarm. From list_alarms.' },
        eventId: {
          type: 'string',
          description: 'Attach to this calendar event. From list_calendar_events or create_leave_by_alarm.',
        },
        eventTitle: {
          type: 'string',
          description:
            'The event\'s name as the owner would say it, e.g. "Q3 planning". Only used so the note ' +
            'still reads sensibly if that event is later deleted from the calendar — never used to ' +
            'match anything. Pass it whenever you pass eventId.',
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'read_notes',
    description:
      'Read notes back. This is the ONLY way a note ever reaches the owner, so call it whenever ' +
      'they ask what they wrote, what they need while they are out, or what was said in a meeting — ' +
      'and whenever a reminder you are discussing shows a note count. ' +
      'Pass a reminderId, alarmId or eventId for everything noted about that one thing. Pass query ' +
      'and/or a date range to search across every note, including ones attached to nothing. Pass ' +
      'nothing at all for the most recent notes overall. ' +
      'Returns oldest first, each with the date it was written and its noteId. A long history comes ' +
      'back trimmed to the most recent, and says how many it left out — narrow with a date range or ' +
      'a query rather than assuming that is all of them.',
    parameters: {
      type: 'object',
      properties: {
        reminderId: { type: 'string' },
        alarmId: { type: 'string' },
        eventId: { type: 'string' },
        query: { type: 'string', description: 'Substring of the note text, e.g. "kitchen" or "Sam".' },
        sinceLocalISO: { type: 'string', description: 'Only notes written at or after this. Local ISO 8601, NO offset.' },
        untilLocalISO: { type: 'string', description: 'Only notes written at or before this. Local ISO 8601, NO offset.' },
        standaloneOnly: {
          type: 'boolean',
          description: 'Only notes attached to nothing. Ignored when a reminderId/alarmId/eventId is given.',
        },
      },
    },
  },
  {
    name: 'delete_note',
    description:
      'Delete one note. Notes are append-only, so this is the only way to remove one — use it when ' +
      'the owner says a note is wrong, was meant for something else, or is no longer wanted. Get the ' +
      'noteId from read_notes; never guess one. Deleting the wrong note is unrecoverable, so if two ' +
      'could plausibly match, read them back and ask which.',
    parameters: { type: 'object', properties: { noteId: { type: 'string' } }, required: ['noteId'] },
  },
]
