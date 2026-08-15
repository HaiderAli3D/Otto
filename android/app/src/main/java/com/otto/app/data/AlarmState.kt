package com.otto.app.data

/**
 * Lifecycle of an alarm. See spec.md §6.2.
 *
 * DISMISSED, CANCELLED, and MISSED are terminal; they are kept until their outcome is
 * reported to the server (M2), then may be pruned.
 */
enum class AlarmState {
    ARMED,
    RANG,
    DISMISSED,
    SNOOZED,
    CANCELLED,
    MISSED;

    val isTerminal: Boolean
        get() = this == DISMISSED || this == CANCELLED || this == MISSED
}
