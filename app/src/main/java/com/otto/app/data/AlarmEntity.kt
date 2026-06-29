package com.otto.app.data

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
)
