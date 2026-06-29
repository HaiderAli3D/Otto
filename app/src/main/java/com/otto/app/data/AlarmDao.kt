package com.otto.app.data

import androidx.room.Dao
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

    /** Alarms whose latest state change hasn't reached the server yet. */
    @Query("SELECT * FROM alarms WHERE reportedToServer = 0 ORDER BY updatedAtMillis ASC")
    suspend fun getUnreported(): List<AlarmEntity>

    /**
     * Mark an alarm reported, but only if it hasn't transitioned since we read it
     * (the updatedAtMillis guard). If it changed, 0 rows update and the newer state stays
     * unreported for the next drain — so a fast RANG→DISMISSED never loses the RANG report.
     */
    @Query("UPDATE alarms SET reportedToServer = 1 WHERE alarmId = :alarmId AND updatedAtMillis = :updatedAtMillis")
    suspend fun markReported(alarmId: String, updatedAtMillis: Long): Int

    @Query("UPDATE alarms SET state = :state, updatedAtMillis = :updatedAtMillis, reportedToServer = 0 WHERE alarmId = :alarmId")
    suspend fun updateState(alarmId: String, state: AlarmState, updatedAtMillis: Long): Int

    @Query("DELETE FROM alarms WHERE alarmId = :alarmId")
    suspend fun deleteById(alarmId: String)
}
