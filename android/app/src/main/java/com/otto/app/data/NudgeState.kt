package com.otto.app.data

/**
 * What has become of a nudge on this device.
 *
 * Deliberately NOT [AlarmState]. An alarm's states are device-reported facts about a ring; these
 * are about a notification the owner may act on from a lockscreen. Sharing one enum would put
 * `RANG` and `DONE` in the same vocabulary and make "swiped the ring away" indistinguishable from
 * "did the thing" — the exact conflation the server's reminders table exists to avoid.
 *
 * The invariant that matters is [isTerminal]: a stale action tapped on a notification the server
 * has already cancelled must not resurrect it.
 */
enum class NudgeState {
    /** On screen now. */
    ACTIVE,

    /** Cleared for now, with a local re-show scheduled. */
    SNOOZED,

    /** The owner said it is done. */
    RESOLVED,

    /** The owner said not today; the next move is the server's. */
    DEFERRED,

    /** The server withdrew it — the reminder was completed or cancelled elsewhere. */
    CANCELLED,

    /** Its window closed before anyone saw it. */
    EXPIRED,
    ;

    val isTerminal: Boolean
        get() = this == RESOLVED || this == CANCELLED || this == EXPIRED
}
