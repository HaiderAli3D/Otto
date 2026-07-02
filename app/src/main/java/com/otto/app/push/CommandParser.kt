package com.otto.app.push

/**
 * Parses the FCM `data` map (all values are strings) into an [FcmCommand] (spec.md §7).
 * Pure and Android-free so every branch is unit-testable.
 *
 * Rules: unknown fields are ignored; unknown `type`s are dropped (not errors). The integrity
 * `sig` is not handled here — [HmacVerifier] checks it at the FCM boundary (OttoFcmService),
 * so this stays a pure, signature-agnostic parser.
 */
object CommandParser {

    const val SUPPORTED_VERSION = "1"
    private const val DEFAULT_LABEL = "Alarm"

    fun parse(data: Map<String, String>): ParseResult {
        // An absent `v` stays accepted (back-compat with early payloads); an explicit mismatch is
        // a future-schema message this build can't be trusted to interpret, so drop it.
        val version = data["v"]
        if (version != null && version != SUPPORTED_VERSION) {
            return ParseResult.Ignored("unsupported version $version (supported: $SUPPORTED_VERSION)")
        }

        val type = data["type"]?.takeIf { it.isNotBlank() }
            ?: return ParseResult.Invalid("missing type")

        return when (type) {
            "ARM_ALARM" -> parseArm(data)
            "CANCEL_ALARM" -> parseCancel(data)
            "SYNC" -> ParseResult.Parsed(FcmCommand.Sync)
            "PING" -> ParseResult.Parsed(FcmCommand.Ping)
            else -> ParseResult.Ignored("unknown type $type")
        }
    }

    private fun parseArm(data: Map<String, String>): ParseResult {
        val alarmId = data["alarmId"]?.takeIf { it.isNotBlank() }
            ?: return ParseResult.Invalid("ARM_ALARM missing alarmId")
        val triggerAtMillis = data["triggerAtMillis"]?.toLongOrNull()
            ?: return ParseResult.Invalid("ARM_ALARM missing or non-numeric triggerAtMillis")
        val label = data["label"]?.takeIf { it.isNotBlank() } ?: DEFAULT_LABEL
        val allowWhileIdle = data["allowWhileIdle"]?.toBooleanStrictOrNull() ?: true

        return ParseResult.Parsed(
            FcmCommand.ArmAlarm(
                alarmId = alarmId,
                triggerAtMillis = triggerAtMillis,
                label = label,
                allowWhileIdle = allowWhileIdle,
            ),
        )
    }

    private fun parseCancel(data: Map<String, String>): ParseResult {
        val alarmId = data["alarmId"]?.takeIf { it.isNotBlank() }
            ?: return ParseResult.Invalid("CANCEL_ALARM missing alarmId")
        return ParseResult.Parsed(FcmCommand.CancelAlarm(alarmId))
    }
}
