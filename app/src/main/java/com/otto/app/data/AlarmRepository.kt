package com.otto.app.data

import com.otto.app.core.Clock
import com.otto.app.core.ReportTrigger
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The single gateway to alarm persistence. Stamps timestamps from the injected [Clock] so
 * callers never touch the system clock directly, and — since it is the one choke point for
 * every state write — appends an outbox event after each change (fix #2) so no transition is
 * missed. Draining the outbox is delegated to an injected [ReportTrigger] (keeps this class
 * free of WorkManager and unit-testable).
 */
@Singleton
class AlarmRepository @Inject constructor(
    private val dao: AlarmDao,
    private val clock: Clock,
    private val reportTrigger: ReportTrigger,
) {
    fun observeAlarms(): Flow<List<AlarmEntity>> = dao.observeAll()

    suspend fun getById(alarmId: String): AlarmEntity? = dao.getById(alarmId)

    /**
     * Insert or replace an ARMED alarm. Idempotent on [alarmId]: re-arming an existing id
     * updates its time/label and preserves createdAt/snoozeCount/requestCode, never duplicating.
     * The lookup-and-assign happens inside one DAO transaction so concurrent first-time arms
     * can never be handed the same requestCode (fix #4's collision-free promise).
     */
    suspend fun upsertArmed(
        alarmId: String,
        triggerAtMillis: Long,
        label: String,
        allowWhileIdle: Boolean,
    ): AlarmEntity {
        val now = clock.nowMillis()
        val entity = dao.upsertPreservingIdentity(
            AlarmEntity(
                alarmId = alarmId,
                triggerAtMillis = triggerAtMillis,
                label = label,
                state = AlarmState.ARMED,
                allowWhileIdle = allowWhileIdle,
                snoozeCount = 0,
                createdAtMillis = now,
                updatedAtMillis = now,
                reportedToServer = false,
            ),
        )
        recordEvent(alarmId, AlarmState.ARMED, now)
        return entity
    }

    /** Transition an alarm to a new state and append the matching outbox event. */
    suspend fun markState(alarmId: String, state: AlarmState): Boolean {
        val now = clock.nowMillis()
        val changed = dao.updateState(alarmId, state, now) > 0
        if (changed) recordEvent(alarmId, state, now)
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
     * Re-arm [alarmId] at [newTriggerAtMillis]. Emits a SNOOZED event first (so the server can
     * tell a snooze from a fresh arm, fix #2), then re-ARMs, incrementing snoozeCount and
     * preserving requestCode. Returns the updated entity, or null if the alarm no longer exists.
     */
    suspend fun snooze(alarmId: String, newTriggerAtMillis: Long): AlarmEntity? {
        val existing = dao.getById(alarmId) ?: return null
        val now = clock.nowMillis()
        // SNOOZED must be recorded before the re-ARM write, else the current-state row would be
        // ARMED and the snooze would never reach the server. Both events share `now` but differ
        // by `event`, so the server's (alarmId, event, atMillis) dedupe keeps both.
        recordEvent(alarmId, AlarmState.SNOOZED, now)
        val updated = existing.copy(
            triggerAtMillis = newTriggerAtMillis,
            state = AlarmState.ARMED,
            snoozeCount = existing.snoozeCount + 1,
            updatedAtMillis = now,
            reportedToServer = false,
        )
        dao.upsert(updated)
        recordEvent(alarmId, AlarmState.ARMED, now)
        return updated
    }

    /** Events awaiting delivery to the server, oldest first (drained by ReportWorker). */
    suspend fun getPendingEvents(): List<AlarmEventEntity> = dao.getPendingEvents()

    /** Remove an outbox event once the server has acknowledged it. */
    suspend fun markEventReported(id: Long) = dao.deleteEvent(id)

    suspend fun delete(alarmId: String) = dao.deleteById(alarmId)

    /** Append an outbox event for a transition and ask for a drain. */
    private suspend fun recordEvent(alarmId: String, state: AlarmState, atMillis: Long) {
        dao.insertEvent(AlarmEventEntity(alarmId = alarmId, event = state.name, atMillis = atMillis))
        reportTrigger.requestReport()
    }
}
