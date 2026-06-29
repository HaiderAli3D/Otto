package com.otto.app.alarm

import com.otto.app.data.AlarmEntity

/**
 * Registers and cancels real device alarms. This is the OS-facing, "derived state" half of
 * the system — it never touches Room. Arming is idempotent per alarmId.
 */
interface AlarmScheduler {
    /** Register (or replace) an exact alarm-clock alarm for [alarm]. */
    fun arm(alarm: AlarmEntity)

    /** Cancel any registered alarm for [alarmId]. No-op if none exists. */
    fun cancel(alarmId: String)

    /** Whether the OS currently allows scheduling exact alarms. */
    fun canScheduleExact(): Boolean
}
