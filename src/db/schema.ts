import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
  updatedAt: integer('updated_at').notNull(),
})

/** Durable job queue for the in-process scheduler (ack-watchdog, recurring re-arm, nudges). */
export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  alarmId: text('alarm_id'),
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
