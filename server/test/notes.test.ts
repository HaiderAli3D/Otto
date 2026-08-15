import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { runTool } from '../src/agent/tools.js'
import { ensureSchema } from '../src/db/client.js'
import { armAlarm } from '../src/services/alarms.js'
import {
  MAX_NOTES_RETURNED,
  MAX_NOTE_CHARS,
  MAX_READ_CHARS,
  addNote,
  deleteNote,
  noteCountsBySubject,
  readNotes,
} from '../src/services/notes.js'
import { createReminder } from '../src/services/reminders.js'
import { makeDevice } from './helpers.js'

/**
 * A private device per test. `ensureSchema()` creates tables that are absent — it does NOT empty
 * them — and every test file shares one in-memory database across its tests, so a shared device id
 * would leak notes from one case into the next. The rest of the suite handles this by hand-numbering
 * ids (dev_f1, dev_f2…); a counter does the same thing without the chance of reusing one.
 */
let DEV = ''
let seq = 0
beforeEach(() => {
  ensureSchema()
  DEV = `dev_notes_${++seq}`
})

describe('notes accumulate rather than replace', () => {
  it('appends, and reads back oldest first', () => {
    addNote(DEV, 'apples and milk', { kind: 'reminder', id: 'rem_1', label: 'Go to the shop' })
    addNote(DEV, 'and bread', { kind: 'reminder', id: 'rem_1', label: 'Go to the shop' })
    const page = readNotes(DEV, { subject: { kind: 'reminder', id: 'rem_1' } })
    expect(page.notes.map((n) => n.body)).toEqual(['apples and milk', 'and bread'])
    expect(page.total).toBe(2)
    expect(page.omitted).toBe(0)
  })

  it('keeps same-millisecond notes in the order they were written', () => {
    // The whole point of the monotonic ulid in lib/ids.ts. Two notes added in one turn land in the
    // same millisecond, and a random low-bit ulid would sort them by coin flip.
    const bodies = ['first', 'second', 'third', 'fourth', 'fifth']
    for (const b of bodies) addNote(DEV, b, { kind: 'reminder', id: 'rem_same_ms', label: 'x' })
    const page = readNotes(DEV, { subject: { kind: 'reminder', id: 'rem_same_ms' } })
    expect(page.notes.map((n) => n.body)).toEqual(bodies)
  })

  it('stores a note attached to nothing', () => {
    addNote(DEV, 'the kitchen tiles are 20x20')
    const [note] = readNotes(DEV, { standaloneOnly: true }).notes
    expect(note!.subjectKind).toBeNull()
    expect(note!.subjectId).toBeNull()
  })

  it('keeps notes separate per device', () => {
    addNote('dev_a', 'mine')
    addNote('dev_b', 'theirs')
    expect(readNotes('dev_a').notes).toHaveLength(1)
    expect(readNotes('dev_b').notes[0]!.body).toBe('theirs')
  })

  it('truncates a single enormous note with a visible marker instead of rejecting it', () => {
    const note = addNote(DEV, 'x'.repeat(MAX_NOTE_CHARS + 5_000))
    expect(note.body.length).toBeLessThanOrEqual(MAX_NOTE_CHARS)
    expect(note.body).toContain('truncated')
  })

  it('freezes the subject label at write time so a note outlives its subject', async () => {
    const device = makeDevice('dev_label')
    const r = await createReminder(device, { title: 'Q3 planning' })
    await runTool(device, 'add_note', { body: 'Sam said the deadline moved', reminderId: r.reminderId })
    // The reminder is gone as far as anything downstream is concerned; the note still says what it
    // was about. Nothing cascades into this table, and that is the property that makes it safe.
    const [note] = readNotes(device.deviceId, { subject: { kind: 'reminder', id: r.reminderId } }).notes
    expect(note!.subjectLabel).toBe('Q3 planning')
  })
})

describe('reading notes back', () => {
  it('searches the body, case-insensitively', () => {
    addNote(DEV, 'The Kitchen tiles are 20x20')
    addNote(DEV, 'call the plumber')
    expect(readNotes(DEV, { query: 'kitchen' }).notes).toHaveLength(1)
    expect(readNotes(DEV, { query: 'PLUMBER' }).notes).toHaveLength(1)
  })

  it('treats % and _ in a search as literal characters', () => {
    // Unescaped, "50%" is LIKE '%50%%' — a trailing wildcard that matches everything containing 50,
    // and worse, a bare "%" would match every note the owner has ever written.
    addNote(DEV, 'deposit was 50% up front')
    addNote(DEV, 'quote came to 5000')
    // Unescaped these are LIKE '%50%%' and '%%%' — the first gains a trailing wildcard and matches
    // "5000" too, and the second matches literally every note the owner has ever written. Escaped,
    // each finds only the note that really contains those characters.
    const fifty = readNotes(DEV, { query: '50%' }).notes
    expect(fifty).toHaveLength(1)
    expect(fifty[0]!.body).toContain('50%')

    const percent = readNotes(DEV, { query: '%' }).notes
    expect(percent).toHaveLength(1)
    expect(percent[0]!.body).toContain('50%')
  })

  it('filters by date range', () => {
    const note = addNote(DEV, 'dated')
    expect(readNotes(DEV, { sinceMillis: note.createdAt + 1 }).notes).toHaveLength(0)
    expect(readNotes(DEV, { untilMillis: note.createdAt }).notes).toHaveLength(1)
  })

  it('caps the count, keeps the NEWEST, and reports how many it dropped', () => {
    for (let i = 0; i < MAX_NOTES_RETURNED + 7; i++) addNote(DEV, `note ${i}`)
    const page = readNotes(DEV)
    expect(page.notes).toHaveLength(MAX_NOTES_RETURNED)
    expect(page.total).toBe(MAX_NOTES_RETURNED + 7)
    expect(page.omitted).toBe(7)
    // Oldest-first within the page, but the page itself is the tail of the log.
    expect(page.notes.at(-1)!.body).toBe(`note ${MAX_NOTES_RETURNED + 6}`)
    expect(page.notes[0]!.body).toBe('note 7')
  })

  it('caps total characters too', () => {
    for (let i = 0; i < 6; i++) addNote(DEV, 'y'.repeat(1_000))
    const page = readNotes(DEV)
    const chars = page.notes.reduce((n, note) => n + note.body.length, 0)
    expect(chars).toBeLessThanOrEqual(MAX_READ_CHARS)
    expect(page.omitted).toBeGreaterThan(0)
  })

  it('always returns at least one note even when that note alone blows the char cap', () => {
    // Otherwise a single dictated note larger than the cap comes back as an empty page with
    // "1 omitted" — a dead end the model has no way to escape.
    addNote(DEV, 'z'.repeat(MAX_READ_CHARS + 500))
    const page = readNotes(DEV)
    expect(page.notes).toHaveLength(1)
    expect(page.omitted).toBe(0)
  })

  it('counts notes per subject in one grouped lookup', () => {
    addNote(DEV, 'a', { kind: 'reminder', id: 'rem_x', label: 'x' })
    addNote(DEV, 'b', { kind: 'reminder', id: 'rem_x', label: 'x' })
    addNote(DEV, 'c', { kind: 'reminder', id: 'rem_y', label: 'y' })
    addNote(DEV, 'd', { kind: 'alarm', id: 'alm_z', label: 'z' })
    addNote(DEV, 'loose')
    expect(noteCountsBySubject(DEV, 'reminder')).toEqual({ rem_x: 2, rem_y: 1 })
    expect(noteCountsBySubject(DEV, 'alarm')).toEqual({ alm_z: 1 })
  })

  it('deletes only within the owning device', () => {
    const mine = addNote('dev_del_a', 'mine')
    expect(deleteNote('dev_del_b', mine.noteId)).toBe(false)
    expect(deleteNote('dev_del_a', mine.noteId)).toBe(true)
    expect(readNotes('dev_del_a').notes).toHaveLength(0)
  })
})

describe('the add_note / read_notes / delete_note tools', () => {
  it('attaches to a real reminder and reports what it attached to', async () => {
    const device = makeDevice('dev_tool_1')
    const r = await createReminder(device, { title: 'Go to the grocery store' })
    const res = (await runTool(device, 'add_note', {
      body: 'pick up apples and milk',
      reminderId: r.reminderId,
    })) as Record<string, unknown>
    expect(res.addedTo).toBe('Go to the grocery store')
    expect(String(res.noteId)).toMatch(/^not_/)
  })

  it('refuses an id that does not exist rather than filing the note somewhere unreachable', async () => {
    const device = makeDevice('dev_tool_2')
    const res = (await runTool(device, 'add_note', { body: 'x', reminderId: 'rem_nope' })) as { error?: string }
    expect(res.error).toContain('no reminder with id rem_nope')
    expect(readNotes(device.deviceId).notes).toHaveLength(0)
  })

  it('refuses a reminder belonging to another device', async () => {
    const owner = makeDevice('dev_owner')
    const other = makeDevice('dev_other', null)
    const r = await createReminder(owner, { title: 'theirs' })
    const res = (await runTool(other, 'add_note', { body: 'x', reminderId: r.reminderId })) as { error?: string }
    expect(res.error).toContain('no reminder with id')
  })

  it('refuses two subjects rather than silently picking one', async () => {
    const device = makeDevice('dev_tool_3')
    const res = (await runTool(device, 'add_note', {
      body: 'x',
      reminderId: 'rem_a',
      eventId: 'evt_b',
    })) as { error?: string }
    expect(res.error).toContain('one thing')
  })

  it('refuses an empty body', async () => {
    const device = makeDevice('dev_tool_4')
    const res = (await runTool(device, 'add_note', { body: '   ' })) as { error?: string }
    expect(res.error).toContain('needs some text')
  })

  it('attaches to a calendar event without verifying it, keeping the title for later', async () => {
    const device = makeDevice('dev_tool_5')
    await runTool(device, 'add_note', {
      body: 'Sam is taking the actions',
      eventId: 'goog_evt_123',
      eventTitle: 'Q3 planning',
    })
    const [note] = readNotes(device.deviceId, { subject: { kind: 'event', id: 'goog_evt_123' } }).notes
    expect(note!.subjectLabel).toBe('Q3 planning')
  })

  it('attaches to a real alarm and takes its label', async () => {
    const device = makeDevice('dev_tool_6')
    await armAlarm(device, { alarmId: 'alm_note_1', triggerAtMillis: Date.now() + 60_000, label: 'Standup' })
    await runTool(device, 'add_note', { body: 'dial-in is 4821', alarmId: 'alm_note_1' })
    const [note] = readNotes(device.deviceId, { subject: { kind: 'alarm', id: 'alm_note_1' } }).notes
    expect(note!.subjectLabel).toBe('Standup')
  })

  it('omits the per-note subject fields when the read was already filtered to one subject', async () => {
    const device = makeDevice('dev_tool_7')
    const r = await createReminder(device, { title: 'Shop' })
    await runTool(device, 'add_note', { body: 'milk', reminderId: r.reminderId })

    const filtered = (await runTool(device, 'read_notes', { reminderId: r.reminderId })) as {
      notes: Array<Record<string, unknown>>
    }
    expect(filtered.notes[0]!.about).toBeUndefined()
    expect(filtered.notes[0]!.body).toBe('milk')

    const flat = (await runTool(device, 'read_notes', {})) as { notes: Array<Record<string, unknown>> }
    expect(flat.notes[0]!.about).toBe('Shop')
    expect(flat.notes[0]!.subjectKind).toBe('reminder')
  })

  it('reports omitted only when something was actually dropped', async () => {
    const device = makeDevice('dev_tool_8')
    await runTool(device, 'add_note', { body: 'one' })
    const small = (await runTool(device, 'read_notes', {})) as { omitted?: number }
    expect(small.omitted).toBeUndefined()

    for (let i = 0; i < MAX_NOTES_RETURNED + 3; i++) addNote(device.deviceId, `n${i}`)
    const big = (await runTool(device, 'read_notes', {})) as { omitted?: number }
    expect(big.omitted).toBe(4)
  })

  it('errors on deleting an id that is not there', async () => {
    const device = makeDevice('dev_tool_9')
    const res = (await runTool(device, 'delete_note', { noteId: 'not_nope' })) as { error?: string }
    expect(res.error).toContain('no note with id')
  })

  it('shows a note COUNT on list_reminders, and nothing at all when there are none', async () => {
    const device = makeDevice('dev_tool_10')
    const withNotes = await createReminder(device, { title: 'Shop' })
    await createReminder(device, { title: 'Bins' })
    await runTool(device, 'add_note', { body: 'milk', reminderId: withNotes.reminderId })
    await runTool(device, 'add_note', { body: 'bread', reminderId: withNotes.reminderId })

    const res = (await runTool(device, 'list_reminders', {})) as {
      reminders: Array<{ title: string; notes?: number; body?: string }>
    }
    const shop = res.reminders.find((r) => r.title === 'Shop')!
    const bins = res.reminders.find((r) => r.title === 'Bins')!
    expect(shop.notes).toBe(2)
    expect(bins.notes).toBeUndefined()
    // A count, never the text — the whole design rests on notes not leaking into anything the
    // owner did not ask for.
    expect(JSON.stringify(res)).not.toContain('milk')
  })
})

/**
 * The load-bearing property, asserted at the source level because there is no runtime path that
 * could ever demonstrate its absence.
 *
 * "Notes are only read when the owner asks" is the decision the whole feature is shaped around: it
 * is why nudges were left untouched, why there are no per-note caps in the nudge prompt, and why
 * `reminders.detail` still exists as a separate field. Nothing about a passing test suite would
 * notice someone later folding notes into a nudge, a brief or the cached prompt — it would simply
 * start happening, and the first sign would be a 3am message quoting something the owner wrote
 * down for themselves.
 */
describe('nothing reads notes proactively', () => {
  const PROACTIVE_SURFACES = [
    'src/agent/nudge.ts',
    'src/agent/brief.ts',
    'src/agent/prompt.ts',
    'src/agent/promptSections.ts',
    'src/services/nagging.ts',
    'src/services/brief.ts',
    'src/services/digest.ts',
    'src/services/weeklyReview.ts',
  ]

  for (const file of PROACTIVE_SURFACES) {
    it(`${file} does not import the notes service`, () => {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      expect(src).not.toMatch(/from '.*services\/notes\.js'/)
    })
  }

  it('the garbage collector does not sweep notes', () => {
    // Every row in `notes` is something the owner actually said. `facts` already establishes the
    // rule — it only ever prunes INFERRED entries — and notes have no inferred kind at all.
    const gc = readFileSync(new URL('../src/services/gc.ts', import.meta.url), 'utf8')
    expect(gc).not.toContain('notes')
  })
})
