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

/**
 * v2 → v3: the nudge tier.
 *
 * Purely additive — no existing table is read, altered or dropped — so a mistake here cannot
 * corrupt an alarm. It can still stop the app dead, which is the only real risk: there is no
 * `fallbackToDestructiveMigration`, so a statement that does not reproduce Room's generated schema
 * byte for byte fails the identity-hash check at open time, and on this app that means the owner's
 * alarms stop working.
 *
 * The statements below are copied verbatim from the `createSql` fields of
 * `app/schemas/com.otto.app.data.OttoDatabase/3.json`, which KSP generates from the entities. Never
 * hand-write or "tidy" them: the hash covers column order, affinities, defaults and index names,
 * and a difference invisible to a reader is not invisible to Room.
 */
val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `nudges` " +
                "(`nudgeId` TEXT NOT NULL, `title` TEXT NOT NULL, `body` TEXT NOT NULL, " +
                "`level` TEXT NOT NULL, `actionsCsv` TEXT NOT NULL, `snoozeMinutes` INTEGER NOT NULL, " +
                "`state` TEXT NOT NULL, `postedAtMillis` INTEGER NOT NULL, " +
                "`showAtMillis` INTEGER NOT NULL, `expiresAtMillis` INTEGER, " +
                "`ongoing` INTEGER NOT NULL, `notificationId` INTEGER NOT NULL, " +
                "`createdAtMillis` INTEGER NOT NULL, `updatedAtMillis` INTEGER NOT NULL, " +
                "PRIMARY KEY(`nudgeId`))",
        )
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `device_events` " +
                "(`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `kind` TEXT NOT NULL, " +
                "`refId` TEXT NOT NULL, `event` TEXT NOT NULL, `atMillis` INTEGER NOT NULL, " +
                "`detail` TEXT, `untilMillis` INTEGER, `dedupeKey` TEXT NOT NULL)",
        )
        // The unique index IS the rate limiter for push-rejection reporting, not merely an
        // optimisation — see DeviceEventEntity.dedupeKey.
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_device_events_dedupeKey` ON `device_events` (`dedupeKey`)")
    }
}
