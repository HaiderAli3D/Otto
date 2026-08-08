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

/** Per-WhatsApp-user conversation state for the Claude agent. */
export const sessions = sqliteTable('sessions', {
  waUserId: text('wa_user_id').primaryKey(),
  deviceId: text('device_id'),
  messages: text('messages').notNull().default('[]'), // JSON array of Anthropic message params
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
  },
  (t) => ({ pending: index('outbox_pending').on(t.waUserId, t.state, t.createdAt) }),
)
