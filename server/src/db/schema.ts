import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** One paired phone. Single-user today, but keyed by deviceId so more can pair later. */
export const devices = sqliteTable('devices', {
  deviceId: text('device_id').primaryKey(),
  fcmToken: text('fcm_token'),
  appVersion: text('app_version'),
  hmacSecret: text('hmac_secret').notNull(),
  whatsappNumber: text('whatsapp_number'),
  timezone: text('timezone').notNull().default('UTC'),
  // Fail-closed-once-paired: set on the first valid signed request; from then on the device
  // endpoints require a signature for this deviceId (services/deviceAuth.ts).
  authLatched: integer('auth_latched', { mode: 'boolean' }).notNull().default(false),
  lastHeartbeatAt: integer('last_heartbeat_at'),
  // WhatsApp's 24h customer-service window clock. Stamped on EVERY inbound (including voice
  // notes). Proactive free-form sends are only legal while this is recent — see services/outbox.
  lastInboundAt: integer('last_inbound_at'),
  // The owner did SOMETHING — replied, or pressed a button on a notification. Deliberately not the
  // same column as lastInboundAt: that one is a Meta transport fact (the 24h free-form window,
  // which only an inbound message reopens), while this one answers "are they awake and engaging?".
  // A "Done" tapped on the lockscreen answers the second and not the first.
  lastActivityAt: integer('last_activity_at'),
  // Day-boundary marker (device timezone) for the once-a-day backlog digest.
  lastDigestAt: integer('last_digest_at'),
  // Last time a paid template message was sent to prise the 24h window back open. A transport fact
  // written by the sender, NOT an owner setting — hence here and not in device_settings.
  lastTemplateAt: integer('last_template_at'),
  createdAt: integer('created_at').notNull(),
})

/**
 * Owner-authored settings, one row per device. Deliberately NOT more columns on `devices`.
 *
 * `devices` is transport and identity — fcm token, zone, heartbeat, the 24h window clock — and every
 * one of those columns is written BY THE SYSTEM from a device signal, on paths that run on every
 * request. These are the opposite: the owner authors them from chat, the list keeps growing as
 * features land, and they are read on a handful of scheduler paths. Mixing the two would mean a
 * "move my brief to 7:30" chat message rewrites the row that push delivery depends on.
 *
 * Every hour/minute here is LOCAL WALL-CLOCK time in `devices.timezone`, never a UTC offset: 07:00
 * means 07:00 to the owner in July and in January. The instant is computed only when a job is
 * scheduled (services/time.ts `nextLocalTimeAt`), so DST moves the offset, not the wake-up.
 *
 * `services/settings.ts getSettings()` fills every default, so a device with no row here is never a
 * special case for a caller. The WHOLE column set lands in one migration even though most of it is
 * unused until its feature arrives — four parallel feature branches must never each edit the same
 * migration, and SQLite has no cheap way to reconcile that after the fact.
 */
export const deviceSettings = sqliteTable('device_settings', {
  deviceId: text('device_id').primaryKey(),
  briefEnabled: integer('brief_enabled', { mode: 'boolean' }).notNull().default(true),
  briefHour: integer('brief_hour').notNull().default(7),
  briefMinute: integer('brief_minute').notNull().default(0),
  eveningBriefEnabled: integer('evening_brief_enabled', { mode: 'boolean' }).notNull().default(false),
  eveningBriefHour: integer('evening_brief_hour').notNull().default(21),
  eveningBriefMinute: integer('evening_brief_minute').notNull().default(0),
  lastBriefAt: integer('last_brief_at'),
  lastEveningBriefAt: integer('last_evening_brief_at'),
  quietHours: text('quiet_hours'), // "22:00-07:00" | "off" | null => config.quietHoursDefault
  // When the owner actually sleeps, as two ranges: "02:00-04:00" / "10:00-14:00".
  //
  // Deliberately NOT a do-not-disturb window — quietHours above remains the only thing that
  // suppresses anything, and an owner can have a routine with quiet hours switched off entirely.
  // This is context Otto reasons about, plus the one input that decides which wall-clock hour a
  // rung Otto CHOOSES lands on (lib/routine.ts `dayStartHour`, the end of the wake window).
  bedWindow: text('bed_window'),
  wakeWindow: text('wake_window'),
  // Runaway backstop, not a volume policy: proactive messages per local day before Otto defers the
  // rest to tomorrow. 0 means unlimited. High by default because the ladders are meant to be loud;
  // this exists so a misconfigured `relentless` reminder cannot empty the battery overnight.
  dailyMessageBudget: integer('daily_message_budget').notNull().default(60),
  weeklyReviewAt: text('weekly_review_at'), // "SUN:18:00" | "off" | null => config.weeklyReviewDefault
  lastWeeklyReviewAt: integer('last_weekly_review_at'),
  autoWakeAlarm: integer('auto_wake_alarm', { mode: 'boolean' }).notNull().default(false),
  autoLeaveByAlarm: integer('auto_leave_by_alarm', { mode: 'boolean' }).notNull().default(false),
  defaultTravelMinutes: integer('default_travel_minutes').notNull().default(30),
  getReadyMinutes: integer('get_ready_minutes').notNull().default(45),
  updatedAt: integer('updated_at').notNull(),
})

/** The authoritative alarm set. The app arms `state='ARMED'` alarms and reports back events. */
export const alarms = sqliteTable('alarms', {
  alarmId: text('alarm_id').primaryKey(),
  deviceId: text('device_id').notNull(),
  triggerAtMillis: integer('trigger_at_millis').notNull(),
  label: text('label').notNull().default('Alarm'),
  state: text('state').notNull().default('ARMED'),
  allowWhileIdle: integer('allow_while_idle', { mode: 'boolean' }).notNull().default(true),
  recurrence: text('recurrence'), // optional RRULE for recurring reminders
  /**
   * The wall clock the SERIES was set to, immune to what the phone reports back.
   *
   * `trigger_at_millis` cannot serve as the recurrence anchor, and used to: `recordEvent` adopts the
   * phone's own trigger on ARMED so a later SYNC lists the alarm at its real time, and after a
   * snooze that is the snoozed instant. `advanceRecurrence` then read the same column to compute
   * tomorrow, so one snooze a morning walked a daily 06:30 to 07:33 inside a week and never unwound.
   * One column cannot be both "where this occurrence actually is" and "where the series lives".
   *
   * Nullable, so every row written before this column existed falls back to `trigger_at_millis` at
   * read time and no backfill is needed. Set by `armAlarm` and carried forward explicitly by
   * `advanceRecurrence` — each occurrence is a new row, so it has to be propagated by hand.
   */
  seriesAnchorMillis: integer('series_anchor_millis'),
  // This alarm is a wake-up the wake-check feature follows up on ("are you actually up?"). Landed
  // with the rest of the Phase 0 migration so that feature branch adds no DDL of its own.
  wakeCheck: integer('wake_check', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** Events reported by the app. Unique on (alarm,event,at) because the app retries at-least-once. */
export const alarmEvents = sqliteTable(
  'alarm_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    alarmId: text('alarm_id').notNull(),
    deviceId: text('device_id').notNull(),
    event: text('event').notNull(),
    atMillis: integer('at_millis').notNull(),
    appVersion: text('app_version'),
    receivedAt: integer('received_at').notNull(),
  },
  (t) => ({
    dedupe: uniqueIndex('alarm_events_dedupe').on(t.alarmId, t.event, t.atMillis),
    // signals.ownerRecord runs on EVERY agent turn (agent/prompt.ts renders the record into the
    // volatile prompt tail) and issues four aggregates filtered by device_id + at_millis. The dedupe
    // index leads with alarm_id, so not one of them could use it: four full scans of a table that
    // deliberately keeps 90 days of history, on the hot path of every single message.
    deviceTime: index('alarm_events_device_time').on(t.deviceId, t.atMillis),
  }),
)

/** Per-WhatsApp-user conversation state for the agent. */
export const sessions = sqliteTable('sessions', {
  waUserId: text('wa_user_id').primaryKey(),
  deviceId: text('device_id'),
  messages: text('messages').notNull().default('[]'), // JSON array of OpenAI Responses API input items
  // Consecutive non-transient agent failures. Drives graduated session repair (trim, then clear)
  // instead of nuking a whole conversation on one bad turn.
  failCount: integer('fail_count').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})

/** Durable job queue for the in-process scheduler (ack-watchdog, recurring re-arm, nudges). */
export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  alarmId: text('alarm_id'),
  // Its own column, NOT reused alarmId: the arm_ack handler calls getAlarm(job.alarmId), so a
  // reminder id smuggled in there would be looked up as an alarm.
  reminderId: text('reminder_id'),
  deviceId: text('device_id'),
  runAtMillis: integer('run_at_millis').notNull(),
  payload: text('payload'), // JSON
  attempts: integer('attempts').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

/** Google OAuth refresh token per device (for Calendar/Tasks). */
export const googleAccounts = sqliteTable('google_accounts', {
  deviceId: text('device_id').primaryKey(),
  refreshToken: text('refresh_token').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** WhatsApp message ids already handled — Meta redelivers at-least-once, so we dedupe on wamid. */
export const processedMessages = sqliteTable('processed_messages', {
  wamid: text('wamid').primaryKey(),
  receivedAt: integer('received_at').notNull(),
})

/**
 * Something the owner needs to DO, with a completion state — deliberately NOT an alarm.
 *
 * An alarm is a moment that interrupts and is then over; its states are device-reported
 * (ARMED/RANG/DISMISSED). A reminder is an intent with OPEN/DONE/CANCELLED, driven by chat.
 * Conflating them would mean `DISMISSED` (swiped the ring away) reads as `DONE` (did the thing).
 *
 * A reminder may *rent* an alarm via [alarmId]; the alarm row knows nothing about reminders and is
 * ALWAYS armed with `recurrence: null` — the reminder owns recurrence, so `advanceRecurrence` hits
 * its existing guard and can never silently roll a nagging series forward on a dismissal.
 */
export const reminders = sqliteTable(
  'reminders',
  {
    reminderId: text('reminder_id').primaryKey(),
    deviceId: text('device_id').notNull(),
    waUserId: text('wa_user_id'), // who to nag
    title: text('title').notNull(),
    detail: text('detail'),
    state: text('state').notNull().default('OPEN'), // OPEN | DONE | CANCELLED
    dueAtMillis: integer('due_at_millis'), // null = undated "someday"
    // What dueAtMillis MEANS: deadline (finish BY it) | appointment (it happens AT it) |
    // trigger (say nothing until it). Decides whether rungs sit before the due time, after it, or
    // both — see lib/rungPlan.ts. `trigger` is the only safe default for rows written before this
    // column existed: it has zero lead rungs, so every one of them keeps the ladder it had.
    timingKind: text('timing_kind').notNull().default('trigger'),
    recurrence: text('recurrence'), // same RRULE subset as alarms
    /**
     * The wall clock the SERIES lives at. Same column, same reasoning, as `alarms`.
     *
     * `due_at_millis` is rewritten by every roll-forward, so on a spring-forward morning the
     * occurrence luxon corrected to 02:30 became the anchor for the next one and the series stayed
     * an hour late for good. Unlike the alarms table there is no phone-reported drift to guard
     * against here — nothing outside this server writes a due time — so this exists purely for the
     * DST gap. Nullable; falls back to `due_at_millis` for rows written before it.
     */
    seriesAnchorMillis: integer('series_anchor_millis'),
    nagPolicy: text('nag_policy').notNull().default('gentle'), // off | gentle | persistent | hard | relentless
    // When this schedule was last PLANNED — creation, a recurrence roll-forward, or any edit that
    // moved the due time. Lead rungs are pruned against this rather than against the current clock,
    // so the mapping from nagCount to a rung cannot shift under the ladder between fires. Null
    // falls back to createdAt; it cannot simply BE createdAt, because a recurring reminder writes a
    // new dueAtMillis while createdAt stays weeks old and every lead rung would survive the prune
    // already in the past.
    plannedAtMillis: integer('planned_at_millis'),
    // An explicit per-reminder schedule as JSON ({leadMinutes,chaseMinutes,keepChasingDaily}), or
    // null for "use the table". Only written when the owner actually specified timings, so a later
    // improvement to the tables still reaches every reminder that never asked for anything special.
    nagPlan: text('nag_plan'),
    nextNagAtMillis: integer('next_nag_at_millis'), // null = ladder exhausted / nagging off
    nagCount: integer('nag_count').notNull().default(0),
    lastNaggedAtMillis: integer('last_nagged_at_millis'),
    // Last time the escalation path armed a real ringing alarm for this reminder. Gates a cooldown:
    // the dense ladders fire rungs minutes apart, and without this a shut WhatsApp window turns
    // `escalateWithAlarm` into a phone that rings every five minutes for hours.
    lastEscalatedAtMillis: integer('last_escalated_at_millis'),
    // Times the owner has pushed this back without finishing it. Never reset — it is the record
    // Otto cites when he pushes back, and a deferral the owner later "fixed" is still a deferral.
    deferCount: integer('defer_count').notNull().default(0),
    // Opt-in: ring the phone when WhatsApp is out of window and this is badly overdue. FCM can
    // only ring (CommandParser accepts ARM_ALARM|CANCEL_ALARM|SYNC|PING), so this WILL wake them.
    escalateWithAlarm: integer('escalate_with_alarm', { mode: 'boolean' }).notNull().default(false),
    alarmId: text('alarm_id'),
    completedAtMillis: integer('completed_at_millis'),
    // Set to the SAME instant as completedAtMillis when a reminder was closed because its due time
    // fell inside a calendar commitment and Otto assumed the owner was there. Equality is what the
    // record filters on, so a later genuine completion — which writes a new completedAtMillis and
    // leaves this one behind — stops matching and counts again.
    //
    // It exists because services/signals.ts counts "finished" off completedAtMillis, and an
    // assumption is not an achievement. THE_RECORD tells the model those numbers are the whole of
    // its evidence and to never round them up; this is that rule in code rather than in prose.
    assumedAttendedAtMillis: integer('assumed_attended_at_millis'),
    completedCount: integer('completed_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    open: index('reminders_open').on(t.deviceId, t.state, t.dueAtMillis),
    nag: index('reminders_nag').on(t.state, t.nextNagAtMillis),
    byAlarm: index('reminders_alarm').on(t.alarmId),
  }),
)

/**
 * One durable thing Otto knows about the owner, addressed by a stable slug key.
 *
 * UNIQUE(device_id, key) is load-bearing: `remember_fact` is an upsert, so "actually I cycle now"
 * REPLACES work.commute rather than appending a contradicting second row. Without it memory
 * becomes an accumulating pile of stale contradictions within a month.
 */
export const facts = sqliteTable(
  'facts',
  {
    factId: text('fact_id').primaryKey(),
    deviceId: text('device_id').notNull(),
    key: text('key').notNull(), // "work.commute", "health.gym_days"
    value: text('value').notNull(), // ONE short sentence
    category: text('category').notNull().default('general'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    confidence: text('confidence').notNull().default('stated'), // stated | inferred
    lastUsedAtMillis: integer('last_used_at_millis'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byKey: uniqueIndex('facts_key').on(t.deviceId, t.key) }),
)

/**
 * Something the owner SAID about a thing, held verbatim until they ask for it back.
 *
 * The fourth store Otto can write to, and the boundary matters more than the table does. `facts`
 * holds a standing truth and is upserted by key, so a correction REPLACES it. `reminders.detail`
 * holds the one line worth repeating while chasing, and every nudge reads it. A note is neither: it
 * is dated, it is appended, nothing ever rewrites it, and — the load-bearing half — NOTHING reads
 * it proactively. Not a nudge, not a brief, not the cached prompt. It exists to be asked for.
 *
 * That last property is also why notes are exempt from the sweeps in services/gc.ts. They cost
 * nothing until `read_notes` is called, and every row here is something the owner actually said —
 * which `facts` already establishes Otto never silently forgets.
 *
 * [subjectKind, subjectId] are both set or both null; null means a standalone jotting. The pair is
 * polymorphic rather than three foreign keys because a note about a meeting has to hang off a
 * Google event id, which no constraint in this database could ever enforce anyway.
 */
export const notes = sqliteTable(
  'notes',
  {
    noteId: text('note_id').primaryKey(),
    deviceId: text('device_id').notNull(),
    subjectKind: text('subject_kind'), // 'reminder' | 'alarm' | 'event' | null
    subjectId: text('subject_id'), // reminderId | alarmId | eventKeyOf(event) | null
    // The subject's title AS IT READ WHEN THE NOTE WAS WRITTEN, and deliberately never refreshed.
    // Nothing cascades into this table and nothing can: alarms get swept, calendar events get
    // deleted, reminders get cancelled. Without the label a search hit reads `note on rem_01H8QK…`
    // and is worthless — with it the note outlives its subject and still says what it was about.
    subjectLabel: text('subject_label'),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    // Leads with device_id so the same index serves both "this subject's notes" and the flat
    // newest-first scan that an unfiltered search does.
    bySubject: index('notes_subject').on(t.deviceId, t.subjectKind, t.subjectId, t.createdAt),
    byDevice: index('notes_device_time').on(t.deviceId, t.createdAt),
  }),
)

/**
 * A place the owner has a name for. "the gym", "mum's", "the office".
 *
 * A table rather than more `facts` rows, and the reason is the coordinates. A fact is ONE short
 * sentence of prose the model reads; a place is a structured tuple — alias, label, formatted
 * address, Google place id, lat/lng — that server code joins on. Stuffing that into `facts.value`
 * would mean parsing prose on the hot path of every journey, which is exactly the failure mode
 * `parseBufferMinutes` in services/travel.ts exists to contain and is not worth repeating.
 *
 * `home.address` and `work.address` stay FACTS and are not mirrored here. They are read by name by
 * `resolveOrigin` (services/leaveBy.ts), they predate this table, and two rows that can disagree
 * about where the owner lives is a worse failure than one lookup that has to check two places.
 * `resolvePlace` consults the facts for those two aliases; nothing writes them here.
 *
 * UNIQUE(device_id, alias) for the same reason `facts_key` is unique: saving "the gym" again after
 * they change gym must CORRECT the row, not leave two of them for a coin flip to choose between.
 */
export const savedPlaces = sqliteTable(
  'saved_places',
  {
    placeRowId: text('place_row_id').primaryKey(),
    deviceId: text('device_id').notNull(),
    // Normalised for lookup — lowercased, "the " stripped. `label` keeps what they actually said.
    alias: text('alias').notNull(),
    label: text('label').notNull(),
    address: text('address').notNull(),
    // Google's stable id. Preferred over `address` when routing: the address was geocoded once,
    // already, and handing Routes free text again is a second chance to pick the wrong branch.
    googlePlaceId: text('google_place_id'),
    lat: integer('lat'), // stored ×1e6 as an integer — SQLite reals compare badly and we only
    lng: integer('lng'), // ever need ~10cm precision for a distance lower bound
    useCount: integer('use_count').notNull().default(0),
    lastUsedAtMillis: integer('last_used_at_millis'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byAlias: uniqueIndex('saved_places_alias').on(t.deviceId, t.alias) }),
)

/**
 * Billed Google Routes requests, per device, per UTC day. A spend guard, not analytics.
 *
 * In a table rather than a Map, and that is a deliberate reversal. The counter used to live in
 * memory, justified by "a restart clearing it is the correct failure mode — the runaway loop it
 * exists to stop does not survive the restart either". That reasoning holds only while the spender
 * is an in-process chain. It stopped holding when journeys arrived: `jobs` is a table,
 * `rescheduleJob` persists, and `seedSchedulerJobs()` re-seeds on boot, so a container crash-looping
 * every ninety seconds would reset an in-memory ceiling every ninety seconds while the durable queue
 * kept handing out billable work — and the first sign would be the bill.
 *
 * The day key is UTC, not the device's: this bounds SPEND, and the bill is not keyed on anyone's
 * timezone. Old rows are swept by services/gc.ts along with everything else that grows.
 */
export const travelCalls = sqliteTable(
  'travel_calls',
  {
    deviceId: text('device_id').notNull(),
    dayKey: text('day_key').notNull(), // "2026-08-09", UTC
    count: integer('count').notNull().default(0),
  },
  (t) => ({ byDay: uniqueIndex('travel_calls_day').on(t.deviceId, t.dayKey) }),
)

/**
 * The last place the phone said it was, and why it was asked. ONE ROW PER DEVICE, upserted.
 *
 * Not a log, and the primary key is the whole argument. An append-only table would accumulate a
 * movement history nobody asked for and nothing reads — the exact thing this feature promises not to
 * build. One row can answer "where are they now" and "when did Otto last look, and what for", which
 * is everything either side needs.
 *
 * `gc` NULLS the coordinates after LOCATION_TTL_MS while keeping the row, so the accountability half
 * outlives the private half. A fix has no value past the journey that requested it.
 *
 * `fixAtMillis` is when the PHONE took the fix, and staleness is judged on it rather than on
 * `receivedAtMillis`. Judging on receipt would accept a fix delayed by a retry chain as current,
 * which is precisely the failure the app avoids by never replaying one.
 */
export const deviceLocations = sqliteTable('device_locations', {
  deviceId: text('device_id').primaryKey(),
  requestId: text('request_id'),
  /** OK | PERMISSION_DENIED | BACKGROUND_DENIED | LOCATION_DISABLED | TIMEOUT | EXPIRED | … */
  status: text('status').notNull(),
  lat: integer('lat'), // ×1e6, like saved_places — SQLite reals compare badly across platforms
  lng: integer('lng'),
  accuracyMeters: integer('accuracy_meters'),
  isMock: integer('is_mock', { mode: 'boolean' }).notNull().default(false),
  fixAtMillis: integer('fix_at_millis'),
  receivedAtMillis: integer('received_at_millis').notNull(),
  /** What Otto said it was for, kept so "when did you last check on me?" is answerable in words. */
  reason: text('reason'),
})

/**
 * Queued outbound WhatsApp messages. Everything Otto says that is NOT a direct reply goes here.
 *
 * Free-form sends are only legal inside Meta's 24h window (an approved template is optional config
 * and can only re-open it, never carry arbitrary text). A row stays PENDING while the window is shut
 * and is flushed on next contact (collapsed into a digest if stale), rather than being dropped or
 * rejected by Meta.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    waUserId: text('wa_user_id').notNull(),
    deviceId: text('device_id'),
    // Free-form TEXT, so a new kind needs no DDL — the authority on the set is OutboxKind in
    // services/outbox.ts: nudge | digest | missed_alarm | system_warning | brief | weekly | wake_check
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    reminderId: text('reminder_id'),
    dedupeKey: text('dedupe_key'), // e.g. "nag:rem_01H...:3"
    state: text('state').notNull().default('PENDING'), // PENDING|SENT|FAILED|SUPERSEDED|EXPIRED
    expiresAtMillis: integer('expires_at_millis'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    sentAtMillis: integer('sent_at_millis'),
    // Which transport actually carried it: 'whatsapp' | 'push' | null (never delivered). The outbox
    // is the ledger for both, so without this it could say what Otto said and when but not where it
    // landed — and "did that reach their phone or their chat?" is exactly the question a two-channel
    // system has to be able to answer.
    deliveredVia: text('delivered_via'),
  },
  (t) => ({ pending: index('outbox_pending').on(t.waUserId, t.state, t.createdAt) }),
)
