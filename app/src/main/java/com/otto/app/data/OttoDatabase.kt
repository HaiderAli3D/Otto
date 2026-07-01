package com.otto.app.data

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

/**
 * The on-device alarm store. Schema is exported to `app/schemas` (see the room.schemaLocation
 * ksp arg) so migrations can be tested; v2 adds the [AlarmEventEntity] outbox and the alarms
 * `requestCode` column (fixes #2 and #4) via [MIGRATION_1_2].
 */
@Database(entities = [AlarmEntity::class, AlarmEventEntity::class], version = 2, exportSchema = true)
@TypeConverters(AlarmConverters::class)
abstract class OttoDatabase : RoomDatabase() {
    abstract fun alarmDao(): AlarmDao

    companion object {
        const val NAME = "otto.db"
    }
}
