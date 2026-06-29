package com.otto.app.ring

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import com.otto.app.R
import com.otto.app.core.OttoConstants

/**
 * Creates the high-importance alarm channel. The channel is kept SILENT — [SimpleRinger]
 * plays the looping alarm stream itself, so the channel sound must not also fire.
 */
object NotificationChannels {

    fun ensureCreated(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(OttoConstants.ALARM_CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            OttoConstants.ALARM_CHANNEL_ID,
            context.getString(R.string.alarm_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.alarm_channel_description)
            setSound(null, null)
            enableVibration(false)
            setBypassDnd(true)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }
}
