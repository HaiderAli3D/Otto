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
    /**
     * Location, and deliberately OUTSIDE [allCriticalGranted].
     *
     * Every existing feature works with these denied: alarms ring, nudges arrive, sync reconciles.
     * Only "when should I leave" gets worse, and it degrades to planning from home rather than
     * failing. Treating location as critical would put a red warning on the control screen about a
     * capability the owner is entitled to refuse.
     *
     * TWO fields rather than one because the server has to tell "won't" from "can't". Foreground-only
     * is a real and common state — it is what the first grant dialog gives you — and it cannot answer
     * a push, so the phone reports BACKGROUND_DENIED and Otto says something different about it.
     */
    val locationGranted: Boolean = false,
    val backgroundLocationGranted: Boolean = false,
) {
    val allCriticalGranted: Boolean
        get() = notificationsGranted && exactAlarmGranted && fullScreenIntentGranted

    /** Granted the first half and not the second: the state that looks fine and answers nothing. */
    val locationForegroundOnly: Boolean
        get() = locationGranted && !backgroundLocationGranted

    companion object {
        val UNKNOWN = PermissionState(
            notificationsGranted = false,
            exactAlarmGranted = false,
            fullScreenIntentGranted = false,
            batteryExemptionGranted = false,
            locationGranted = false,
            backgroundLocationGranted = false,
        )
    }
}
