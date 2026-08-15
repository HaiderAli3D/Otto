package com.otto.app.ring

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.content.Context
import com.otto.app.R
import com.otto.app.core.OttoConstants

/**
 * Creates every notification channel the app posts on.
 *
 * The alarm channel is kept SILENT — [SimpleRinger] plays the looping alarm stream itself, so the
 * channel sound must not also fire. The four nudge channels are the graded surface that lets Otto
 * chase without every message being an emergency.
 *
 * Two platform facts shape all of this:
 *
 * 1. **Channel settings become the user's at creation.** `createNotificationChannel` updates only
 *    the name, description and group of a channel that already exists; importance, sound and
 *    vibration are ignored. So the call is safely idempotent, and so a channel that needs different
 *    behaviour needs a NEW id — the ids here are a one-shot decision.
 * 2. **`setBypassDnd(true)` is inert without policy access.** The app does not hold
 *    `ACCESS_NOTIFICATION_POLICY`, so that call on the alarm channel does nothing; alarms get
 *    through Do Not Disturb because they are `CATEGORY_ALARM` played on the alarm stream, and DND's
 *    Alarms category is on by default. The nudge tier is therefore built on `CATEGORY_REMINDER`,
 *    which the owner can allow through DND from the system's own Priority settings with no app
 *    permission at all. Nothing here should be designed as though bypass works.
 */
object NotificationChannels {

    /**
     * Create every channel, unconditionally, on every app start.
     *
     * The previous version returned early if the alarm channel already existed. That gate was
     * per-channel-id, so on an upgrade to a build that ADDS channels none of the new ones would
     * ever be created and every nudge would silently fail to post — the whole feature dead on
     * arrival for exactly the devices that already had the app. Creation is idempotent by the OS
     * contract above, so there is nothing to guard against.
     */
    fun ensureCreated(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)

        manager.createNotificationChannel(
            NotificationChannel(
                OttoConstants.ALARM_CHANNEL_ID,
                context.getString(R.string.alarm_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.alarm_channel_description)
                setSound(null, null)
                enableVibration(false)
                setBypassDnd(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )

        // Grouped so the settings screen separates "what Otto says" from "what wakes you up", and
        // the owner can find the one they want to turn down without turning off their alarms.
        manager.createNotificationChannelGroup(
            NotificationChannelGroup(
                OttoConstants.NUDGE_CHANNEL_GROUP_ID,
                context.getString(R.string.nudge_group_name),
            ),
        )

        manager.createNotificationChannel(
            nudgeChannel(
                context,
                OttoConstants.NUDGE_URGENT_CHANNEL_ID,
                R.string.nudge_urgent_channel_name,
                R.string.nudge_urgent_channel_description,
                NotificationManager.IMPORTANCE_HIGH,
                vibrate = true,
            ),
        )
        manager.createNotificationChannel(
            nudgeChannel(
                context,
                OttoConstants.NUDGE_CHANNEL_ID,
                R.string.nudge_channel_name,
                R.string.nudge_channel_description,
                NotificationManager.IMPORTANCE_DEFAULT,
                vibrate = true,
            ),
        )
        manager.createNotificationChannel(
            nudgeChannel(
                context,
                OttoConstants.NUDGE_QUIET_CHANNEL_ID,
                R.string.nudge_quiet_channel_name,
                R.string.nudge_quiet_channel_description,
                NotificationManager.IMPORTANCE_LOW,
                vibrate = false,
            ),
        )
        manager.createNotificationChannel(
            nudgeChannel(
                context,
                OttoConstants.NUDGE_STATUS_CHANNEL_ID,
                R.string.nudge_status_channel_name,
                R.string.nudge_status_channel_description,
                NotificationManager.IMPORTANCE_LOW,
                vibrate = false,
            ).apply {
                // The summary IS the count, so it must not also contribute to a launcher badge.
                setShowBadge(false)
            },
        )
    }

    /**
     * A nudge channel.
     *
     * `VISIBILITY_PUBLIC` on all of them is deliberate and load-bearing: `VISIBILITY_PRIVATE`
     * renders a redacted form on a secure lockscreen and **does not draw the action buttons**,
     * which would remove the whole point of the feature. If redaction is ever wanted the answer is
     * `setPublicVersion()` on the notification, not a channel change — channel visibility is
     * immutable once created.
     */
    private fun nudgeChannel(
        context: Context,
        id: String,
        nameRes: Int,
        descriptionRes: Int,
        importance: Int,
        vibrate: Boolean,
    ): NotificationChannel = NotificationChannel(id, context.getString(nameRes), importance).apply {
        description = context.getString(descriptionRes)
        group = OttoConstants.NUDGE_CHANNEL_GROUP_ID
        enableVibration(vibrate)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
}
