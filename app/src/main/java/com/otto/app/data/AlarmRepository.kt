package com.otto.app.data

import android.content.Context
import com.otto.app.core.Clock
import com.otto.app.net.ReportWorker
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The single gateway to alarm persistence. Stamps timestamps from the injected [Clock] so
 * callers never touch the system clock directly, and — since it is the one choke point for
 * every state write — schedules a server report after each change so no transition is missed.
 */
@Singleton
class AlarmRepository @Inject constructor(
    private val dao: AlarmDao,
    private val clock: Clock,
    @ApplicationContext private val context: Context,
) {
    fun observeAlarms(): Flow<List<AlarmEntity>> = dao.observeAll()

    suspend fun getById(alarmId: String): AlarmEntity? = dao.getById(alarmId)

    /**
     * Insert or replace an ARMED alarm. Idempotent on [alarmId]: re-arming an existing id
     * updates its time/label and preserves createdAt/snoozeCount, never duplicating.
     */
    suspend fun upsertArmed(
        alarmId: String,
        triggerAtMillis: Long,
        label: String,
        allowWhileIdle: Boolean,
    ): AlarmEntity {
        val now = clock.nowMillis()
        val existing = dao.getById(alarmId)
        val entity = AlarmEntity(
            alarmId = alarmId,
            triggerAtMillis = triggerAtMillis,
            label = label,
            state = AlarmState.ARMED,
            allowWhileIdle = allowWhileIdle,
            snoozeCount = existing?.snoozeCount ?: 0,
            createdAtMillis = existing?.createdAtMillis ?: now,
            updatedAtMillis = now,
            reportedToServer = false,
        )
        dao.upsert(entity)
        ReportWorker.enqueue(context)
        return entity
    }

    /** Transition an alarm to a new state (re-flags it as needing a server report). */
    suspend fun markState(alarmId: String, state: AlarmState): Boolean {
        val changed = dao.updateState(alarmId, state, clock.nowMillis()) > 0
        if (changed) ReportWorker.enqueue(context)
        return changed
    }

    /** All ARMED alarms regardless of time (used at boot to also detect missed ones). */
    suspend fun getAllArmed(): List<AlarmEntity> = dao.getByState(AlarmState.ARMED)

    /** Alarms currently ringing (RANG) — used to cycle through simultaneous alarms. */
    suspend fun getRinging(): List<AlarmEntity> = dao.getByState(AlarmState.RANG)

    /** The next ARMED alarm still in the future, or null (quick-settings tile). */
    suspend fun getNextAlarm(): AlarmEntity? =
        dao.getNextInState(AlarmState.ARMED, clock.nowMillis())

    /**
     * Re-arm [alarmId] at [newTriggerAtMillis], incrementing snoozeCount and clearing the
     * report flag. Returns the updated entity, or null if the alarm no longer exists.
     */
    suspend fun snooze(alarmId: String, newTriggerAtMillis: Long): AlarmEntity? {
        val existing = dao.getById(alarmId) ?: return null
        val updated = existing.copy(
            triggerAtMillis = newTriggerAtMillis,
            state = AlarmState.ARMED,
            snoozeCount = existing.snoozeCount + 1,
            updatedAtMillis = clock.nowMillis(),
            reportedToServer = false,
        )
        dao.upsert(updated)
        ReportWorker.enqueue(context)
        return updated
    }

    /** Alarms whose latest state change still needs to reach the server. */
    suspend fun getUnreported(): List<AlarmEntity> = dao.getUnreported()

    /** Mark [alarm] reported iff it hasn't transitioned since it was read (see DAO). */
    suspend fun markReported(alarm: AlarmEntity): Boolean =
        dao.markReported(alarm.alarmId, alarm.updatedAtMillis) > 0

    suspend fun delete(alarmId: String) = dao.deleteById(alarmId)
}
