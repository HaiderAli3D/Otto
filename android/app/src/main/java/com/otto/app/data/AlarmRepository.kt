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
        // State write + ARMED outbox event commit atomically (AF6); the drain request is fired
        // afterwards because it's WorkManager, not a DB write, and must stay out of the txn.
        val entity = dao.upsertArmedWithEvent(
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
            eventFor(alarmId, AlarmState.ARMED, now),
        )
        reportTrigger.requestReport()
        return entity
    }

    /** Transition an alarm to a new state and append the matching outbox event (atomically, AF6). */
    suspend fun markState(alarmId: String, state: AlarmState): Boolean {
        val now = clock.nowMillis()
        val changed = dao.updateStateWithEvent(alarmId, state, now, eventFor(alarmId, state, now)) > 0
        if (changed) reportTrigger.requestReport()
        return changed
    }

    /**
     * Dismiss [alarmId] only while it is still RANG (AF1): the state write and DISMISSED outbox
     * event commit atomically (AF6). Returns whether it changed — false means the alarm was
     * re-armed/cancelled out from under a stale ring screen, so the dismiss is correctly ignored.
     */
    suspend fun markDismissedIfRinging(alarmId: String): Boolean {
        val now = clock.nowMillis()
        val changed = dao.dismissIfRingingWithEvent(
            alarmId, now, eventFor(alarmId, AlarmState.DISMISSED, now),
        ) > 0
        if (changed) reportTrigger.requestReport()
        return changed
    }

    /** All ARMED alarms regardless of time (used at boot to also detect missed ones). */
    suspend fun getAllArmed(): List<AlarmEntity> = dao.getByState(AlarmState.ARMED)

    /** Every alarm regardless of state — the local picture SYNC reconciles against (AF2). */
    suspend fun getAll(): List<AlarmEntity> = dao.getAll()

    /** Alarm ids with an undelivered outbox event — SYNC must not cancel these yet (AF2). */
    suspend fun getPendingEventAlarmIds(): Set<String> = dao.getPendingEventAlarmIds().toSet()

    /** Alarms currently ringing (RANG) — used to cycle through simultaneous alarms. */
    suspend fun getRinging(): List<AlarmEntity> = dao.getByState(AlarmState.RANG)

    /** The next ARMED alarm still in the future, or null (quick-settings tile). */
    suspend fun getNextAlarm(): AlarmEntity? =
        dao.getNextInState(AlarmState.ARMED, clock.nowMillis())

    /**
     * Re-arm [alarmId] at [newTriggerAtMillis]. Emits a SNOOZED event first (so the server can
     * tell a snooze from a fresh arm, fix #2), then re-ARMs, incrementing snoozeCount and
     * preserving requestCode. Returns the updated entity, or null if the alarm no longer exists
     * OR is no longer RANG — a snooze may only come from a live ring, so an alarm the agent has
     * meanwhile cancelled, dismissed, or re-armed to the future must not be resurrected (AF1).
     */
    suspend fun snooze(alarmId: String, newTriggerAtMillis: Long): AlarmEntity? {
        val existing = dao.getById(alarmId) ?: return null
        if (existing.state != AlarmState.RANG) return null
        val now = clock.nowMillis()
        val updated = existing.copy(
            triggerAtMillis = newTriggerAtMillis,
            state = AlarmState.ARMED,
            snoozeCount = existing.snoozeCount + 1,
            updatedAtMillis = now,
            reportedToServer = false,
        )
        // SNOOZED must be recorded before the re-ARM write, else the current-state row would be
        // ARMED and the snooze would never reach the server. Both events share `now` but differ
        // by `event`, so the server's (alarmId, event, atMillis) dedupe keeps both. All three
        // writes are one transaction (AF6) so a kill can't drop the snooze or half-apply the re-arm.
        dao.snoozeWithEvents(
            updated = updated,
            snoozedEvent = eventFor(alarmId, AlarmState.SNOOZED, now),
            armedEvent = eventFor(alarmId, AlarmState.ARMED, now),
        )
        reportTrigger.requestReport()
        return updated
    }

    /** Events awaiting delivery to the server, oldest first (drained by ReportWorker). */
    suspend fun getPendingEvents(): List<AlarmEventEntity> = dao.getPendingEvents()

    /** Remove an outbox event once the server has acknowledged it. */
    suspend fun markEventReported(id: Long) = dao.deleteEvent(id)

    suspend fun delete(alarmId: String) = dao.deleteById(alarmId)

    /**
     * Tell the server the OS refused to schedule an alarm we have already reported as ARMED.
     *
     * A plain event append, deliberately outside any state transaction. The row IS armed in Room —
     * that is true, and boot recovery will retry it once the grant returns — so `markState` would be
     * wrong. What is not true is the ARMED event that `upsertArmedWithEvent` has already written and
     * queued: the server reads that as the delivery ack that cancels its arm-ack watchdog, so
     * without this second event an alarm the OS refused looks, from the server, exactly like one
     * that is set. Both events drain in order, so the server sees ARMED then NOT_REGISTERED.
     *
     * `event` is a free-text column, so this costs no Room migration and no schema version.
     */
    suspend fun reportNotRegistered(alarmId: String) {
        dao.insertEvent(AlarmEventEntity(alarmId = alarmId, event = EVENT_NOT_REGISTERED, atMillis = clock.nowMillis()))
        reportTrigger.requestReport()
    }

    /** Build the outbox event for a transition (inserted inside the state-write transaction, AF6). */
    private fun eventFor(alarmId: String, state: AlarmState, atMillis: Long) =
        AlarmEventEntity(alarmId = alarmId, event = state.name, atMillis = atMillis)

    companion object {
        /** Not an [AlarmState]: a registration outcome, reported alongside one. */
        const val EVENT_NOT_REGISTERED = "NOT_REGISTERED"
    }
}
