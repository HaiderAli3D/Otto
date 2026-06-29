package com.otto.app.permissions

/**
 * Snapshot of every permission/exemption the alarm path depends on. The first three are
 * critical (a missing one breaks ringing); the battery exemption is strongly recommended for
 * reliable FCM delivery in Doze but not strictly required to ring a locally-armed alarm.
 */
data class PermissionState(
    val notificationsGranted: Boolean,
    val exactAlarmGranted: Boolean,
    val fullScreenIntentGranted: Boolean,
    val batteryExemptionGranted: Boolean,
) {
    val allCriticalGranted: Boolean
        get() = notificationsGranted && exactAlarmGranted && fullScreenIntentGranted

    companion object {
        val UNKNOWN = PermissionState(
            notificationsGranted = false,
            exactAlarmGranted = false,
            fullScreenIntentGranted = false,
            batteryExemptionGranted = false,
        )
    }
}
