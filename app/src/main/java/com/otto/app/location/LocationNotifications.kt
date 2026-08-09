package com.otto.app.location

import android.app.Notification
import android.content.Context
import androidx.core.app.NotificationCompat
import com.otto.app.R
import com.otto.app.core.OttoConstants
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The notice the owner sees every single time Otto looks.
 *
 * This is the difference between a feature and a surveillance bug, and it is not merely a foreground
 * service's obligation being met — it is the design. The phone tells the owner ON THE PHONE, at the
 * moment it happens, carrying the server's own `reason` so the notice says what it was FOR:
 * "Otto checked your location, to work out when to leave for the dentist."
 *
 * On `otto_quiet` (LOW, silent but visible) because it must never interrupt, and must never be
 * missable either. Deliberately NOT on a nudge channel: a nudge is something to act on.
 */
@Singleton
class LocationNotifications @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    fun building(reason: String?): Notification =
        NotificationCompat.Builder(context, OttoConstants.NUDGE_QUIET_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_alarm)
            .setContentTitle(context.getString(R.string.location_notice_title))
            .setContentText(
                reason?.takeIf { it.isNotBlank() }?.let { context.getString(R.string.location_notice_reason, it) }
                    ?: context.getString(R.string.location_notice_generic),
            )
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setShowWhen(true)
            // PUBLIC so it is legible on a locked screen. There is nothing private in it — it says
            // that Otto looked, never where the owner is.
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
}
