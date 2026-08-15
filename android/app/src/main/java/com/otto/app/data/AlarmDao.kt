package com.otto.app.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface AlarmDao {

    /** Insert or replace, keyed by alarmId — the basis for idempotent arming. */
    @Upsert
    suspend fun upsert(alarm: AlarmEntity)

    @Query("SELECT * FROM alarms WHERE alarmId = :alarmId")
    suspend fun getById(alarmId: String): AlarmEntity?

    /** Newest-first, observed by the control-panel UI. */
    @Query("SELECT * FROM alarms ORDER BY triggerAtMillis DESC")
    fun observeAll(): Flow<List<AlarmEntity>>

    @Query("SELECT * FROM alarms WHERE state = :state")
    suspend fun getByState(state: AlarmState): List<AlarmEntity>

    /** The soonest still-future alarm in the given state (for the quick-settings tile). */
    @Query("SELECT * FROM alarms WHERE state = :state AND triggerAtMillis > :nowMillis ORDER BY triggerAtMillis ASC LIMIT 1")
    suspend fun getNextInState(state: AlarmState, nowMillis: Long): AlarmEntity?

    @Query("UPDATE alarms SET state = :state, updatedAtMillis = :updatedAtMillis, reportedToServer = 0 WHERE alarmId = :alarmId")
    suspend fun updateState(alarmId: String, state: AlarmState, updatedAtMillis: Long): Int

    /** Every alarm regardless of state — the full local picture SYNC reconciles against (AF2). */
    @Query("SELECT * FROM alarms")
    suspend fun getAll(): List<AlarmEntity>

    /**
     * Flip an alarm to DISMISSED only while it is still RANG (AF1). Guards against a stale ring
     * screen dismissing an alarm the agent has meanwhile re-armed to the future or cancelled.
     * The literal 'RANG'/'DISMISSED' match [AlarmConverters]' enum-name storage. Returns rows changed.
     */
    @Query("UPDATE alarms SET state = 'DISMISSED', updatedAtMillis = :updatedAtMillis, reportedToServer = 0 WHERE alarmId = :alarmId AND state = 'RANG'")
    suspend fun dismissIfRinging(alarmId: String, updatedAtMillis: Long): Int

    @Query("DELETE FROM alarms WHERE alarmId = :alarmId")
    suspend fun deleteById(alarmId: String)

    /** Next stable, collision-free PendingIntent request code (fix #4). */
    @Query("SELECT COALESCE(MAX(requestCode), 0) + 1 FROM alarms")
    suspend fun nextRequestCode(): Int

    /**
     * Upsert [entity], preserving the identity fields of an existing row (requestCode,
     * createdAtMillis, snoozeCount) and assigning the next requestCode to a new one. Returns the
     * row as written. @Transaction makes the read-compute-write atomic: without it, two
     * concurrent first-time arms (e.g. an FCM ARM_ALARM racing the test button) can both read the
     * same MAX(requestCode) and collide — recreating the shared-PendingIntent failure fix #4
     * removed, where arming one alarm silently replaces the other's OS registration.
     */
    @Transaction
    suspend fun upsertPreservingIdentity(entity: AlarmEntity): AlarmEntity {
        val existing = getById(entity.alarmId)
        val resolved = entity.copy(
            snoozeCount = existing?.snoozeCount ?: entity.snoozeCount,
            createdAtMillis = existing?.createdAtMillis ?: entity.createdAtMillis,
            requestCode = existing?.requestCode ?: nextRequestCode(),
        )
        upsert(resolved)
        return resolved
    }

    // --- Event outbox: append-only, drained then deleted by ReportWorker (fix #2) ---

    @Insert
    suspend fun insertEvent(event: AlarmEventEntity)

    /** Every event awaiting delivery, oldest first (id is monotonic). */
    @Query("SELECT * FROM alarm_events ORDER BY id ASC")
    suspend fun getPendingEvents(): List<AlarmEventEntity>

    /** Distinct alarm ids with an undelivered outbox event — SYNC's "don't cancel yet" set (AF2). */
    @Query("SELECT DISTINCT alarmId FROM alarm_events")
    suspend fun getPendingEventAlarmIds(): List<String>

    /** Remove an event once the server has acknowledged it. */
    @Query("DELETE FROM alarm_events WHERE id = :id")
    suspend fun deleteEvent(id: Long)

    // --- Atomic state-write + outbox-event writes (AF6) ---
    // Each transition and its outbox event must commit together: a process kill between the two
    // separate statements would lose the transition event, defeating the outbox's whole purpose.
    // These @Transaction default methods bundle both writes (mirroring upsertPreservingIdentity's
    // proven pattern). The WorkManager drain request stays in AlarmRepository, outside the txn.

    /** Apply a state transition and append its event atomically. Returns rows changed (0 if gone). */
    @Transaction
    suspend fun updateStateWithEvent(
        alarmId: String,
        state: AlarmState,
        updatedAtMillis: Long,
        event: AlarmEventEntity,
    ): Int {
        val changed = updateState(alarmId, state, updatedAtMillis)
        if (changed > 0) insertEvent(event)
        return changed
    }

    /** Upsert an ARMED alarm (preserving identity) and append its ARMED event atomically. */
    @Transaction
    suspend fun upsertArmedWithEvent(entity: AlarmEntity, event: AlarmEventEntity): AlarmEntity {
        val resolved = upsertPreservingIdentity(entity)
        insertEvent(event)
        return resolved
    }

    /**
     * Re-arm a snooze atomically, preserving fix #2's SNOOZED-before-ARMED event ordering: record
     * SNOOZED, overwrite the row as ARMED, record ARMED — all in one transaction so a kill can
     * neither drop the snooze event nor leave a half-applied re-arm.
     */
    @Transaction
    suspend fun snoozeWithEvents(
        updated: AlarmEntity,
        snoozedEvent: AlarmEventEntity,
        armedEvent: AlarmEventEntity,
    ) {
        insertEvent(snoozedEvent)
        upsert(updated)
        insertEvent(armedEvent)
    }

    /** Dismiss a still-RANG alarm and append its DISMISSED event atomically (AF1 guard + AF6). */
    @Transaction
    suspend fun dismissIfRingingWithEvent(
        alarmId: String,
        updatedAtMillis: Long,
        event: AlarmEventEntity,
    ): Int {
        val changed = dismissIfRinging(alarmId, updatedAtMillis)
        if (changed > 0) insertEvent(event)
        return changed
    }
}
