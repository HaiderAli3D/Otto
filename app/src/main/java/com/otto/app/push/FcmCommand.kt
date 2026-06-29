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
