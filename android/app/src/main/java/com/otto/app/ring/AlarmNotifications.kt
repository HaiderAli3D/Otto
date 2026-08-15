package com.otto.app.ring

import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.otto.app.R
import com.otto.app.core.OttoConstants
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Builds and posts the ringing notification whose full-screen intent launches
 * [RingActivity]. This is the OS-sanctioned way to bring up a screen from the background:
 * when the device is locked/off the system launches the Activity directly; when it is in
 * use the notification appears as a heads-up that taps through to the same Activity.
 *
 * From M4 the same notification doubles as [RingService]'s foreground notification, so the
 * ring outlives the Activity.
 */
@Singleton
class AlarmNotifications @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    /** Build the full-screen ring notification for an alarm (used to post and to go foreground). */
    fun buildRinging(alarmId: String, label: String, requestCode: Int): Notification {
        NotificationChannels.ensureCreated(context)

        val intent = Intent(context, RingActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            putExtra(OttoConstants.EXTRA_ALARM_ID, alarmId)
            putExtra(RingActivity.EXTRA_LABEL, label)
            putExtra(OttoConstants.EXTRA_REQUEST_CODE, requestCode)
        }
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val pendingIntent = PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            flags,
        )

        return NotificationCompat.Builder(context, OttoConstants.ALARM_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_alarm)
            .setContentTitle(context.getString(R.string.ring_notification_title))
            .setContentText(label)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(pendingIntent, true)
            .setContentIntent(pendingIntent)
            .build()
    }

    // POST_NOTIFICATIONS is surfaced and requested in the permissions panel; if it is not
    // granted, notify() is a safe no-op. Suppress the lint check rather than guard here.
    @SuppressLint("MissingPermission")
    fun postRinging(alarmId: String, label: String, requestCode: Int) {
        NotificationManagerCompat.from(context)
            .notify(requestCode, buildRinging(alarmId, label, requestCode))
    }

    fun cancel(requestCode: Int) {
        NotificationManagerCompat.from(context).cancel(requestCode)
    }
}
