package com.otto.app.nudge

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.otto.app.R
import com.otto.app.core.OttoConstants
import com.otto.app.data.NudgeEntity
import com.otto.app.ring.NotificationChannels
import com.otto.app.ui.MainActivity
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Builds and posts nudge notifications, and the persistent "N things open" summary.
 *
 * Everything here is a notification and nothing here is an alarm: no full-screen intent, no looping
 * audio, no ongoing lock on the ring notification's terms. The owner can swipe any of it away.
 */
@Singleton
class NudgeNotifications @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    /**
     * Show or replace a nudge.
     *
     * Posting on the same notification id REPLACES in place, which is the property that makes a
     * chase ladder usable — rung six updates one line rather than stacking six notifications the
     * owner has to clear individually. `setOnlyAlertOnce` stops each replacement buzzing again for
     * something they have already seen — but it was hardcoded to true, which also silenced every
     * rung that said something NEW. `reAlert` is the caller's answer to that, from
     * `NudgeTiming.shouldReAlert`.
     */
    @SuppressLint("MissingPermission")
    fun show(nudge: NudgeEntity, reAlert: Boolean = false) {
        NotificationChannels.ensureCreated(context)
        val level = NudgeLevel.fromToken(nudge.level)
        val actions = NudgeAction.parseCsv(nudge.actionsCsv)
        val notificationId = OttoConstants.NUDGE_NOTIFICATION_ID_BASE + nudge.notificationId

        val builder = NotificationCompat.Builder(context, channelIdFor(level))
            .setSmallIcon(R.drawable.ic_stat_alarm)
            .setContentTitle(nudge.title)
            .setContentText(nudge.body)
            // Long bodies are the normal case for a chase, and a truncated one reads as a bug.
            .setStyle(NotificationCompat.BigTextStyle().bigText(nudge.body))
            // CATEGORY_REMINDER, not CATEGORY_ALARM. It is what lets the owner allow nudges through
            // Do Not Disturb from Android's own Priority settings without granting this app policy
            // access — and it is honest about what the notification is.
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(priorityFor(level))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // `!reAlert`, not a hardcoded true. Replacing a notification that is still showing is
            // silent under `setOnlyAlertOnce`, and every rung of a chase replaces the same id — so
            // this suppressed the sound for every escalation after the first. See
            // `NudgeTiming.shouldReAlert`, which decides; this only applies.
            .setOnlyAlertOnce(!reAlert)
            .setAutoCancel(false)
            .setOngoing(nudge.ongoing)
            .setWhen(nudge.postedAtMillis)
            .setShowWhen(true)
            .setContentIntent(openIntent(nudge))
            .setDeleteIntent(actionIntent(nudge, NudgeAction.LATER, ACTION_NUDGE_DISMISSED))

        // Self-cancels rather than lingering past its usefulness. Mirrors the server's own refusal
        // to fire a nudge whose moment has passed.
        nudge.expiresAtMillis?.let { builder.setTimeoutAfter(it - System.currentTimeMillis()) }

        for (action in actions) builder.addAction(0, actionLabel(action, nudge.snoozeMinutes), actionPendingIntent(nudge, action))

        NotificationManagerCompat.from(context).notify(notificationId, builder.build())
    }

    fun cancel(nudge: NudgeEntity) {
        NotificationManagerCompat.from(context).cancel(OttoConstants.NUDGE_NOTIFICATION_ID_BASE + nudge.notificationId)
    }

    /**
     * The ambient "N things open" line.
     *
     * The cheapest pressure in the whole system and the one the owner actually asked for: always
     * there, never makes a sound, and doubles as the indicator that the push channel is alive at
     * all. Rebuilt from Room after every state change and on boot, so it can never disagree with
     * what is stored.
     *
     * Deliberately NOT `setGroupSummary` — group members must share a channel and nudges span
     * three, so a real group summary is not expressible here.
     */
    @SuppressLint("MissingPermission")
    fun showSummary(live: List<NudgeEntity>) {
        if (live.isEmpty()) {
            NotificationManagerCompat.from(context).cancel(OttoConstants.NUDGE_SUMMARY_NOTIFICATION_ID)
            return
        }
        NotificationChannels.ensureCreated(context)
        val title = context.resources.getQuantityString(R.plurals.nudge_summary_title, live.size, live.size)
        val style = NotificationCompat.InboxStyle().setBigContentTitle(title)
        for (nudge in live.take(SUMMARY_LINES)) style.addLine(nudge.title)

        val notification = NotificationCompat.Builder(context, OttoConstants.NUDGE_STATUS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_alarm)
            .setContentTitle(title)
            .setContentText(live.first().title)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(
                PendingIntent.getActivity(
                    context,
                    OttoConstants.NUDGE_SUMMARY_NOTIFICATION_ID,
                    Intent(context, MainActivity::class.java),
                    PI_FLAGS,
                ),
            )
            .build()

        NotificationManagerCompat.from(context).notify(OttoConstants.NUDGE_SUMMARY_NOTIFICATION_ID, notification)
    }

    private fun priorityFor(level: NudgeLevel): Int = when (level) {
        NudgeLevel.SILENT -> NotificationCompat.PRIORITY_LOW
        NudgeLevel.NORMAL -> NotificationCompat.PRIORITY_DEFAULT
        NudgeLevel.URGENT -> NotificationCompat.PRIORITY_HIGH
    }

    private fun actionLabel(action: NudgeAction, snoozeMinutes: Int): String = when (action) {
        NudgeAction.DONE -> context.getString(R.string.nudge_action_done)
        NudgeAction.SNOOZE ->
            if (snoozeMinutes >= 60) context.getString(R.string.nudge_action_snooze_hours, snoozeMinutes / 60)
            else context.getString(R.string.nudge_action_snooze, snoozeMinutes)
        NudgeAction.LATER -> context.getString(R.string.nudge_action_later)
        NudgeAction.OPEN -> context.getString(R.string.nudge_action_open)
    }

    private fun actionPendingIntent(nudge: NudgeEntity, action: NudgeAction): PendingIntent = when (action) {
        // The one action that legitimately needs an unlock. Everything else must resolve from the
        // lockscreen, which is why the rest are broadcasts.
        NudgeAction.OPEN -> openIntent(nudge)
        NudgeAction.DONE -> actionIntent(nudge, action, ACTION_NUDGE_DONE)
        NudgeAction.SNOOZE -> actionIntent(nudge, action, ACTION_NUDGE_SNOOZE)
        NudgeAction.LATER -> actionIntent(nudge, action, ACTION_NUDGE_LATER)
    }

    /**
     * A broadcast back to [NudgeActionReceiver].
     *
     * Two independent defences against `PendingIntent` collision, both needed. Equality ignores
     * extras, so DONE and SNOOZE for the same nudge would collapse into one intent on the strength
     * of the extras alone: hence a distinct [Intent] action per button, which DOES participate in
     * `filterEquals`. And a request code band disjoint from the alarm path's, so a nudge can never
     * overwrite an alarm's registration even if one of them changes how it allocates.
     */
    private fun actionIntent(nudge: NudgeEntity, action: NudgeAction, intentAction: String): PendingIntent {
        val intent = Intent(context, NudgeActionReceiver::class.java).apply {
            this.action = intentAction
            putExtra(OttoConstants.EXTRA_NUDGE_ID, nudge.nudgeId)
            putExtra(OttoConstants.EXTRA_NUDGE_NOTIFICATION_ID, nudge.notificationId)
        }
        return PendingIntent.getBroadcast(context, requestCodeFor(nudge.notificationId, action), intent, PI_FLAGS)
    }

    private fun openIntent(nudge: NudgeEntity): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            putExtra(OttoConstants.EXTRA_NUDGE_ID, nudge.nudgeId)
        }
        return PendingIntent.getActivity(context, requestCodeFor(nudge.notificationId, NudgeAction.OPEN), intent, PI_FLAGS)
    }

    companion object {
        const val ACTION_NUDGE_DONE = "com.otto.app.action.NUDGE_DONE"
        const val ACTION_NUDGE_SNOOZE = "com.otto.app.action.NUDGE_SNOOZE"
        const val ACTION_NUDGE_LATER = "com.otto.app.action.NUDGE_LATER"
        const val ACTION_NUDGE_DISMISSED = "com.otto.app.action.NUDGE_DISMISSED"

        private const val SUMMARY_LINES = 3
        private val PI_FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

        /**
         * Injective while there are fewer than [OttoConstants.NUDGE_PI_STRIDE] actions, which the
         * platform's own three-action limit guarantees.
         */
        fun requestCodeFor(notificationId: Int, action: NudgeAction): Int =
            OttoConstants.NUDGE_PI_BASE + notificationId * OttoConstants.NUDGE_PI_STRIDE + action.ordinal
    }
}
