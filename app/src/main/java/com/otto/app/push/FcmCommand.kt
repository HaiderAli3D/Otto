package com.otto.app.push

/** A command the app knows how to execute, parsed from an FCM data payload. */
sealed interface FcmCommand {
    data class ArmAlarm(
        val alarmId: String,
        val triggerAtMillis: Long,
        val label: String,
        val allowWhileIdle: Boolean,
    ) : FcmCommand

    data class CancelAlarm(val alarmId: String) : FcmCommand

    /**
     * Show a text nudge — a notification, never an alarm.
     *
     * [nudgeId] is the server's own reminder id, and that identity is what makes a chase ladder
     * usable: rung 2 pushes the same id with new [body] and the phone UPDATES one notification in
     * place instead of stacking eight. It is also what lets a lockscreen "Done" map straight onto
     * the reminder it belongs to with no id translation on either side.
     *
     * There is deliberately no `showAtMillis`. A NUDGE means "show this now" — the server already
     * owns scheduling, and a second scheduler here would be a second place a reminder goes missing.
     */
    data class Nudge(
        val nudgeId: String,
        val title: String,
        val body: String,
        val level: com.otto.app.nudge.NudgeLevel,
        val actions: List<com.otto.app.nudge.NudgeAction>,
        val snoozeMinutes: Int,
        val expiresAtMillis: Long?,
        val ongoing: Boolean,
    ) : FcmCommand

    /** Clear a nudge — the reminder was completed or cancelled somewhere else. */
    data class CancelNudge(val nudgeId: String) : FcmCommand

    /**
     * Take one fresh fix and post it back.
     *
     * Not tracking, and the shape of this type is the argument. It carries a [requestId] because the
     * phone answers exactly ONCE per question, and there is deliberately no `intervalMillis`, no
     * `untilMillis` and no stop-tracking counterpart: there is nothing here to leave running.
     *
     * [requestId] is required rather than defaulted, unlike every optional field on a nudge. A nudge
     * missing a field is still worth showing; an answer the server cannot match to its own question
     * is not a degraded answer, it is no answer — and two overlapping requests would be
     * indistinguishable on the wire.
     */
    data class RequestLocation(
        val requestId: String,
        val maxAgeMillis: Long,
        /** After this instant a fix is worthless; report EXPIRED rather than answer late. */
        val expiresAtMillis: Long?,
        val highAccuracy: Boolean,
        /**
         * Why, in the owner's terms: "to work out when to leave for the dentist".
         *
         * It earns its place because the foreground service must post a notification anyway, and
         * this one string is the difference between the feature being transparent and feeling
         * covert. The phone tells the owner on the phone, at the moment it happens.
         */
        val reason: String?,
    ) : FcmCommand

    /** Reconcile local alarms against the server's authoritative set. */
    data object Sync : FcmCommand

    /** Liveness heartbeat request. */
    data object Ping : FcmCommand
}

/** Outcome of parsing an FCM data payload. */
sealed interface ParseResult {
    /** A recognised, well-formed command to execute. */
    data class Parsed(val command: FcmCommand) : ParseResult

    /** A recognised-but-not-actioned payload (unknown type, or an M2 type). Safe to drop. */
    data class Ignored(val reason: String) : ParseResult

    /** A payload of a known type that is malformed. Worth a warning. */
    data class Invalid(val reason: String) : ParseResult
}
