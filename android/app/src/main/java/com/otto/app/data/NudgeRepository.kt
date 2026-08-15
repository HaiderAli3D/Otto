package com.otto.app.data

import com.otto.app.core.Clock
import com.otto.app.core.ReportTrigger
import com.otto.app.nudge.NudgeAction
import com.otto.app.nudge.NudgeLevel
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Room access for nudges and the device-event outbox.
 *
 * Deliberately free of WorkManager and of Android beyond Room, exactly like [AlarmRepository]: the
 * drain is requested through the [ReportTrigger] seam so this class stays JVM-testable with a
 * hand-written DAO fake.
 *
 * Every state change writes its outbox event inside the same transaction. That is not tidiness —
 * a process killed between the two writes would leave the owner having pressed "Done" and the
 * server never learning, which is precisely the failure the outbox exists to prevent.
 */
@Singleton
class NudgeRepository @Inject constructor(
    private val dao: NudgeDao,
    private val clock: Clock,
    private val reportTrigger: ReportTrigger,
) {
    suspend fun getById(nudgeId: String): NudgeEntity? = dao.getById(nudgeId)

    suspend fun getLive(): List<NudgeEntity> = dao.getLive()

    suspend fun getActive(): List<NudgeEntity> = dao.getActive()

    fun observeLive(): Flow<List<NudgeEntity>> = dao.observeLive()

    /**
     * Record a pushed nudge, replacing any earlier one with the same id.
     *
     * Replacing rather than appending is the whole reason the server sends its own reminder id: a
     * six-rung chase updates one row and one notification instead of leaving six for the owner to
     * clear individually.
     */
    suspend fun show(
        nudgeId: String,
        title: String,
        body: String,
        level: NudgeLevel,
        actions: List<NudgeAction>,
        snoozeMinutes: Int,
        expiresAtMillis: Long?,
        ongoing: Boolean,
    ): NudgeEntity {
        val now = clock.nowMillis()
        val entity = NudgeEntity(
            nudgeId = nudgeId,
            title = title,
            body = body,
            level = level.name,
            actionsCsv = actions.joinToString(",") { it.name },
            snoozeMinutes = snoozeMinutes,
            state = NudgeState.ACTIVE,
            postedAtMillis = now,
            showAtMillis = now,
            expiresAtMillis = expiresAtMillis,
            ongoing = ongoing,
            // Replaced inside the transaction by the existing row's id when there is one.
            notificationId = 0,
            createdAtMillis = now,
            updatedAtMillis = now,
        )
        val resolved = dao.showPreservingIdentity(entity, event(nudgeId, DeviceEvents.NUDGE_SHOWN, now))
        reportTrigger.requestReport()
        return resolved
    }

    /**
     * Move a live nudge to a terminal or deferred state, recording why.
     *
     * Returns false when the nudge was already finished with — a "Done" tapped on a notification
     * the server cancelled minutes ago must not resurrect it, and the lockscreen is exactly where
     * a stale notification lives longest. Nothing is written in that case, not even an event.
     */
    suspend fun resolve(nudgeId: String, state: NudgeState, event: String): Boolean {
        val now = clock.nowMillis()
        val changed = dao.updateStateWithEvent(nudgeId, state, now, event(nudgeId, event, now))
        if (changed > 0) reportTrigger.requestReport()
        return changed > 0
    }

    /** Push a nudge back to [showAtMillis], recording when the owner asked to see it again. */
    suspend fun snooze(nudgeId: String, showAtMillis: Long): Boolean {
        val now = clock.nowMillis()
        val changed = dao.snoozeWithEvent(
            nudgeId,
            showAtMillis,
            now,
            event(nudgeId, DeviceEvents.NUDGE_SNOOZED, now, untilMillis = showAtMillis),
        )
        if (changed > 0) reportTrigger.requestReport()
        return changed > 0
    }

    /**
     * Record that a push could not be acted on.
     *
     * Rate-limited structurally by the unique index on the hourly dedupe key rather than by a timer
     * — a server sending a malformed type in a loop produces one row an hour however many arrive,
     * with no state of its own to reset on process death.
     */
    suspend fun recordPushRejection(type: String, reason: String) {
        val now = clock.nowMillis()
        dao.insertEvent(
            DeviceEventEntity(
                kind = DeviceEvents.KIND_PUSH,
                refId = type,
                event = DeviceEvents.PUSH_REJECTED,
                atMillis = now,
                detail = reason,
                dedupeKey = DeviceEvents.pushRejectionKey(type, now),
            ),
        )
        reportTrigger.requestReport()
    }

    suspend fun getPendingEvents(): List<DeviceEventEntity> = dao.getPendingEvents()

    suspend fun markEventReported(id: Long) = dao.deleteEvent(id)

    /** Housekeeping on app open — terminal rows past the cutoff are of no further use to anyone. */
    suspend fun sweepTerminal(retainMillis: Long) {
        dao.deleteTerminalBefore(clock.nowMillis() - retainMillis)
    }

    private fun event(nudgeId: String, event: String, atMillis: Long, untilMillis: Long? = null) =
        DeviceEventEntity(
            kind = DeviceEvents.KIND_NUDGE,
            refId = nudgeId,
            event = event,
            atMillis = atMillis,
            untilMillis = untilMillis,
            dedupeKey = DeviceEvents.nudgeKey(nudgeId, event, atMillis),
        )
}
