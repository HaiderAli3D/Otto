package com.otto.app.permissions

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reads the current permission state and builds the Intents needed to grant each one. Below
 * the API level where a permission exists, its check returns true so the UI never offers an
 * inert grant button.
 */
@Singleton
class PermissionsManager @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    fun currentState(): PermissionState = PermissionState(
        notificationsGranted = notificationsGranted(),
        exactAlarmGranted = exactAlarmGranted(),
        fullScreenIntentGranted = fullScreenIntentGranted(),
        batteryExemptionGranted = batteryExemptionGranted(),
    )

    fun notificationsGranted(): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun exactAlarmGranted(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
    }

    fun fullScreenIntentGranted(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        return context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
    }

    fun batteryExemptionGranted(): Boolean =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    /** POST_NOTIFICATIONS is a runtime permission requested with a dialog only on API 33+. */
    fun shouldRequestNotificationsRuntime(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notificationsGranted()

    fun appNotificationSettingsIntent(): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

    fun exactAlarmSettingsIntent(): Intent =
        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, packageUri())

    fun fullScreenIntentSettingsIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, packageUri())

    @SuppressLint("BatteryLife") // sideloaded alarm app; the exemption is a legitimate need
    fun batteryExemptionIntent(): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri())

    private fun packageUri(): Uri = Uri.fromParts("package", context.packageName, null)

    companion object {
        const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
    }
}
