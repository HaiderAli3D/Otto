package com.otto.app.data

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * v1 → v2 (fixes #2 and #4). The statements must reproduce Room's generated schema exactly
 * (see `app/schemas/com.otto.app.data.OttoDatabase/2.json`) or the identity-hash check fails at
 * open time. This is purely additive: no existing alarm data is dropped or transformed beyond a
 * one-time backfill of the new column.
 */
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        // fix #4 — stable, collision-free request code. Backfill each existing alarm with its
        // unique rowid so no two collide; new alarms get MAX+1 via AlarmDao.nextRequestCode().
        db.execSQL("ALTER TABLE `alarms` ADD COLUMN `requestCode` INTEGER NOT NULL DEFAULT 0")
        db.execSQL("UPDATE `alarms` SET `requestCode` = `rowid`")
        // fix #2 — append-only event outbox (CREATE must match Room's generated statement).
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `alarm_events` " +
                "(`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `alarmId` TEXT NOT NULL, " +
                "`event` TEXT NOT NULL, `atMillis` INTEGER NOT NULL)",
        )
    }
}
