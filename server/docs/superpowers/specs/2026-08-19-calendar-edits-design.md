# Taking things off the calendar, and laying out a day — design

**Date:** 2026-08-19
**Repo:** `otto-server` (the Android app is untouched by this feature and has no calendar code)
**Status:** implemented

## The problem

Otto could read the calendar and add to it, and that was all. `services/google.ts` held
`events.list`, `events.insert` and `events.get` and nothing else — no `delete`, no `patch`. Once
Otto put something on the calendar, neither Otto nor the owner could get it off again through Otto.

The prompt had been written around the hole rather than the hole being fixed. `JOURNEYS` told Otto
to say so out loud, twice: a duplicate was something *"they have to delete themselves"*, and undoing
a journey ended *"the calendar entry is theirs to delete."* The honest answer to "cancel my 3pm" was
*open Google Calendar and do it by hand.*

Separately, every one of the 24 tools was single-entity, so an eight-block day was eight
`create_calendar_event` calls. `runner.ts` caps a turn at `MAX_STEPS = 10` model calls and shares
`max_output_tokens: 8192` between reasoning and output — a day written that way is one truncation
away from being half-built and reported as done.

The OAuth scope already held (`calendar.events`) covers `delete` and `patch`, so none of this needed
re-consent or a `SETUP.md` change.

## Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | Three tools — `delete_calendar_event`, `update_calendar_event`, `plan_day` | one `manage_calendar_event` with an action enum |
| 2 | One clear match acts without asking; 2+ returns `ambiguous` and never picks | a confidence threshold; deleting the best match |
| 3 | An event is always re-resolved against a fresh listing, never trusted from a bare id | accepting the `eventId` the model passes |
| 4 | The deleted event is handed back as `restoreWith` | a pending-action table, or a real undo store |
| 5 | Deleting cancels the event's derived leave-by alarms in code | leaving the 45-minute recheck to notice |
| 6 | Delete refuses a repeating event until told `this` or `series` | inferring the scope from the wording |
| 7 | `plan_day` skips a clashing block and reports it | overwriting; refusing the whole batch |
| 8 | `plan_day` returns `allWritten: false` whenever anything was skipped or failed | a bare success object |

Decision 2 is the one the rest hangs off. It is why the ambiguity list carries event ids, why an
empty description is refused outright, and why decision 4 exists at all.

**On decision 1.** `manage_places` is the precedent for merging verbs, and merging would have been
cheaper in the cached prefix. The argument that settled `plan_journey` vs `create_leave_by_alarm`
pointed the other way and won: split by INPUT, on a distinction the model can make straight from the
owner's sentence. "Get rid of the 3pm", "move the 3pm to 4" and "plan my day" are three sentences.

**On decision 3.** `calendarEventView` hands the model `eventKeyOf(e)`, which falls back to the
**summary** when Google gave no id. A tool that trusted that value would eventually send a title to
`events.delete`, take the 404 for "already gone", and tell the owner a meeting was cancelled that is
still sitting on their calendar. Re-resolving costs one listing the tools need anyway.

**On decision 5.** `leaveByAlarmId(deviceId, eventKey, dayKey)` is a hash of its inputs, built so
duplicate alarms would be unrepresentable. That property pays for itself twice: the alarm for an
event can be recomputed *from* the event, with no lookup table. `handlers/leaveBy.ts` already
cancels both alarms when its recheck finds the event gone — but that recheck runs exactly once, 45
minutes before departure. Delete the event after it has run and nothing else ever looks: the phone
rings, at full volume, over the lockscreen, to send the owner somewhere they are no longer going.

## Two arguments inside the cached prefix

Both were found by reading the prompt against the new tools, and both are pinned by tests in
`test/tools-order.test.ts`'s "the cached prefix does not contradict itself" suite.

**`REPLYING` would have won an argument it should lose.** It ends the whole prompt — the last thing
the model reads — with *"Still ask before anything destructive or clearly beyond what they asked
for."* Deleting a calendar event is destructive and irreversible, so on recency alone Otto would
answer every "cancel my 3pm" with "shall I?", which is exactly the behaviour this feature exists to
remove. `CALENDAR` states the exception in words meant to be unmissable — *"DO IT. Do not ask
permission first. This is the one exception…"* — and a test pins that both halves still say it.

**`JOURNEYS` had two claims that stopped being true.** Left alone they would have talked the owner
into doing by hand what Otto can now do in one call — the most expensive kind of stale line, because
nothing ever errors and nobody ever finds out.

## Guardrails, and where each is enforced

Code, not prose, wherever it could be:

| Guard | Enforced by |
|---|---|
| Never picks between two candidate events | `matchEvents` ladder in `resolveOne` |
| An empty description cannot mean "the only thing that day" | explicit check before `matchEvents`, which reads an empty needle as *everything* |
| An id that never came from Google is refused | `event.id === ''` check |
| An id that matches nothing in the window is refused | re-resolution against the listing |
| A truncated window never reports "no such event" | `events.length >= CALENDAR_PAGE_SIZE` |
| A repeating event is not deleted until the scope is known | `recurringEventId` + `needsScope` |
| Google-generated entries (birthdays, out-of-office) are refused | `eventType !== 'default'` |
| Attendees are never emailed | `sendUpdates: 'none'` on both delete and patch |
| A partial edit never wipes attendees or the conference link | `events.patch`, never `events.update` |
| Moving a start keeps the meeting's length | duration carried from the old span |
| An all-day entry is never given a start time | `isAllDay` + time-change check |
| A stale leave-by alarm cannot ring for a deleted or moved event | derived-id cancellation |
| `plan_day` never writes over an existing event | `overlapsWindow` against a server-side re-read |
| An all-day entry never blocks the whole day | `overlapsWindow` excludes all-day and cancelled |
| A day that could not be read is not planned | `tryListCalendarEvents === null` refuses before any write |
| A half-written day cannot be reported as planned | `allWritten` + `mustTell` |

Only the *saying* of it is prose: naming the event back with its day and time, relaying `mustTell`,
and mentioning that other people's copies moved too.

## Undo

There is no undelete in the Calendar API, so `delete_calendar_event` hands the whole event back as
`restoreWith` — every field `create_calendar_event` needs. Tool results are re-sent on every later
turn, so "no, not that one" is answerable for the life of the conversation, with no new tool, no
table and no state. It is faithful because the shape it restores is the shape Otto can write.

It is deliberately **absent** for `scope: 'series'`: re-inserting produces a standalone event, not a
series member, and offering an undo that cannot work is worse than admitting there is none.

## What this does not do

- No multi-calendar support. Everything stays `calendarId: 'primary'`.
- No free/busy query. `plan_day` places blocks the model chose and refuses the ones that clash; it
  does not search for a slot.
- No bulk clear-a-window tool. One bad call empties a real day.
- Otto's own blocks are indistinguishable from real events, so re-planning a day it already planned
  skips everything as a clash. Clearing them is `delete_calendar_event` per block. The proper fix is
  an `extendedProperties.private` stamp plus a `privateExtendedProperty` filter — a new Google
  concept, deferred rather than half-built.
- No confirmation gate. The owner chose "ask only when unsure"; `restoreWith` is the mitigation.
