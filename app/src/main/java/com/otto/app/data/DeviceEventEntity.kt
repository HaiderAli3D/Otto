package com.otto.app.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Append-only outbox for everything the device reports that is NOT an alarm state change.
 *
 * A sibling of `alarm_events` rather than a generalisation of it, and the deciding argument is
 * failure isolation. `ReportWorker` drains strictly by id and stops at the first failure, so one
 * table would mean a server 500 on an alarm report blocking a lockscreen "Done" from ever arriving,
 * and vice versa. Two tables are two independently-ordered queues, which makes that guarantee
 * stronger rather than weaker. It also keeps every existing alarm test compiling untouched, and
 * puts no new branch inside the most safety-critical loop in the app.
 */
@Entity(
    tableName = "device_events",
    indices = [Index(value = ["dedupeKey"], unique = true)],
)
data class DeviceEventEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** `NUDGE` or `PUSH` — which vocabulary [event] is drawn from. */
    val kind: String,
    /** What the event is about: a nudge id, or the rejected push's `type`. */
    val refId: String,
    val event: String,
    val atMillis: Long,
    val detail: String? = null,
    /** Only meaningful for a snooze: when the owner asked to be shown it again. */
    val untilMillis: Long? = null,
    /**
     * Structural rate limit, enforced by the unique index rather than by a timer.
     *
     * Push rejections bucket theirs by hour, so a server sending a malformed type in a loop
     * produces at most one row an hour however many arrive. A counter or a cooldown would need
     * state of its own and would reset on every process death; an INSERT that conflicts costs
     * nothing and cannot drift.
     */
    val dedupeKey: String,
)
