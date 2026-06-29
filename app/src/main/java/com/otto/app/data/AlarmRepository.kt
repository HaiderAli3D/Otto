package com.otto.app.data

import com.otto.app.core.Clock
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The single gateway to alarm persistence. Stamps timestamps from the injected [Clock] so
 * callers never touch the system clock directly.
 */
@Singleton
class AlarmRepository @Inject constructor(
    private val dao: AlarmDao,
    private val clock: Clock,
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
        return entity
    }

    /** Transition an alarm to a new state (re-flags it as needing a server report). */
    suspend fun markState(alarmId: String, state: AlarmState): Boolean =
        dao.updateState(alarmId, state, clock.nowMillis()) > 0

    /** All ARMED alarms whose trigger time is still in the future. */
    suspend fun getArmedFutureAlarms(): List<AlarmEntity> =
        dao.getByStateAfter(AlarmState.ARMED, clock.nowMillis())

    /** All ARMED alarms regardless of time (used at boot to also detect missed ones). */
    suspend fun getAllArmed(): List<AlarmEntity> = dao.getByState(AlarmState.ARMED)

    suspend fun delete(alarmId: String) = dao.deleteById(alarmId)
}
