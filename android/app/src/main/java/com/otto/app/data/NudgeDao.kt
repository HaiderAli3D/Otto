package com.otto.app.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface NudgeDao {

    @Upsert
    suspend fun upsert(nudge: NudgeEntity)

    @Query("SELECT * FROM nudges WHERE nudgeId = :nudgeId")
    suspend fun getById(nudgeId: String): NudgeEntity?

    /** Everything not yet finished with — what boot recovery walks and the summary counts. */
    @Query("SELECT * FROM nudges WHERE state IN ('ACTIVE', 'SNOOZED', 'DEFERRED') ORDER BY postedAtMillis DESC")
    suspend fun getLive(): List<NudgeEntity>

    /** The same set, observed by the in-app list and the summary notification. */
    @Query("SELECT * FROM nudges WHERE state IN ('ACTIVE', 'SNOOZED', 'DEFERRED') ORDER BY postedAtMillis DESC")
    fun observeLive(): Flow<List<NudgeEntity>>

    /** Only what is on screen right now — the summary's headline count. */
    @Query("SELECT * FROM nudges WHERE state = 'ACTIVE' ORDER BY postedAtMillis DESC")
    suspend fun getActive(): List<NudgeEntity>

    /**
     * Move a nudge to a new state only if it is not already finished with.
     *
     * The AF1 analogue, and the reason it is a SQL-literal guard rather than a read-then-write: a
     * "Done" tapped on a notification the server has meanwhile cancelled must not resurrect it, and
     * the lockscreen is exactly where a stale notification lives longest. The literals match
     * [AlarmConverters]' enum-name storage. Returns rows changed.
     */
    @Query(
        "UPDATE nudges SET state = :state, updatedAtMillis = :updatedAtMillis " +
            "WHERE nudgeId = :nudgeId AND state NOT IN ('RESOLVED', 'CANCELLED', 'EXPIRED')",
    )
    suspend fun updateStateIfLive(nudgeId: String, state: NudgeState, updatedAtMillis: Long): Int

    @Query(
        "UPDATE nudges SET state = 'SNOOZED', showAtMillis = :showAtMillis, updatedAtMillis = :updatedAtMillis " +
            "WHERE nudgeId = :nudgeId AND state NOT IN ('RESOLVED', 'CANCELLED', 'EXPIRED')",
    )
    suspend fun snoozeIfLive(nudgeId: String, showAtMillis: Long, updatedAtMillis: Long): Int

    /** Housekeeping on app open: terminal rows older than the cutoff are of no further use. */
    @Query("DELETE FROM nudges WHERE state IN ('RESOLVED', 'CANCELLED', 'EXPIRED') AND updatedAtMillis < :cutoffMillis")
    suspend fun deleteTerminalBefore(cutoffMillis: Long)

    /** Next stable, collision-free notification id — the direct twin of `AlarmDao.nextRequestCode`. */
    @Query("SELECT COALESCE(MAX(notificationId), 0) + 1 FROM nudges")
    suspend fun nextNotificationId(): Int

    /**
     * Show a nudge, preserving the identity of one already on screen.
     *
     * [NudgeEntity.notificationId] must survive a replace or the buttons on the notification the
     * owner is already looking at would point at a different row. `@Transaction` makes the
     * read-compute-write atomic for the same reason `upsertPreservingIdentity` does: two pushes
     * arriving together would otherwise both read the same MAX and collide.
     */
    @Transaction
    suspend fun showPreservingIdentity(entity: NudgeEntity, event: DeviceEventEntity): NudgeEntity {
        val existing = getById(entity.nudgeId)
        val resolved = entity.copy(
            notificationId = existing?.notificationId ?: nextNotificationId(),
            createdAtMillis = existing?.createdAtMillis ?: entity.createdAtMillis,
        )
        upsert(resolved)
        insertEvent(event)
        return resolved
    }

    /**
     * Apply a state change and append its outbox event together.
     *
     * One transaction for the same reason the alarm path uses one (AF6): a process kill between the
     * two statements would lose the event and the server would never learn the owner acted. Returns
     * rows changed — 0 means the nudge was already terminal and nothing was written, including no
     * event.
     */
    @Transaction
    suspend fun updateStateWithEvent(
        nudgeId: String,
        state: NudgeState,
        updatedAtMillis: Long,
        event: DeviceEventEntity,
    ): Int {
        val changed = updateStateIfLive(nudgeId, state, updatedAtMillis)
        if (changed > 0) insertEvent(event)
        return changed
    }

    @Transaction
    suspend fun snoozeWithEvent(
        nudgeId: String,
        showAtMillis: Long,
        updatedAtMillis: Long,
        event: DeviceEventEntity,
    ): Int {
        val changed = snoozeIfLive(nudgeId, showAtMillis, updatedAtMillis)
        if (changed > 0) insertEvent(event)
        return changed
    }

    // --- Device event outbox: append-only, drained then deleted by ReportWorker ---

    /**
     * IGNORE rather than ABORT: the unique index on `dedupeKey` IS the rate limiter for push
     * rejections, so a conflict is the mechanism working, not an error to propagate.
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertEvent(event: DeviceEventEntity)

    @Query("SELECT * FROM device_events ORDER BY id ASC")
    suspend fun getPendingEvents(): List<DeviceEventEntity>

    @Query("DELETE FROM device_events WHERE id = :id")
    suspend fun deleteEvent(id: Long)
}
