package com.otto.app.alarm

/**
 * Maps an alarmId to the stable integer codes used for its alarm PendingIntent and its
 * ringing notification.
 *
 * PendingIntent equality ignores extras and matches on request code + Intent
 * (action/component/data), so a *stable* request code derived from the alarmId is exactly
 * what makes re-arming the same alarm replace its registration instead of duplicating it.
 * Distinct alarmIds must therefore map to distinct codes — [String.hashCode] is
 * deterministic across runs and collision-safe enough for a single-user device.
 */
object AlarmRequestCodes {
    fun forAlarm(alarmId: String): Int = alarmId.hashCode()
    fun notificationId(alarmId: String): Int = alarmId.hashCode()
}
