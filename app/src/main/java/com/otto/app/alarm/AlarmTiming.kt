package com.otto.app.alarm

import com.otto.app.core.OttoConstants

/** What to do with an alarm given its trigger time relative to now. */
enum class FireDecision {
    /** Trigger is in the future — register it with the OS. */
    ARM,

    /** Trigger is at/just past now (within the grace window) — ring immediately. */
    FIRE_NOW,

    /** Trigger is older than the grace window — record MISSED instead of ringing late. */
    MISSED,
}

/**
 * Pure decision for how to handle an alarm's trigger time (spec.md §7.3). Kept free of any
 * Android dependency so it is trivially unit-testable against a fixed "now".
 */
object AlarmTiming {
    fun classify(
        triggerAtMillis: Long,
        nowMillis: Long,
        graceWindowMillis: Long = OttoConstants.DEFAULT_GRACE_WINDOW_MILLIS,
    ): FireDecision = when {
        triggerAtMillis > nowMillis -> FireDecision.ARM
        nowMillis - triggerAtMillis <= graceWindowMillis -> FireDecision.FIRE_NOW
        else -> FireDecision.MISSED
    }
}
