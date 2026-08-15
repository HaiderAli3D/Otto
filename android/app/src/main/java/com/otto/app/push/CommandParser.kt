package com.otto.app.push

import com.otto.app.core.OttoConstants
import com.otto.app.nudge.NudgeAction
import com.otto.app.nudge.NudgeLevel

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
            "NUDGE" -> parseNudge(data)
            "CANCEL_NUDGE" -> parseCancelNudge(data)
            "REQUEST_LOCATION" -> parseRequestLocation(data)
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

    /**
     * A nudge: notification text plus how loudly to show it and what buttons it carries.
     *
     * Only `nudgeId`, `title` and `body` are required. Everything else degrades to a sensible
     * default rather than rejecting the payload, because a nudge that arrives slightly wrong is
     * strictly better than one that does not arrive — the server has already decided the owner
     * should hear about this.
     *
     * Title and body are clamped here as well as truncated server-side. The server truncates before
     * signing so the payload stays under FCM's 4KB cap; this second clamp is what stops a server
     * bug becoming a `RemoteServiceException` from an oversize notification on the owner's phone.
     */
    private fun parseNudge(data: Map<String, String>): ParseResult {
        val nudgeId = data["nudgeId"]?.takeIf { it.isNotBlank() }
            ?: return ParseResult.Invalid("NUDGE missing nudgeId")
        val title = data["title"]?.takeIf { it.isNotBlank() }
            ?: return ParseResult.Invalid("NUDGE missing title")
        val body = data["body"]?.takeIf { it.isNotBlank() }
            ?: return ParseResult.Invalid("NUDGE missing body")

        return ParseResult.Parsed(
            FcmCommand.Nudge(
                nudgeId = nudgeId,
                title = title.take(OttoConstants.MAX_NUDGE_TITLE_CHARS),
                body = body.take(OttoConstants.MAX_NUDGE_BODY_CHARS),
                level = NudgeLevel.fromToken(data["level"]),
                actions = NudgeAction.parseCsv(data["actions"]),
                snoozeMinutes = data["snoozeMinutes"]?.toIntOrNull() ?: OttoConstants.DEFAULT_SNOOZE_MINUTES,
                expiresAtMillis = data["expiresAtMillis"]?.toLongOrNull(),
                ongoing = data["ongoing"]?.toBooleanStrictOrNull() ?: false,
            ),
        )
    }

    private fun parseCancelNudge(data: Map<String, String>): ParseResult {
        val nudgeId = data["nudgeId"]?.takeIf { it.isNotBlank() }
            ?: return ParseResult.Invalid("CANCEL_NUDGE missing nudgeId")
        return ParseResult.Parsed(FcmCommand.CancelNudge(nudgeId))
    }

    /**
     * Where are you, right now.
     *
     * Stricter than [parseNudge] on purpose, and the asymmetry is deliberate rather than
     * inconsistent: a nudge missing a field is still worth showing, while a location report the
     * server cannot match to its own question is worth nothing at all. So a missing `requestId` is
     * Invalid — which goes back as a PUSH/REJECTED device event rather than vanishing.
     *
     * `maxAgeSeconds` is CLAMPED rather than trusted. The server asking for a six-hour-old fix would
     * be indistinguishable, on the wire, from a current one, and "current location" would quietly
     * stop meaning anything.
     */
    private fun parseRequestLocation(data: Map<String, String>): ParseResult {
        val requestId = data["requestId"]?.takeIf { it.isNotBlank() }
            ?: return ParseResult.Invalid("REQUEST_LOCATION missing requestId")
        val maxAgeMillis = data["maxAgeSeconds"]?.toLongOrNull()
            ?.coerceIn(0L, OttoConstants.MAX_LOCATION_AGE_SECONDS)
            ?.times(1_000L)
            ?: OttoConstants.DEFAULT_LOCATION_MAX_AGE_MILLIS

        return ParseResult.Parsed(
            FcmCommand.RequestLocation(
                requestId = requestId,
                maxAgeMillis = maxAgeMillis,
                expiresAtMillis = data["expiresAtMillis"]?.toLongOrNull(),
                highAccuracy = data["highAccuracy"]?.toBooleanStrictOrNull() ?: false,
                reason = data["reason"]?.takeIf { it.isNotBlank() }?.take(OttoConstants.MAX_LOCATION_REASON_CHARS),
            ),
        )
    }
}
