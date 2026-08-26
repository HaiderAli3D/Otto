package com.otto.app.nudge

import com.otto.app.core.Clock
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.DeviceEvents
import com.otto.app.data.NudgeEntity
import com.otto.app.data.NudgeRepository
import com.otto.app.data.NudgeState
import com.otto.app.push.FcmCommand
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The single funnel for every nudge path — an incoming push, a lockscreen button, a local re-show,
 * boot recovery, the in-app list. Mirrors [com.otto.app.alarm.AlarmController] so both surfaces
 * have one place where behaviour and idempotency are decided.
 *
 * Room is the source of truth here as it is for alarms: the posted notification and the local
 * re-show registration are both derived state, rebuildable from the table after a reboot or a
 * force-stop.
 */
@Singleton
class NudgeController @Inject constructor(
    private val repository: NudgeRepository,
    private val notifications: NudgeNotifications,
    private val scheduler: NudgeScheduler,
    private val clock: Clock,
) {

    /** Show (or replace) a pushed nudge. Idempotent on the nudge id. */
    suspend fun show(command: FcmCommand.Nudge) {
        // An expired nudge is dropped on arrival rather than shown and immediately withdrawn. This
        // is the phone-side twin of the server refusing to fire a stale rung: a push delayed by a
        // long offline gap is noise, and the worst failure mode of a queue is delivering all of it
        // at once when the machine comes back.
        val expiry = command.expiresAtMillis
        if (expiry != null && expiry <= clock.nowMillis()) {
            OttoLog.i("Dropping nudge ${command.nudgeId}; it expired before it arrived")
            return
        }

        val entity = repository.show(
            nudgeId = command.nudgeId,
            title = command.title,
            body = command.body,
            level = command.level,
            actions = command.actions,
            snoozeMinutes = command.snoozeMinutes,
            expiresAtMillis = expiry,
            ongoing = command.ongoing,
        )
        // Any earlier re-show for this nudge is now stale — the server has said something newer.
        scheduler.cancel(entity.notificationId)
        notifications.show(entity)
        refreshSummary()
        OttoLog.i("Showed nudge ${entity.nudgeId} at ${command.level}")
    }

    /** The server withdrew a nudge — the reminder was completed or cancelled somewhere else. */
    suspend fun cancel(nudgeId: String) {
        val existing = repository.getById(nudgeId) ?: return
        // Reported as WITHDRAWN, not DISMISSED. The comment here used to say no event was written
        // at all, which was never true — `resolve` always writes one — and writing the same event a
        // swipe writes made a withdrawal Otto asked for indistinguishable from the owner clearing
        // it. The server reads that column to decide whether the owner is awake, so mid-ladder the
        // wake-check stood down on its own doing.
        repository.resolve(nudgeId, NudgeState.CANCELLED, DeviceEvents.NUDGE_WITHDRAWN)
        clearFromScreen(existing)
        OttoLog.i("Cancelled nudge $nudgeId")
    }

    /**
     * Act on a button the owner pressed, from the lockscreen or from the app.
     *
     * Everything routes through the repository's live-only guard, so a stale notification cannot
     * resurrect a nudge the server has already withdrawn.
     */
    suspend fun act(nudgeId: String, action: NudgeAction) {
        val existing = repository.getById(nudgeId)
        if (existing == null) {
            OttoLog.w("Action $action on unknown nudge $nudgeId")
            return
        }
        when (action) {
            NudgeAction.DONE -> {
                repository.resolve(nudgeId, NudgeState.RESOLVED, DeviceEvents.NUDGE_DONE)
                clearFromScreen(existing)
            }
            NudgeAction.SNOOZE -> {
                val showAt = NudgeTiming.snoozeUntil(clock.nowMillis(), existing.snoozeMinutes)
                if (repository.snooze(nudgeId, showAt)) {
                    notifications.cancel(existing)
                    scheduler.schedule(existing.notificationId, showAt)
                }
                refreshSummary()
            }
            // No local re-show: the owner said not today, and what happens next is the server's
            // ladder to decide. Documented cost — offline, this is a no-op until the server pushes
            // again.
            NudgeAction.LATER -> {
                repository.resolve(nudgeId, NudgeState.DEFERRED, DeviceEvents.NUDGE_DEFERRED)
                clearFromScreen(existing)
            }
            NudgeAction.OPEN -> repository.resolve(nudgeId, NudgeState.ACTIVE, DeviceEvents.NUDGE_OPENED)
        }
        OttoLog.i("Nudge $nudgeId -> $action")
    }

    /** The owner swiped it away without acting. Worth reporting: seen-and-ignored is a real signal. */
    suspend fun dismissed(nudgeId: String) {
        val existing = repository.getById(nudgeId) ?: return
        repository.resolve(nudgeId, NudgeState.DEFERRED, DeviceEvents.NUDGE_DISMISSED)
        scheduler.cancel(existing.notificationId)
        refreshSummary()
    }

    /** A snoozed nudge's moment came round. Re-post it if it is still worth posting. */
    suspend fun reshow(notificationId: Int) {
        val nudge = repository.getLive().firstOrNull { it.notificationId == notificationId }
        if (nudge == null) {
            OttoLog.i("Re-show for notification $notificationId found nothing live; it was resolved first")
            return
        }
        applyDecision(nudge)
        refreshSummary()
    }

    /**
     * Rebuild everything after a reboot or a force-stop.
     *
     * A boot wipes every posted notification and every pending `AlarmManager` registration, so
     * without this Otto goes silent at exactly the moment it should be loudest — the same class of
     * failure `BootReceiver` already exists to fix for alarms.
     */
    suspend fun restoreAll() {
        val live = repository.getLive()
        for (nudge in live) {
            try {
                applyDecision(nudge)
            } catch (t: Throwable) {
                OttoLog.e("Failed to restore nudge ${nudge.nudgeId}; continuing with the rest", t)
            }
        }
        repository.sweepTerminal(TERMINAL_RETENTION_MILLIS)
        refreshSummary()
        OttoLog.i("Restored ${live.size} nudge(s)")
    }

    /** Rebuild the ambient summary from Room, so it can never disagree with what is stored. */
    suspend fun refreshSummary() {
        notifications.showSummary(repository.getActive())
    }

    private suspend fun applyDecision(nudge: NudgeEntity) {
        when (NudgeTiming.classify(nudge.showAtMillis, nudge.expiresAtMillis, clock.nowMillis())) {
            NudgeTiming.ShowDecision.SHOW_NOW -> {
                // Back to ACTIVE: a snoozed nudge being re-shown is on screen again, and the
                // summary counts what is on screen.
                repository.resolve(nudge.nudgeId, NudgeState.ACTIVE, DeviceEvents.NUDGE_SHOWN)
                notifications.show(nudge)
            }
            NudgeTiming.ShowDecision.SCHEDULE -> scheduler.schedule(nudge.notificationId, nudge.showAtMillis)
            NudgeTiming.ShowDecision.EXPIRED -> {
                repository.resolve(nudge.nudgeId, NudgeState.EXPIRED, DeviceEvents.NUDGE_EXPIRED)
                clearFromScreen(nudge)
            }
        }
    }

    private suspend fun clearFromScreen(nudge: NudgeEntity) {
        notifications.cancel(nudge)
        scheduler.cancel(nudge.notificationId)
        refreshSummary()
    }

    companion object {
        /** How long a finished nudge is kept before the sweep drops it. */
        val TERMINAL_RETENTION_MILLIS = 7L * 24 * 60 * 60 * 1000

        /** Re-exported so callers do not reach into OttoConstants for one id. */
        const val SUMMARY_NOTIFICATION_ID = OttoConstants.NUDGE_SUMMARY_NOTIFICATION_ID
    }
}
