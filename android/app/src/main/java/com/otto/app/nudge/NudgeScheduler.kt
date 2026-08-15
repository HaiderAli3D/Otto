package com.otto.app.nudge

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.otto.app.core.OttoConstants
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Re-shows a snoozed nudge locally.
 *
 * A deliberately separate interface from `AlarmScheduler`, with its own receiver, its own intent
 * action and its own request-code band. **Never widen `AlarmScheduler` to cover this.** That
 * interface is the alarm path's contract and giving it a second caller with different needs is the
 * most likely way to regress the one thing this app must never get wrong.
 *
 * The separation also makes cross-cancellation impossible rather than merely unlikely: cancelling
 * rebuilds a PendingIntent targeting a specific component and action, so an alarm's cancel can
 * never match a nudge's registration and vice versa.
 *
 * This does not violate the spec's "the app never decides *when*". The phone re-shows a nudge the
 * server already sent, after a delay the server itself specified in `snoozeMinutes`. That is
 * executing an instruction, not deciding one — there is no local ladder, no local escalation, and
 * no local policy of any kind.
 */
interface NudgeScheduler {
    fun schedule(notificationId: Int, showAtMillis: Long)
    fun cancel(notificationId: Int)
}

@Singleton
class NudgeSchedulerImpl @Inject constructor(
    @ApplicationContext private val context: Context,
) : NudgeScheduler {

    private val alarmManager = context.getSystemService(AlarmManager::class.java)

    /**
     * `setAndAllowWhileIdle`, and specifically not the two alternatives.
     *
     * Not `setAlarmClock`: it puts the system alarm icon in the status bar, which would have the
     * phone claiming a nudge is an alarm, and it hard-wakes the device out of Doze for something
     * that does not need it.
     *
     * Not `setExactAndAllowWhileIdle`: the app holds `USE_EXACT_ALARM` so it would work, but a
     * thirty-minute snooze does not need second accuracy, and spending the exact-alarm budget on
     * nudges risks the OS throttling the thing that actually matters.
     *
     * The documented cost is that deep Doze may batch this up to roughly fifteen minutes late.
     * That is acceptable for a nudge and must not be "fixed" by reaching for exact alarms.
     *
     * It also needs no exact-alarm permission at all, so a device where `canScheduleExactAlarms()`
     * is denied still gets its nudges — the one place the nudge path is more robust than the alarm
     * path rather than less.
     */
    override fun schedule(notificationId: Int, showAtMillis: Long) {
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, showAtMillis, pendingIntent(notificationId))
    }

    override fun cancel(notificationId: Int) {
        alarmManager.cancel(pendingIntent(notificationId))
    }

    private fun pendingIntent(notificationId: Int): PendingIntent {
        val intent = Intent(context, NudgeAlarmReceiver::class.java).apply {
            action = ACTION_NUDGE_SHOW
            putExtra(OttoConstants.EXTRA_NUDGE_NOTIFICATION_ID, notificationId)
        }
        return PendingIntent.getBroadcast(
            context,
            OttoConstants.NUDGE_PI_BASE + notificationId * OttoConstants.NUDGE_PI_STRIDE + SHOW_SLOT,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    companion object {
        const val ACTION_NUDGE_SHOW = "com.otto.app.action.NUDGE_SHOW"

        /**
         * The re-show slot inside this nudge's request-code band.
         *
         * Deliberately the last slot in the stride rather than an action ordinal, so it can never
         * collide with a button: [NudgeAction] has four entries and the stride is eight.
         */
        private const val SHOW_SLOT = OttoConstants.NUDGE_PI_STRIDE - 1
    }
}
