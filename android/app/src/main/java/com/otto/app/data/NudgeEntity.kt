package com.otto.app.data

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * A nudge the server pushed, mirrored locally.
 *
 * The invariant, stated once so it does not drift: **the phone is authoritative for what is on
 * screen right now; the server stays authoritative for what is open.** This table is not a mirror
 * of the owner's reminders and must never become one — there is no sync endpoint for it and no
 * reconciler, because the push already carries everything a notification needs.
 *
 * It exists at all because a notification is not durable enough to be the only record. An action
 * tapped on the lockscreen has to survive the moments before the network call and the process death
 * that can follow it; a reboot wipes every posted notification, and without a row Otto would go
 * silent exactly when it should be pushiest; the "N things open" summary needs a count that
 * outlives the process; and a local snooze is impossible statelessly. It is also what keeps
 * CLAUDE.md's "Room is the source of truth, everything else is rebuildable" true of the new surface
 * as well as the old one.
 *
 * Drift against the server is corrected by three cheap mechanisms and no fourth: a `CANCEL_NUDGE`
 * push when the reminder is completed elsewhere, [expiresAtMillis], and a sweep of terminal rows on
 * app open.
 */
@Entity(tableName = "nudges")
data class NudgeEntity(
    /** The server's own reminder id (`rem_…`). Same id twice REPLACES rather than stacking. */
    @PrimaryKey val nudgeId: String,
    val title: String,
    val body: String,
    /** Stored as the raw wire token rather than the parsed level, so the audit trail is honest. */
    val level: String,
    val actionsCsv: String,
    val snoozeMinutes: Int,
    val state: NudgeState,
    val postedAtMillis: Long,
    /** Normally equal to [postedAtMillis]; moves into the future only on a local snooze. */
    val showAtMillis: Long,
    val expiresAtMillis: Long?,
    val ongoing: Boolean,
    /**
     * Stable per nudge id, assigned MAX+1 inside a transaction and preserved across replaces —
     * exactly like `alarms.requestCode`. It is both the notification id and the base for this
     * nudge's PendingIntent request codes, so a replace that renumbered it would orphan the buttons
     * on the notification already showing.
     */
    val notificationId: Int,
    val createdAtMillis: Long,
    val updatedAtMillis: Long,
)
