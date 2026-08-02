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
  createdAt: integer('created_at').notNull(),
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
  (t) => ({ dedupe: uniqueIndex('alarm_events_dedupe').on(t.alarmId, t.event, t.atMillis) }),
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
    recurrence: text('recurrence'), // same RRULE subset as alarms
    nagPolicy: text('nag_policy').notNull().default('gentle'), // off | gentle | persistent
    nextNagAtMillis: integer('next_nag_at_millis'), // null = ladder exhausted / nagging off
    nagCount: integer('nag_count').notNull().default(0),
    lastNaggedAtMillis: integer('last_nagged_at_millis'),
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
 * The owner chose no message templates, so free-form sends are only legal inside the 24h window.
 * A row stays PENDING while the window is shut and is flushed on next contact (collapsed into a
 * digest if stale), rather than being dropped or rejected by Meta.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    waUserId: text('wa_user_id').notNull(),
    deviceId: text('device_id'),
    kind: text('kind').notNull(), // nudge | digest | missed_alarm | system_warning
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
