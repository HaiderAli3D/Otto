package com.otto.app.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * The on-device record of an alarm — the source of truth (spec.md §6.1).
 *
 * All times are absolute epoch milliseconds (UTC); the app is timezone-agnostic and fires
 * at the absolute instant it was given.
 */
@Entity(tableName = "alarms")
data class AlarmEntity(
    @PrimaryKey val alarmId: String,
    val triggerAtMillis: Long,
    val label: String,
    val state: AlarmState,
    val allowWhileIdle: Boolean = true,
    val snoozeCount: Int = 0,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
    val reportedToServer: Boolean = false,
    /**
     * Stable, collision-free integer for this alarm's PendingIntent request code and ringing
     * notification id (fix #4). Assigned once from a monotonic counter and preserved across
     * re-arms, replacing the old `alarmId.hashCode()` which could collide. The SQL default 0 is
     * only for the v1→v2 migration backfill; live rows always get a real value from
     * `AlarmDao.nextRequestCode()`.
     */
    @ColumnInfo(defaultValue = "0") val requestCode: Int = 0,
)
