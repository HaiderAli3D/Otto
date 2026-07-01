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

    CREATE TABLE IF NOT EXISTS google_accounts (
      device_id TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}
