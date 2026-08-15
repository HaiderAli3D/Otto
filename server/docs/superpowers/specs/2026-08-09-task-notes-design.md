# Notes on things — design

**Date:** 2026-08-09
**Repo:** `otto-server` (the Android app is untouched by this feature and never sees a note)
**Status:** implemented

## The problem

The owner can tell Otto to do something ("go to the grocery store") but has nowhere to put what they
said *about* it ("pick up apples and milk"). The nearest existing thing is `reminders.detail`, a
single free-text column set at create/update time and fed into every nudge. It cannot hold a second
thought without overwriting the first, it has no dates, and everything in it is repeated back on
every chase whether or not that is wanted.

Two shapes of the same need:

- **Carried context** — an errand plus the list of what it is for.
- **Captured record** — what was said in a meeting, dictated afterwards and wanted weeks later.

## Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | A note can attach to a reminder, an alarm or a calendar event — **or to nothing at all** | reminders-only; auto-creating a "someday" reminder to hold loose notes |
| 2 | Adding a second note **appends a new dated entry** | merging into one blob the model rewrites; tickable checklist items |
| 3 | Notes are read back **only when the owner asks** | riding along in every nudge; appearing at the due-time chase |
| 4 | Standalone notes are a **flat pile found by search** | topic slugs (a second key namespace next to `facts`) |
| 5 | **One polymorphic table** | a table per subject type; extending `facts` |

Decision 3 is the one the rest of the design hangs off. It is why the nudge path is untouched, why
no cap was needed on the nudge prompt, and why `reminders.detail` survives as a separate field.

## The boundary between the four stores

Otto can now write to four places. The tool descriptions are where the model actually makes this
choice, so each states the distinction outright.

| Store | Holds | Write semantics | Read |
|---|---|---|---|
| `facts` | a standing truth about the owner | upsert by key — a correction **replaces** | injected into every prompt |
| `reminders.detail` | the line worth repeating **while chasing** | overwritten on update | every nudge |
| `notes` | a dated thing they said **about** something | appended, never rewritten | **only on request** |
| `saved_places` | somewhere on a map | upsert by alias | on lookup |

The test the model applies: *still true next month, stated flatly?* → fact. *Belongs in the chase
message?* → `detail`. *Something they said at a moment, about something?* → note.

## Schema

```sql
CREATE TABLE notes (
  note_id       TEXT PRIMARY KEY,   -- 'not_' + MONOTONIC ulid
  device_id     TEXT NOT NULL,
  subject_kind  TEXT,               -- 'reminder' | 'alarm' | 'event' | NULL
  subject_id    TEXT,               -- reminderId | alarmId | eventKeyOf(event) | NULL
  subject_label TEXT,               -- the subject's title AS IT READ WHEN WRITTEN
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX notes_subject     ON notes (device_id, subject_kind, subject_id, created_at);
CREATE INDEX notes_device_time ON notes (device_id, created_at);
```

Three things earn their place:

**`subject_label` is denormalised on purpose.** Nothing cascades into this table and nothing can:
alarms get swept, calendar events get deleted, reminders get cancelled. Without the label a search
hit reads `note on rem_01H8QK…` and is worthless. With it the note outlives its subject.

**The id is a monotonic ULID**, unlike every other id in `lib/ids.ts`. Notes are an append-only log
read back in write order, and two added in one turn land in the same millisecond. A plain `ulid()`
re-randomises its low bits per call, so those two would sort by coin flip — and `readNotes` orders
on `(created_at, note_id)`.

**`[subject_kind, subject_id]` are both set or both null**, enforced in the service with a test
rather than a SQL `CHECK`: `ensureSchema()` is boot-time `CREATE TABLE IF NOT EXISTS`, which cannot
add a constraint to a table that already exists, so a code-enforced invariant is the one that stays
true.

## Tools

Three, appended at the end of `buildTools()` so nothing already in the cached prefix moves.

- **`add_note(body, reminderId? | alarmId? | eventId?, eventTitle?)`** — appends. No id = standalone.
  Reminder and alarm ids are **verified to exist on this device**; a note filed against a
  hallucinated id would be written, reported saved, and then be unreachable from the only tool that
  could read it back. Event ids are deliberately **not** verified — that would mean a Google
  round-trip per note, and `subject_label` is what makes the loose end survivable. Two ids is an
  error, never a precedence rule.
- **`read_notes(subject? | query? | date range? | standaloneOnly?)`** — the only path by which a note
  ever reaches the owner. Oldest-first, with dates and note ids.
- **`delete_note(noteId)`** — the only removal path, since nothing is ever edited in place.

`calendarEventView` gains `eventId: eventKeyOf(e)`. It was previously excluded on the grounds that
no tool accepted it as input; `add_note` now does. Keying event notes on the **title** instead was
rejected: every daily "Standup" would silently share one pile, and two unrelated meetings with the
same name would merge.

`reminderView` gains `notes: <count>`, omitted at zero. A count, never the text — without a signpost
the model cannot know there is anything to offer, and "only when you ask" degrades into "only when
you remember there was something to ask about".

## Cost control

A tool result is re-sent with every later turn in the conversation, so an uncapped read is not paid
for once but on every subsequent message.

- One note: 12,000 chars, truncated with a visible marker rather than rejected. Past a WhatsApp
  message on purpose — the realistic large note is a dictated one, and a ten-minute voice note
  transcribes to roughly 9,000 characters.
- One read: 20 notes / 4,000 chars, **keeping the newest**, always at least one, and always
  reporting how many it dropped so a trimmed read can never be mistaken for a complete one.

## Lifecycle

- **Completion and cancellation do nothing to notes.** Completing "attend the standup" must not
  delete what was said in it.
- **Recurring reminders keep one row**, so notes accumulate across occurrences and come back
  newest-last with dates. There is no per-occurrence entity to attach to, and inventing one for this
  would be a larger change than the feature.
- **The garbage collector never sweeps notes.** Every row is something the owner actually said;
  `facts` already establishes that only *inferred* entries are ever pruned, and notes have no
  inferred kind. They also cost nothing until read.

## Falls out for free

Dictation and photos already work: `services/ingest.ts` transcribes a voice note through STT and
describes an image through vision *before* the agent sees the turn, so `add_note` receives the
transcript with no new plumbing.

## Not built (deliberately)

Note editing (delete and re-add), topic slugs, notes in nudges or briefs, tickable checklist items,
and any Android app change. The phone never sees a note.

## Verification

`test/notes.test.ts`, 34 tests: append order including same-millisecond writes, standalone notes,
per-device isolation, truncation, `LIKE` metacharacter escaping, date ranges, both caps and the
always-return-one floor, grouped counts, device-scoped deletion, label frozen at write time, and the
tool layer's id verification and error paths.

The load-bearing property gets a source-level test, because no runtime path could ever demonstrate
its absence: **nothing reads notes proactively.** `nothing reads notes proactively` asserts that none
of the eight proactive surfaces (nudge, brief, prompt, promptSections, nagging, digest, weekly
review) imports the notes service, and that `gc.ts` does not mention it. Without that, someone
folding notes into a nudge later would break no test — and the first sign would be a 3am message
quoting something the owner wrote down for themselves.
