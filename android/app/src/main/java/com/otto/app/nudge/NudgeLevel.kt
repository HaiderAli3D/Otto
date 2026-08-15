package com.otto.app.nudge

import com.otto.app.core.OttoConstants

/**
 * Which notification channel a nudge level posts on.
 *
 * A pure, exhaustive `when` over the three nudge levels, and kept out of the notification builder
 * so it can be asserted from a plain JVM test. The property worth pinning is a negative one: no
 * level, present or future, may return [OttoConstants.ALARM_CHANNEL_ID]. A chase that reached the
 * alarm channel would ring at full volume, bypass Do Not Disturb and take the lockscreen — and the
 * owner's response would be to mute the one channel that has to survive.
 *
 * Exhaustive rather than defaulted on purpose: adding a fourth level should not compile until
 * someone has decided where it goes.
 */
fun channelIdFor(level: NudgeLevel): String = when (level) {
    NudgeLevel.SILENT -> OttoConstants.NUDGE_QUIET_CHANNEL_ID
    NudgeLevel.NORMAL -> OttoConstants.NUDGE_CHANNEL_ID
    NudgeLevel.URGENT -> OttoConstants.NUDGE_URGENT_CHANNEL_ID
}

/**
 * How loudly a nudge arrives. Chosen by the server, per push.
 *
 * This is the dial the app did not have. Before nudges the only surface was a full alarm — max
 * volume, screen on, lockscreen taken — so "chase me more" and "wake me up" were the same request.
 * Three levels of *notification* is what makes the server's ladder deliverable without every rung
 * being an emergency.
 *
 * Deliberately does NOT reach the alarm channel at any level. An alarm arrives as `ARM_ALARM` and
 * nothing else; see [channelIdFor], which is an exhaustive `when` over these three for exactly that
 * reason.
 */
enum class NudgeLevel {
    /** Lands in the shade with no sound and no peek. Confirmations, FYIs, low rungs of a ladder. */
    SILENT,

    /** Makes a sound and lands in the shade, but does not take over the screen. The everyday rung. */
    NORMAL,

    /** Heads-up over whatever is on screen, with sound and vibration. Still not an alarm. */
    URGENT,
    ;

    companion object {
        /**
         * Read a level off the wire, degrading rather than dropping.
         *
         * An unrecognised token — a `CRITICAL` from a server newer than this build — becomes
         * [NORMAL] and the nudge still arrives. Dropping it would make a schema drift invisible on
         * both sides: the server would log a successful send and the owner would get nothing.
         */
        fun fromToken(token: String?): NudgeLevel =
            entries.firstOrNull { it.name.equals(token?.trim(), ignoreCase = true) } ?: NORMAL
    }
}
