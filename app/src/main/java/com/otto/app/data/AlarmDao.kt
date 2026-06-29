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

    /** ARMED alarms still in the future — used to re-arm after reboot. */
    @Query("SELECT * FROM alarms WHERE state = :state AND triggerAtMillis > :nowMillis ORDER BY triggerAtMillis ASC")
    suspend fun getByStateAfter(state: AlarmState, nowMillis: Long): List<AlarmEntity>

    @Query("UPDATE alarms SET state = :state, updatedAtMillis = :updatedAtMillis, reportedToServer = 0 WHERE alarmId = :alarmId")
    suspend fun updateState(alarmId: String, state: AlarmState, updatedAtMillis: Long): Int

    @Query("DELETE FROM alarms WHERE alarmId = :alarmId")
    suspend fun deleteById(alarmId: String)
}
