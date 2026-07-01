package com.otto.app.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
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

    @Query("DELETE FROM alarms WHERE alarmId = :alarmId")
    suspend fun deleteById(alarmId: String)

    /** Next stable, collision-free PendingIntent request code (fix #4). */
    @Query("SELECT COALESCE(MAX(requestCode), 0) + 1 FROM alarms")
    suspend fun nextRequestCode(): Int

    // --- Event outbox: append-only, drained then deleted by ReportWorker (fix #2) ---

    @Insert
    suspend fun insertEvent(event: AlarmEventEntity)

    /** Every event awaiting delivery, oldest first (id is monotonic). */
    @Query("SELECT * FROM alarm_events ORDER BY id ASC")
    suspend fun getPendingEvents(): List<AlarmEventEntity>

    /** Remove an event once the server has acknowledged it. */
    @Query("DELETE FROM alarm_events WHERE id = :id")
    suspend fun deleteEvent(id: Long)
}
