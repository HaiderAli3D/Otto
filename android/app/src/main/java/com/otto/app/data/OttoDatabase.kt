package com.otto.app.data

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

/**
 * The on-device store. Schema is exported to `app/schemas` (see the room.schemaLocation ksp arg)
 * so migrations can be tested.
 *
 * v2 adds the [AlarmEventEntity] outbox and the alarms `requestCode` column (fixes #2 and #4) via
 * [MIGRATION_1_2]. v3 adds [NudgeEntity] and [DeviceEventEntity] via [MIGRATION_2_3], purely
 * additively — no existing table is touched, so a mistake there cannot regress the alarm path
 * except by failing to open at all.
 *
 * There is deliberately no `fallbackToDestructiveMigration`, which makes a wrong migration the one
 * way this app can brick itself: a mismatched identity hash throws at first open, and on a phone
 * whose job is ringing alarms that means the alarms stop. Never hand-write the DDL — bump the
 * version, build once so KSP exports the new schema JSON, then copy its `createSql` verbatim.
 */
@Database(
    entities = [AlarmEntity::class, AlarmEventEntity::class, NudgeEntity::class, DeviceEventEntity::class],
    version = 3,
    exportSchema = true,
)
@TypeConverters(AlarmConverters::class)
abstract class OttoDatabase : RoomDatabase() {
    abstract fun alarmDao(): AlarmDao

    abstract fun nudgeDao(): NudgeDao

    companion object {
        const val NAME = "otto.db"
    }
}
