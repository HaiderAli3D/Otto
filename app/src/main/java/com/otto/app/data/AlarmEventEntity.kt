package com.otto.app.data

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * An append-only outbox row: one alarm lifecycle event awaiting delivery to the server
 * (spec.md §7.4). Introduced by fix #2 so every transition — including the SNOOZED that a
 * current-state model would overwrite before it could be reported — reaches the server exactly
 * once (the server dedupes on `(alarmId, event, atMillis)`).
 *
 * Rows are inserted by [AlarmRepository] on each state change and deleted by `ReportWorker`
 * once acknowledged, so the table stays bounded and needs no `reported` flag.
 */
@Entity(tableName = "alarm_events")
data class AlarmEventEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val alarmId: String,
    /** The [AlarmState] name for the transition (ARMED, RANG, DISMISSED, SNOOZED, CANCELLED, MISSED). */
    val event: String,
    val atMillis: Long,
)
