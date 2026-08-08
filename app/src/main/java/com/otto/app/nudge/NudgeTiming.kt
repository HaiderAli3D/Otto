package com.otto.app.nudge

/**
 * Pure timing decisions for a nudge, deliberately Android-free so every branch is unit-testable.
 *
 * The sibling of [com.otto.app.alarm.AlarmTiming], and kept separate for the same reason the whole
 * `nudge/` package is: the alarm path's timing rules are safety-critical and must not grow a second
 * caller with different needs.
 */
object NudgeTiming {

    /** What to do with a nudge row that is not in a terminal state. */
    enum class ShowDecision {
        /** Post it now — it is due and has not expired. */
        SHOW_NOW,

        /** Its re-show time is still ahead; register a local alarm for it. */
        SCHEDULE,

        /** Its expiry passed while nobody was looking. Mark it and tell the server. */
        EXPIRED,
    }

    /**
     * Decide what a stored nudge should do right now.
     *
     * Expiry is checked FIRST and against `expiresAtMillis` alone. A nudge that came back from a
     * reboot four hours after its window closed is noise, and posting it would be the phone-side
     * twin of the stale-nudge backlog the server refuses to fire on boot: the worst failure mode of
     * a queue is delivering all of it at once when the machine comes back.
     */
    fun classify(showAtMillis: Long, expiresAtMillis: Long?, nowMillis: Long): ShowDecision = when {
        expiresAtMillis != null && expiresAtMillis <= nowMillis -> ShowDecision.EXPIRED
        showAtMillis <= nowMillis -> ShowDecision.SHOW_NOW
        else -> ShowDecision.SCHEDULE
    }

    /**
     * When a snooze should bring a nudge back.
     *
     * Clamped rather than trusted: `snoozeMinutes` arrives from the server as a string in an FCM
     * payload, and a zero would re-post the notification in the same instant the owner dismissed it
     * — a loop they cannot break from the lockscreen.
     */
    fun snoozeUntil(nowMillis: Long, snoozeMinutes: Int): Long =
        nowMillis + snoozeMinutes.coerceIn(MIN_SNOOZE_MINUTES, MAX_SNOOZE_MINUTES) * 60_000L

    const val MIN_SNOOZE_MINUTES = 1
    const val MAX_SNOOZE_MINUTES = 24 * 60
}
