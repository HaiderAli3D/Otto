import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config.js'
import * as schema from './schema.js'

mkdirSync(dirname(config.databasePath) || '.', { recursive: true })

const sqlite = new Database(config.databasePath)
sqlite.pragma('journal_mode = WAL')

export const db = drizzle(sqlite, { schema })

/**
 * Turnkey auto-migration: create every table on boot if absent. The CREATE statements mirror
 * `schema.ts` exactly. No separate migration step for the owner to run.
 */
export function ensureSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      fcm_token TEXT,
      app_version TEXT,
      hmac_secret TEXT NOT NULL,
      whatsapp_number TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      auth_latched INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alarms (
      alarm_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      trigger_at_millis INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT 'Alarm',
      state TEXT NOT NULL DEFAULT 'ARMED',
      allow_while_idle INTEGER NOT NULL DEFAULT 1,
      recurrence TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alarm_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alarm_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      event TEXT NOT NULL,
      at_millis INTEGER NOT NULL,
      app_version TEXT,
      received_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS alarm_events_dedupe
      ON alarm_events (alarm_id, event, at_millis);
    -- Covers signals.ownerRecord, which runs on EVERY agent turn and aggregates by device + time.
    -- The dedupe index leads with alarm_id and is useless to it; without this those were full scans.
    CREATE INDEX IF NOT EXISTS alarm_events_device_time ON alarm_events (device_id, at_millis);

    CREATE TABLE IF NOT EXISTS sessions (
      wa_user_id TEXT PRIMARY KEY,
      device_id TEXT,
      messages TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      alarm_id TEXT,
      device_id TEXT,
      run_at_millis INTEGER NOT NULL,
      payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Owner-authored settings. Deliberately MINIMAL here: every other column arrives through an
    -- ensureColumn line below, so a database created by an old build and one created today converge
    -- on exactly the same shape. CREATE TABLE IF NOT EXISTS never alters an existing table, so a
    -- column listed only here would be missing from every database that already exists.
    CREATE TABLE IF NOT EXISTS device_settings (
      device_id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS google_accounts (
      device_id TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      wamid TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminders (
      reminder_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      wa_user_id TEXT,
      title TEXT NOT NULL,
      detail TEXT,
      state TEXT NOT NULL DEFAULT 'OPEN',
      due_at_millis INTEGER,
      recurrence TEXT,
      nag_policy TEXT NOT NULL DEFAULT 'gentle',
      next_nag_at_millis INTEGER,
      nag_count INTEGER NOT NULL DEFAULT 0,
      last_nagged_at_millis INTEGER,
      defer_count INTEGER NOT NULL DEFAULT 0,
      escalate_with_alarm INTEGER NOT NULL DEFAULT 0,
      alarm_id TEXT,
      completed_at_millis INTEGER,
      completed_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminders_open ON reminders (device_id, state, due_at_millis);
    CREATE INDEX IF NOT EXISTS reminders_nag ON reminders (state, next_nag_at_millis);
    CREATE INDEX IF NOT EXISTS reminders_alarm ON reminders (alarm_id);

    CREATE TABLE IF NOT EXISTS facts (
      fact_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      pinned INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'stated',
      last_used_at_millis INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS facts_key ON facts (device_id, key);

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_user_id TEXT NOT NULL,
      device_id TEXT,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      reminder_id TEXT,
      dedupe_key TEXT,
      state TEXT NOT NULL DEFAULT 'PENDING',
      expires_at_millis INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      sent_at_millis INTEGER
    );
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (wa_user_id, state, created_at);
    -- Partial unique index: at most ONE pending message per dedupe key. Primary double-nudge
    -- guard, alongside the guarded UPDATE in services/nagging.ts.
    CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe ON outbox (dedupe_key) WHERE state = 'PENDING';
  `)

  // Additive columns for databases created before the column existed (CREATE IF NOT EXISTS
  // never alters an existing table). Idempotent: guarded by PRAGMA table_info.
  ensureColumn('devices', 'auth_latched', 'auth_latched INTEGER NOT NULL DEFAULT 0')
  ensureColumn('devices', 'last_inbound_at', 'last_inbound_at INTEGER')
  ensureColumn('devices', 'last_digest_at', 'last_digest_at INTEGER')
  ensureColumn('devices', 'last_template_at', 'last_template_at INTEGER')
  ensureColumn('sessions', 'fail_count', 'fail_count INTEGER NOT NULL DEFAULT 0')
  ensureColumn('jobs', 'reminder_id', 'reminder_id TEXT')
  ensureColumn('reminders', 'defer_count', 'defer_count INTEGER NOT NULL DEFAULT 0')
  ensureColumn('alarms', 'wake_check', 'wake_check INTEGER NOT NULL DEFAULT 0')

  // Timing semantics and per-reminder schedules. `trigger` is the only safe backfill for existing
  // rows — it has no lead rungs, so every reminder written before this column keeps its ladder.
  ensureColumn('reminders', 'timing_kind', "timing_kind TEXT NOT NULL DEFAULT 'trigger'")
  ensureColumn('reminders', 'planned_at_millis', 'planned_at_millis INTEGER')
  ensureColumn('reminders', 'nag_plan', 'nag_plan TEXT')
  ensureColumn('reminders', 'last_escalated_at_millis', 'last_escalated_at_millis INTEGER')

  // device_settings: the entire column set, matching `deviceSettings` in schema.ts. SQLite accepts
  // ADD COLUMN ... NOT NULL only with a constant DEFAULT, which every non-null column here supplies.
  ensureColumn('device_settings', 'brief_enabled', 'brief_enabled INTEGER NOT NULL DEFAULT 1')
  ensureColumn('device_settings', 'brief_hour', 'brief_hour INTEGER NOT NULL DEFAULT 7')
  ensureColumn('device_settings', 'brief_minute', 'brief_minute INTEGER NOT NULL DEFAULT 0')
  ensureColumn('device_settings', 'evening_brief_enabled', 'evening_brief_enabled INTEGER NOT NULL DEFAULT 0')
  ensureColumn('device_settings', 'evening_brief_hour', 'evening_brief_hour INTEGER NOT NULL DEFAULT 21')
  ensureColumn('device_settings', 'evening_brief_minute', 'evening_brief_minute INTEGER NOT NULL DEFAULT 0')
  ensureColumn('device_settings', 'last_brief_at', 'last_brief_at INTEGER')
  ensureColumn('device_settings', 'last_evening_brief_at', 'last_evening_brief_at INTEGER')
  ensureColumn('device_settings', 'quiet_hours', 'quiet_hours TEXT')
  ensureColumn('device_settings', 'weekly_review_at', 'weekly_review_at TEXT')
  ensureColumn('device_settings', 'last_weekly_review_at', 'last_weekly_review_at INTEGER')
  ensureColumn('device_settings', 'auto_wake_alarm', 'auto_wake_alarm INTEGER NOT NULL DEFAULT 0')
  ensureColumn('device_settings', 'auto_leave_by_alarm', 'auto_leave_by_alarm INTEGER NOT NULL DEFAULT 0')
  ensureColumn('device_settings', 'default_travel_minutes', 'default_travel_minutes INTEGER NOT NULL DEFAULT 30')
  ensureColumn('device_settings', 'get_ready_minutes', 'get_ready_minutes INTEGER NOT NULL DEFAULT 45')
  ensureColumn('device_settings', 'bed_window', 'bed_window TEXT')
  ensureColumn('device_settings', 'wake_window', 'wake_window TEXT')
  ensureColumn('device_settings', 'daily_message_budget', 'daily_message_budget INTEGER NOT NULL DEFAULT 60')

  // services/budget.ts counts today's proactive sends per device on every rung fire. outbox_pending
  // leads with wa_user_id and filters on state='PENDING', so it cannot serve a device_id + created_at
  // scan. Indexes are safe to add here unconditionally — unlike columns, CREATE INDEX IF NOT EXISTS
  // is genuinely idempotent.
  sqlite.exec(`CREATE INDEX IF NOT EXISTS outbox_device_day ON outbox (device_id, created_at);`)
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}
