import { and, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes } from '../db/schema.js'
import { newNoteId } from '../lib/ids.js'
import { log } from '../lib/log.js'

export type Note = typeof notes.$inferSelect

/**
 * What a note can hang off. Both halves of [subjectKind, subjectId] are set together or not at all;
 * neither set means a standalone jotting, which is a first-class case rather than a degenerate one.
 */
export const SUBJECT_KINDS = ['reminder', 'alarm', 'event'] as const
export type SubjectKind = (typeof SUBJECT_KINDS)[number]

export const isSubjectKind = (v: unknown): v is SubjectKind =>
  typeof v === 'string' && (SUBJECT_KINDS as readonly string[]).includes(v)

/** A resolved subject: the id to key on, plus the label to freeze into the row. */
export type NoteSubject = { kind: SubjectKind; id: string; label: string | null }

/**
 * One note's ceiling, and the only thing that bounds a single row.
 *
 * Comfortably past a WhatsApp text message (4,096 chars) because the realistic large note is a
 * dictated one — a ten-minute voice note transcribes to roughly 9,000 characters, and silently
 * losing the back half of what someone said into a microphone is exactly the failure this feature
 * exists to prevent. Past this it is truncated with a visible marker rather than rejected: a note
 * that is 90% captured beats a tool call that errored and left nothing.
 */
export const MAX_NOTE_CHARS = 12_000
const TRUNCATION_MARKER = '\n\n[…truncated]'

/**
 * What ONE `read_notes` call may return.
 *
 * A tool result is re-sent with every later turn in the conversation, so an uncapped read of a
 * meeting's notes is not paid for once — it is paid for on every subsequent message in that
 * session. These two caps are what stop "read me my notes" from quietly becoming the most expensive
 * thing Otto does. The newest are kept when a cut is needed and the count dropped is always
 * reported, so a truncated read is never mistaken for a complete one.
 */
export const MAX_NOTES_RETURNED = 20
export const MAX_READ_CHARS = 4_000

export type NotePage = { notes: Note[]; total: number; omitted: number }

export type NoteQuery = {
  subject?: { kind: SubjectKind; id: string }
  /** Substring match on the body. SQLite LIKE is case-insensitive for ASCII, which is enough. */
  query?: string
  sinceMillis?: number
  untilMillis?: number
  /** Only notes attached to nothing. */
  standaloneOnly?: boolean
}

/**
 * Append one note. Never updates, never merges — a second thought is a second row.
 *
 * Callers validate the body is non-empty and resolve the subject; this trusts both, in the same way
 * `snoozeReminder` trusts its instant. The truncation here is the one thing it will not trust,
 * because the caller cannot know how long a transcript is.
 */
export function addNote(deviceId: string, body: string, subject: NoteSubject | null = null): Note {
  const now = Date.now()
  const trimmed = body.trim()
  const stored =
    trimmed.length > MAX_NOTE_CHARS
      ? trimmed.slice(0, MAX_NOTE_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
      : trimmed
  const row: Note = {
    noteId: newNoteId(),
    deviceId,
    subjectKind: subject?.kind ?? null,
    subjectId: subject?.id ?? null,
    subjectLabel: subject?.label ?? null,
    body: stored,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(notes).values(row).run()
  log.info(
    { noteId: row.noteId, subjectKind: row.subjectKind, chars: stored.length, truncated: stored !== trimmed },
    'note added',
  )
  return row
}

/**
 * Read notes back, oldest first, with an honest count of what was left out.
 *
 * Selected newest-first and reversed rather than selected oldest-first, so that when the caps bite
 * it is the OLDEST notes that get dropped. Reading back a meeting should show what was said most
 * recently, not the first twenty things said in it and then silence.
 */
export function readNotes(deviceId: string, q: NoteQuery = {}): NotePage {
  const where = and(eq(notes.deviceId, deviceId), ...filters(q))

  const total = Number(db.select({ n: sql<number>`COUNT(*)` }).from(notes).where(where).get()?.n ?? 0)

  const newestFirst = db
    .select()
    .from(notes)
    .where(where)
    .orderBy(desc(notes.createdAt), desc(notes.noteId))
    .limit(MAX_NOTES_RETURNED)
    .all()

  const kept: Note[] = []
  let chars = 0
  for (const note of newestFirst) {
    // Always keep the first, whatever its size: a single 12,000-char note must still be readable,
    // and returning an empty page with "1 omitted" would be a dead end the model cannot escape.
    if (kept.length > 0 && chars + note.body.length > MAX_READ_CHARS) break
    kept.push(note)
    chars += note.body.length
  }
  kept.reverse()
  return { notes: kept, total, omitted: total - kept.length }
}

/**
 * How many notes hang off each subject of one kind, as `{ [subjectId]: count }`.
 *
 * One grouped query rather than a count per row: `list_reminders` annotates every reminder it
 * returns, and doing that per reminder would put an N+1 on the path that answers "what have I got
 * on?" — the single most common thing the owner asks.
 */
export function noteCountsBySubject(deviceId: string, kind: SubjectKind): Record<string, number> {
  const rows = db
    .select({ subjectId: notes.subjectId, n: sql<number>`COUNT(*)` })
    .from(notes)
    .where(and(eq(notes.deviceId, deviceId), eq(notes.subjectKind, kind)))
    .groupBy(notes.subjectId)
    .all()
  const out: Record<string, number> = {}
  for (const r of rows) if (r.subjectId !== null) out[r.subjectId] = Number(r.n)
  return out
}

export function getNote(deviceId: string, noteId: string): Note | undefined {
  return db
    .select()
    .from(notes)
    .where(and(eq(notes.deviceId, deviceId), eq(notes.noteId, noteId)))
    .get()
}

/** The only removal path. Scoped by device so an id from elsewhere cannot delete another's note. */
export function deleteNote(deviceId: string, noteId: string): boolean {
  const res = db
    .delete(notes)
    .where(and(eq(notes.deviceId, deviceId), eq(notes.noteId, noteId)))
    .run()
  if (res.changes > 0) log.info({ noteId }, 'note deleted')
  return res.changes > 0
}

function filters(q: NoteQuery): SQL[] {
  const out: SQL[] = []
  if (q.subject) {
    out.push(eq(notes.subjectKind, q.subject.kind), eq(notes.subjectId, q.subject.id))
  } else if (q.standaloneOnly) {
    out.push(isNull(notes.subjectId))
  }
  if (q.query) {
    // Hand-written rather than drizzle's `like()` because the escaping only works with an explicit
    // ESCAPE clause, which `like()` does not emit. Without it a literal % or _ in what the owner
    // typed stays a wildcard, and searching "50%" quietly returns everything containing "50".
    out.push(sql`${notes.body} LIKE ${`%${escapeLike(q.query)}%`} ESCAPE '\\'`)
  }
  if (q.sinceMillis !== undefined) out.push(gte(notes.createdAt, q.sinceMillis))
  if (q.untilMillis !== undefined) out.push(lte(notes.createdAt, q.untilMillis))
  return out
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)
