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

    /**
     * Recovery decision: whether a stored ARMED alarm should be re-registered with the OS
     * (`true`) or recorded MISSED (`false`) after a reboot, time change, or force-stop restart.
     * Uses the exact same grace window as [classify]/`arm()` so a within-grace trigger that
     * elapsed while the phone was off still fires immediately instead of being dropped.
     */
    fun shouldReArm(
        triggerAtMillis: Long,
        nowMillis: Long,
        graceWindowMillis: Long = OttoConstants.DEFAULT_GRACE_WINDOW_MILLIS,
    ): Boolean = classify(triggerAtMillis, nowMillis, graceWindowMillis) != FireDecision.MISSED

    /**
     * Whether an alarm still marked RANG is old enough to be a candidate for stuck-ring cleanup.
     * True once its trigger is older than [thresholdMillis]. This is only a time guard against a
     * just-started ring; the authoritative "is it actually stuck?" check is process liveness
     * (`RingService.isActive()`) at the [AlarmController.reArmAll] call site, since a genuine ring
     * has no upper time bound.
     */
    fun isStuckRinging(
        triggerAtMillis: Long,
        nowMillis: Long,
        thresholdMillis: Long = OttoConstants.STUCK_RANG_THRESHOLD_MILLIS,
    ): Boolean = nowMillis - triggerAtMillis > thresholdMillis
}
