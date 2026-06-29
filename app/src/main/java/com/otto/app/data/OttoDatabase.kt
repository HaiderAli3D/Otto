package com.otto.app.data

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

/**
 * The on-device alarm store. exportSchema is off for M1; schema export + migration tests
 * come with later milestones.
 */
@Database(entities = [AlarmEntity::class], version = 1, exportSchema = false)
@TypeConverters(AlarmConverters::class)
abstract class OttoDatabase : RoomDatabase() {
    abstract fun alarmDao(): AlarmDao

    companion object {
        const val NAME = "otto.db"
    }
}
