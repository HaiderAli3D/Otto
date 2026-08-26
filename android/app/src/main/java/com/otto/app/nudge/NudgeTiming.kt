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
     * Should a replacement notification make a sound, or update the line in silence?
     *
     * Every rung of a chase re-posts onto the SAME notification id — that is what makes a ladder
     * usable, rung six updating one line instead of stacking six the owner has to clear. But
     * Android suppresses sound and vibration for an update to a notification that is still showing,
     * and `setOnlyAlertOnce(true)` was hardcoded, so it suppressed them for EVERY rung after the
     * first. Otto escalates six or seven times through a day and the phone buzzed once, at the
     * earliest and least urgent rung, while the server logged seven successful deliveries.
     *
     * `setTimeoutAfter` is refreshed from the server's six-hour nudge TTL on every rung and the
     * widest gap in `trigger x hard` is four hours, so the previous notification is always still
     * showing. There is no case where this resolved itself.
     *
     * Re-alert when the words CHANGED or the level went up, and not otherwise. A rung that says
     * something new is worth a buzz; a boot restore re-posting a body the owner has already read is
     * not, and neither is the summary being refreshed underneath them.
     *
     * Pure and Android-free for the reason the rest of this object is: `NudgeNotifications` touches
     * `NotificationCompat` and cannot be tested on the JVM at all, so the DECISION lives here where
     * it can be, and that class stays a dumb applier of the boolean.
     */
    fun shouldReAlert(previousBody: String?, previousLevel: String?, body: String, level: String): Boolean {
        if (previousBody == null) return true
        if (previousBody != body) return true
        return NudgeLevel.fromToken(level).ordinal > NudgeLevel.fromToken(previousLevel ?: level).ordinal
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
